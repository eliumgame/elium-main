/**
 * User directory + self-service. Zero-knowledge model:
 *  - The directory exposes ONLY public identity material (display name + the two
 *    public keys + fingerprint) so a sharer can wrap a node key to a recipient's
 *    P-256 public key. Verifiers, salts, KDF params and the key bundle are never
 *    returned to other users.
 *  - Self-service (`/me`) lets the owner change their password: the client
 *    re-derives a NEW auth-sign public key (the login verifier) and re-seals the
 *    key bundle under the new master key, then uploads both here. The server
 *    never sees the password or the master key.
 * Mounted under /api/users; fully authenticated.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { query, queryOne } from "../db/pool.js";
import { authenticate, requireUser } from "../middleware/auth.js";
import { verifyEd25519, sha256Hex } from "../lib/crypto-server.js";
import { notFound, badRequest, ApiError } from "../lib/errors.js";
import { audit } from "../lib/audit.js";
import { accountDeletionBlockers, eraseAccount, AccountDeletionBlocked } from "../lib/account-deletion.js";

/** Public identity material — safe to reveal to any authenticated user. */
function publicUserDto(u: {
  id: string;
  email: string;
  display_name: string;
  ed25519_public_hex: string;
  p256_public_hex: string;
  fingerprint: string;
}) {
  return {
    id: u.id,
    email: u.email,
    displayName: u.display_name,
    ed25519PublicHex: u.ed25519_public_hex,
    p256PublicHex: u.p256_public_hex,
    fingerprint: u.fingerprint,
  };
}

const PUBLIC_COLS = "id, email, display_name, ed25519_public_hex, p256_public_hex, fingerprint";

type PublicUserRow = {
  id: string;
  email: string;
  display_name: string;
  ed25519_public_hex: string;
  p256_public_hex: string;
  fingerprint: string;
};

// Exactly one of { email } or { fingerprint } must be provided.
const lookupSchema = z
  .object({
    email: z.string().email().max(320).optional(),
    fingerprint: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
  })
  .refine((q) => (q.email ? 1 : 0) + (q.fingerprint ? 1 : 0) === 1, {
    message: "Fournir exactement un critère : email OU fingerprint.",
  });

// Profil : SEUL le nom affiché est modifiable ici. Les clés, le paquet de clés et le vérificateur
// de connexion changent par « change-password » (preuve du mot de passe actuel sur défi) : un
// jeton d'accès volé ne doit pas pouvoir remplacer les clés ni détruire le paquet de clés.
const patchMeSchema = z.strictObject({ displayName: z.string().max(120).optional() });

function currentSessionHash(header: string | string[] | undefined): string | null {
  const raw = Array.isArray(header) ? header[0] : header;
  return raw && raw.length >= 10 ? sha256Hex(raw) : null;
}

