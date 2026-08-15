/**
 * Signature à distance par lien cloud — Approche A, Tranche 0 (backend).
 *
 * Trois routes :
 *   - POST /api/nodes/:id/sign-requests   (authentifié) crée une demande de
 *     signature : une `signature_requests` + une `signature_request_parties` +
 *     un `share_links` scellé `can_sign`. Renvoie le token du lien (que
 *     l'émetteur transmet hors bande, comme un lien de partage).
 *   - GET  /api/nodes/:id/sign-requests   (authentifié) tableau de suivi.
 *   - POST /api/links/:token/sign         (PUBLIC, scellé par token) écriture-
 *     retour anonyme de l'artefact SIGNÉ, stocké comme node_version. C'est la
 *     seule route de lien en écriture ; comme les GET de shares.ts elle n'installe
 *     PAS de hook `authenticate`.
 *
 * Zero-knowledge : le signataire re-chiffre l'artefact sous la CEK qu'il détient
 * déjà via le fragment d'URL (mécanisme du lien) ; le serveur ne voit que du
 * ciphertext. La preuve d'intégrité (sceau/preuve Ed25519 .elium) est INTERNE à
 * l'artefact — le stockage serveur n'est qu'un transport, comme pour l'Approche B.
 *
 * Tranche 0 = mono-partie, `.elium`, suivi par poll. L'ordre (circuit séquentiel),
 * le PDF/PAdES et le push live viennent dans les tranches suivantes.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Readable } from "node:stream";
import { z } from "zod";
import { query, queryOne, withTx } from "../db/pool.js";
import { authenticate, requireUser, requireNodePerm } from "../middleware/auth.js";
import { badRequest, notFound, conflict, tooLarge, insufficientStorage } from "../lib/errors.js";
import { sha256Hex, randomToken } from "../lib/crypto-server.js";
import { storage } from "../storage/adapter.js";
import { config } from "../config.js";
import { audit } from "../lib/audit.js";
import { notifyOrg } from "../collab/relay.js";

const hex = (v: string) => Buffer.from(v, "hex");
const envelope = z.record(z.unknown()); // recipients envelope (opaque)

interface PartyRow {
  party_id: string;
  party_index: number;
  label: string | null;
  party_status: string;
  signer_fpr: string | null;
  signed_at: string | null;
  submission_version_id: string | null;
  request_id: string;
  request_status: string;
  ordered: boolean;
  deadline: string | null;
  created_at: string;
  completed_at: string | null;
}

export default async function signingRoutes(app: FastifyInstance): Promise<void> {
  // =====================================================================
  //  Authentifié — créer une demande de signature (1..N parties)
  // =====================================================================
  const partySchema = z.object({
    label: z.string().max(200).optional(),
    // CEK enveloppée à la paire de lien PROPRE à cette partie (comme un lien externe).
    wrappedKey: envelope,
  });
  const createSchema = z.object({
    roleId: z.string().uuid(),
    // Signature séquentielle : la partie d'index i ne peut signer qu'après i-1.
    ordered: z.boolean().default(false),
    expiresAt: z.string().datetime().optional(),
    deadline: z.string().datetime().optional(),
    parties: z.array(partySchema).min(1).max(50),
  });
  app.post("/nodes/:id/sign-requests", { preHandler: authenticate }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = createSchema.parse(req.body);
    const user = requireUser(req);

    // Créer un lien de signature = créer un lien externe (capacité réutilisée ;
    // une permission dédiée node.sign.request pourra suivre).
    const access = await requireNodePerm(req, id, "node.share.link");
    if (access.kind !== "file") throw badRequest("Seuls les fichiers peuvent être envoyés en signature.");

    const role = await queryOne<{ id: string }>(
      `SELECT id FROM roles WHERE id = $1 AND (org_id = $2 OR org_id IS NULL)`,
      [b.roleId, access.orgId],
    );
    if (!role) throw badRequest("Rôle invalide pour cette organisation.");

    // Un token de lien par partie (chacune a sa propre paire de clés côté client).
    const tokens = b.parties.map(() => randomToken(32));

    const out = await withTx(async (c) => {
      const { rows: rq } = await c.query(
        `INSERT INTO signature_requests (org_id, node_id, created_by, ordered, deadline)
         VALUES ($1,$2,$3,$4,$5)
         RETURNING id`,
        [access.orgId, id, user.id, b.ordered, b.deadline ?? null],
      );
      const requestId = rq[0].id as string;

      const parties: Array<{ partyId: string; index: number; token: string }> = [];
      for (let i = 0; i < b.parties.length; i++) {
        const { rows: lk } = await c.query(
          `INSERT INTO share_links (node_id, token_hash, role_id, wrapped_key, has_password,
                                    expires_at, created_by, can_sign)
           VALUES ($1,$2,$3,$4,false,$5,$6,true)
           RETURNING id`,
          [id, sha256Hex(tokens[i]!), b.roleId, JSON.stringify(b.parties[i]!.wrappedKey), b.expiresAt ?? null, user.id],
        );
        const { rows: pt } = await c.query(
          `INSERT INTO signature_request_parties (request_id, party_index, label, link_id)
           VALUES ($1,$2,$3,$4)
           RETURNING id`,
          [requestId, i, b.parties[i]!.label ?? null, lk[0].id],
        );
        parties.push({ partyId: pt[0].id as string, index: i, token: tokens[i]! });
      }
      return { requestId, parties };
    });

    await audit(
      access.orgId,
      user.id,
      "node.sign.request",
      "file",
      id,
      { requestId: out.requestId, parties: out.parties.length, ordered: b.ordered },
      req.ip,
    );
    return { requestId: out.requestId, parties: out.parties };
  });

  // =====================================================================
  //  Authentifié — tableau de suivi (poll)
  // =====================================================================
  app.get("/nodes/:id/sign-requests", { preHandler: authenticate }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await requireNodePerm(req, id, "node.acl.view");

    const rows = await query<PartyRow>(
      `SELECT sr.id AS request_id, sr.status AS request_status, sr.ordered, sr.deadline,
              sr.created_at, sr.completed_at,
              p.id AS party_id, p.party_index, p.label, p.status AS party_status,
              p.signer_fpr, p.signed_at, p.submission_version_id
         FROM signature_requests sr
         JOIN signature_request_parties p ON p.request_id = sr.id
        WHERE sr.node_id = $1
        ORDER BY sr.created_at DESC, p.party_index ASC`,
      [id],
    );

    const byRequest = new Map<string, ReturnType<typeof requestDto>>();
    function requestDto(r: PartyRow) {
      return {
        id: r.request_id,
        status: r.request_status,
        ordered: r.ordered,
        deadline: r.deadline ?? null,
        createdAt: r.created_at,
        completedAt: r.completed_at ?? null,
        parties: [] as Array<Record<string, unknown>>,
      };
    }
    for (const r of rows) {
      let req0 = byRequest.get(r.request_id);
      if (!req0) {
        req0 = requestDto(r);
        byRequest.set(r.request_id, req0);
      }
      req0.parties.push({
        id: r.party_id,
        index: r.party_index,
        label: r.label ?? null,
        status: r.party_status,
        signerFpr: r.signer_fpr ?? null,
        signedAt: r.signed_at ?? null,
        submissionVersionId: r.submission_version_id ?? null,
      });
    }
    return { requests: [...byRequest.values()] };
  });

  // =====================================================================
  //  PUBLIC — écriture-retour anonyme de l'artefact signé (scellé par token)
  // =====================================================================
  // Corps = ciphertext application/octet-stream (l'artefact .elium re-chiffré sous
  // la CEK) ; nonce GCM 12 octets dans `x-content-nonce` (hex) ; empreinte de clé
  // du signataire optionnelle dans `x-signer-fpr` (hex). Reproduit le patron de
  // PUT /nodes/:id/content mais autorisé par le token, pas par un compte.
  app.post(
    "/links/:token/sign",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (req: FastifyRequest) => {
      const { token } = z.object({ token: z.string().min(1).max(512) }).parse(req.params);

      const nonceHex = String(req.headers["x-content-nonce"] ?? "");
      if (!/^[0-9a-f]{24}$/.test(nonceHex)) {
        throw badRequest("En-tête x-content-nonce invalide (nonce 12 octets hex).");
      }
      const fprHeader = String(req.headers["x-signer-fpr"] ?? "");
      const signerFpr = /^[0-9a-f]{16,128}$/.test(fprHeader) ? fprHeader : null;

      const body = req.body as Readable | undefined;
      if (!body || typeof body.pipe !== "function") {
        throw badRequest("Corps binaire attendu (application/octet-stream).");
      }

      // Résout le lien scellé « can_sign » → sa partie + le nœud. 404 générique
      // pour ne jamais distinguer token inconnu / révoqué / expiré.
      const link = await queryOne<{
        link_id: string;
        node_id: string;
        can_sign: boolean;
        revoked_at: string | null;
        expires_at: string | null;
        org_id: string;
        kind: string;
        party_id: string | null;
        party_status: string | null;
        party_index: number | null;
        ordered: boolean | null;
        deadline: string | null;
        request_id: string | null;
      }>(
        `SELECT sl.id AS link_id, sl.node_id, sl.can_sign, sl.revoked_at, sl.expires_at,
                n.org_id, n.kind,
                p.id AS party_id, p.status AS party_status, p.party_index, p.request_id,
                sr.ordered AS ordered, sr.deadline AS deadline
           FROM share_links sl
           JOIN nodes n ON n.id = sl.node_id
           LEFT JOIN signature_request_parties p ON p.link_id = sl.id
           LEFT JOIN signature_requests sr ON sr.id = p.request_id
          WHERE sl.token_hash = $1`,
        [sha256Hex(token)],
      );
      if (!link || link.revoked_at) throw notFound("Lien introuvable, révoqué ou expiré.");
      if (link.expires_at && new Date(link.expires_at).getTime() < Date.now()) {
        throw notFound("Lien introuvable, révoqué ou expiré.");
      }
      if (!link.can_sign || !link.party_id) throw badRequest("Ce lien n'autorise pas la signature.");
      if (link.kind !== "file") throw badRequest("Seuls les fichiers peuvent être signés.");
      if (link.party_status === "signed") throw conflict("Cette partie a déjà signé.");

      // Circuit ordonné : toutes les parties d'index inférieur doivent avoir signé.
      if (link.ordered && link.party_index != null) {
        const blocking = await queryOne<{ n: string }>(
          `SELECT COUNT(*)::text AS n FROM signature_request_parties
            WHERE request_id = $1 AND party_index < $2 AND status <> 'signed'`,
          [link.request_id, link.party_index],
        );
        if (blocking && Number(blocking.n) > 0) {
          throw conflict("Ce n'est pas encore votre tour : une partie précédente doit signer d'abord.");
        }
      }

      // Échéance dépassée → refuser (la demande reste consultable côté émetteur).
      if (link.deadline && new Date(link.deadline).getTime() < Date.now()) {
        throw conflict("Le délai de signature de cette demande est dépassé.");
      }

      const { node_id: nodeId, org_id: orgId } = link;

      // Flux direct vers le stockage (borné + comptabilisé), comme PUT content.
      const store = storage();
      const key = store.newKey();
      let size: number;
      try {
        size = await store.putStream(key, body, config.maxBlobBytes);
      } catch (err) {
        await store.delete(key).catch(() => {});
        if (err instanceof Error && err.message === "payload_too_large") throw tooLarge();
        throw err;
      }

      await withTx(async (c) => {
        const { rows: cur } = await c.query(`SELECT key_epoch FROM nodes WHERE id = $1 FOR UPDATE`, [nodeId]);
        if (!cur[0]) throw notFound();

        // Quota org sérialisé (verrou consultatif org-scoped), comme PUT content.
        await c.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [orgId]);
        const { rows: q } = await c.query(
          `SELECT o.storage_quota_bytes AS quota,
                  COALESCE((SELECT SUM(v.size_bytes) FROM node_versions v
                             JOIN nodes n2 ON n2.id = v.node_id WHERE n2.org_id = o.id), 0) AS used
             FROM organizations o WHERE o.id = $1`,
          [orgId],
        );
        const quota = q[0]?.quota as number | null;
        const used = Number(q[0]?.used ?? 0);
        if (quota != null && used + size > Number(quota)) {
          throw insufficientStorage(`Quota atteint : ${used + size} octets requis pour ${Number(quota)} alloués.`);
        }

        const { rows: vrows } = await c.query(
          `SELECT COALESCE(MAX(version_no), 0) + 1 AS next FROM node_versions WHERE node_id = $1`,
          [nodeId],
        );
        const versionNo = vrows[0].next as number;
        // created_by = NULL : le signataire est anonyme (pas de compte). Son
        // identité vérifiable vit DANS l'artefact (preuve Ed25519) + signer_fpr.
        const { rows: ver } = await c.query(
          `INSERT INTO node_versions (node_id, version_no, content_ref, content_nonce, size_bytes, created_by, key_epoch)
           VALUES ($1,$2,$3,$4,$5,NULL,$6) RETURNING id`,
          [nodeId, versionNo, key, hex(nonceHex), size, cur[0].key_epoch],
        );
        const versionId = ver[0].id as string;

        await c.query(
          `UPDATE nodes SET content_ref = $2, content_nonce = $3, size_bytes = $4,
                            current_version_id = $5, modified_at = now()
            WHERE id = $1`,
          [nodeId, key, hex(nonceHex), size, versionId],
        );

        await c.query(
          `UPDATE signature_request_parties
              SET status = 'signed', signer_fpr = $2, submission_version_id = $3, signed_at = now()
            WHERE id = $1`,
          [link.party_id, signerFpr, versionId],
        );

        // Demande complète quand plus aucune partie n'est en attente.
        await c.query(
          `UPDATE signature_requests sr
              SET status = 'completed', completed_at = now()
            WHERE sr.id = $1
              AND NOT EXISTS (SELECT 1 FROM signature_request_parties p
                               WHERE p.request_id = sr.id AND p.status <> 'signed')`,
          [link.request_id],
        );
      }).catch(async (err) => {
        await store.delete(key).catch(() => {});
        throw err;
      });

      // Audit anonyme (actor null) + réveil de la vue émetteur (poll conforté par push).
      await audit(orgId, null, "node.sign.submit", "file", nodeId, { signerFpr: signerFpr ?? undefined }, req.ip);
      notifyOrg(orgId);
      return { ok: true };
    },
  );

  // =====================================================================
  //  PUBLIC — refus anonyme d'une partie (scellé par token)
  // =====================================================================
  app.post("/links/:token/decline", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req) => {
    const { token } = z.object({ token: z.string().min(1).max(512) }).parse(req.params);
    const link = await queryOne<{
      can_sign: boolean;
      revoked_at: string | null;
      node_id: string;
      org_id: string;
      party_id: string | null;
      party_status: string | null;
    }>(
      `SELECT sl.can_sign, sl.revoked_at, sl.node_id, n.org_id,
                p.id AS party_id, p.status AS party_status
           FROM share_links sl
           JOIN nodes n ON n.id = sl.node_id
           LEFT JOIN signature_request_parties p ON p.link_id = sl.id
          WHERE sl.token_hash = $1`,
      [sha256Hex(token)],
    );
    if (!link || link.revoked_at) throw notFound("Lien introuvable, révoqué ou expiré.");
    if (!link.can_sign || !link.party_id) throw badRequest("Ce lien n'autorise pas la signature.");
    if (link.party_status === "signed") throw conflict("Cette partie a déjà signé.");

    await query(
      `UPDATE signature_request_parties SET status = 'declined'
          WHERE id = $1 AND status = 'pending'`,
      [link.party_id],
    );
    await audit(link.org_id, null, "node.sign.decline", "file", link.node_id, {}, req.ip);
    notifyOrg(link.org_id);
    return { ok: true };
  });
}