export default async function userRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authenticate);

  // --- Directory lookup by exact email OR fingerprint ----------------------
  app.get("/lookup", async (req) => {
    const q = lookupSchema.parse(req.query);
    requireUser(req);

    const row = q.email
      ? await queryOne<PublicUserRow>(`SELECT ${PUBLIC_COLS} FROM users WHERE email = $1 AND status = 'active'`, [
          q.email,
        ])
      : await queryOne<PublicUserRow>(`SELECT ${PUBLIC_COLS} FROM users WHERE fingerprint = $1 AND status = 'active'`, [
          q.fingerprint,
        ]);
    if (!row) throw notFound("Utilisateur introuvable.");
    return { user: publicUserDto(row) };
  });

  // --- Update own profile (self-service) -----------------------------------
  // Defined before "/:id" so the literal path is not captured by the param.
  app.patch("/me", async (req) => {
    const b = patchMeSchema.parse(req.body);
    const user = requireUser(req);

    const sets: string[] = ["updated_at = now()"];
    const params: unknown[] = [user.id];
    let i = 2;

    if (b.displayName !== undefined) {
      sets.push(`display_name = $${i++}`);
      params.push(b.displayName);
    }

    const row = await queryOne<PublicUserRow>(
      `UPDATE users SET ${sets.join(", ")} WHERE id = $1 RETURNING ${PUBLIC_COLS}`,
      params,
    );
    if (!row) throw notFound("Utilisateur introuvable.");

    await audit(null, user.id, "user.update", "user", user.id, { fields: Object.keys(b) }, req.ip);
    return { user: publicUserDto(row) };
  });

  // --- List own sessions ---------------------------------------------------
  app.get("/me/sessions", async (req) => {
    const user = requireUser(req);
    const rows = await query<{
      id: string;
      user_agent: string;
      ip: string;
      created_at: string;
      expires_at: string;
      revoked_at: string | null;
      last_seen_at: string | null;
      refresh_token_hash: string;
    }>(
      `SELECT id, user_agent, ip, created_at, expires_at, revoked_at, last_seen_at, refresh_token_hash
         FROM sessions
        WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
        ORDER BY created_at DESC`,
      [user.id],
    );
    // L'appareil courant se reconnaît à son jeton de rafraîchissement (en-tête,
    // jamais en query string) : on compare des empreintes, le jeton n'est pas stocké.
    const current = currentSessionHash(req.headers["x-refresh-token"]);
    return {
      sessions: rows.map((s) => ({
        current: current !== null && s.refresh_token_hash === current,
        lastSeenAt: s.last_seen_at,
        id: s.id,
        userAgent: s.user_agent,
        ip: s.ip,
        createdAt: s.created_at,
        expiresAt: s.expires_at,
        revokedAt: s.revoked_at,
      })),
    };
  });

  // --- Revoke every OTHER session (« déconnecter mes autres appareils ») ----
  app.post("/me/sessions/revoke-others", async (req) => {
    const user = requireUser(req);
    const current = currentSessionHash(req.headers["x-refresh-token"]);
    if (!current) throw badRequest("Jeton de session courant manquant.");
    const rows = await query<{ id: string }>(
      `UPDATE sessions SET revoked_at = now()
        WHERE user_id = $1 AND revoked_at IS NULL AND refresh_token_hash <> $2
        RETURNING id`,
      [user.id, current],
    );
    await audit(null, user.id, "session.revoke_others", "user", user.id, { count: rows.length }, req.ip);
    return { ok: true, revoked: rows.length };
  });

  // --- Revoke one of own sessions ------------------------------------------
  app.delete("/me/sessions/:sessionId", async (req) => {
    const { sessionId } = z.object({ sessionId: z.string().uuid() }).parse(req.params);
    const user = requireUser(req);
    const row = await queryOne<{ id: string }>(
      `UPDATE sessions SET revoked_at = now()
        WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
        RETURNING id`,
      [sessionId, user.id],
    );
    if (!row) {
      // Either no such session, not ours, or already revoked — don't reveal which.
      const exists = await queryOne<{ id: string }>(`SELECT id FROM sessions WHERE id = $1 AND user_id = $2`, [
        sessionId,
        user.id,
      ]);
      if (!exists) throw notFound("Session introuvable.");
    }
    await audit(null, user.id, "session.revoke", "session", sessionId, {}, req.ip);
    return { ok: true };
  });

  // --- RGPD: preflight — what blocks erasing my account? -------------------
  app.get("/me/deletion-preflight", async (req) => {
    const user = requireUser(req);
    const blockers = await accountDeletionBlockers(user.id);
    return {
      canDelete: blockers.ownedOrgsWithMembers.length === 0 && blockers.soleRecoveryAdminOrgs.length === 0,
      ...blockers,
    };
  });

  // --- RGPD: erase my account (right to erasure) ---------------------------
  // Requires a fresh proof of possession of the account's auth key (signature
  // over "elium:delete-account:<email>"), so a merely-stolen access token can't
  // destroy the account. Personal data + key material are wiped and the account
  // disabled; an anonymized id survives only to keep the audit chain valid.
  app.delete("/me", async (req) => {
    const { proof } = z.object({ proof: z.string().regex(/^[0-9a-f]{128}$/) }).parse(req.body ?? {});
    const user = requireUser(req);
    const u = await queryOne<{ auth_sign_public_hex: string | null }>(
      `SELECT auth_sign_public_hex FROM users WHERE id = $1 AND status = 'active'`,
      [user.id],
    );
    if (!u?.auth_sign_public_hex) throw badRequest("Compte introuvable ou sans clé d'authentification.");
    if (!verifyEd25519(`elium:delete-account:${user.email.toLowerCase()}`, proof, u.auth_sign_public_hex)) {
      throw badRequest(
        "Preuve de possession invalide : signez « elium:delete-account:<email> » avec votre clé d'authentification.",
      );
    }

    try {
      const res = await eraseAccount(user.id);
      // System-level audit (org null). The tombstone id keeps this attributable
      // and the chain valid.
      await audit(
        null,
        user.id,
        "account.erased",
        "user",
        user.id,
        { deletedOrgs: res.deletedOrgs, transferredNodes: res.transferredNodes },
        req.ip,
      );
      return { ok: true, ...res };
    } catch (e) {
      if (e instanceof AccountDeletionBlocked) {
        throw new ApiError(
          409,
          "conflict",
          "Transférez la propriété / promouvez un administrateur de recouvrement avant de supprimer votre compte.",
          e.blockers,
        );
      }
      throw e;
    }
  });

  // --- Directory lookup by user id -----------------------------------------
  app.get("/:id", async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    requireUser(req);
    const row = await queryOne<PublicUserRow>(`SELECT ${PUBLIC_COLS} FROM users WHERE id = $1 AND status = 'active'`, [
      id,
    ]);
    if (!row) throw notFound("Utilisateur introuvable.");
    return { user: publicUserDto(row) };
  });
}
