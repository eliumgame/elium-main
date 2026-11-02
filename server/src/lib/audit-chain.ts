/**
 * Intégrité chaînée du journal d'audit (append-only, tamper-evident).
 *
 * Chaque entrée porte `entry_hash = SHA-256(prev_hash || champs canoniques)`, où
 * `prev_hash` est l'`entry_hash` de l'entrée précédente de la MÊME chaîne (une
 * chaîne par organisation ; `org_id NULL` = chaîne système). Conséquence :
 *   • altérer un champ d'une entrée change son `entry_hash` → cassure ;
 *   • supprimer une entrée casse le maillon `prev_hash` de la suivante ;
 *   • réordonner casse la chaîne.
 * `verifyAuditChain` rejoue la chaîne et signale le premier maillon rompu. Le
 * serveur ne peut pas empêcher un DBA d'écrire dans la table, mais il rend toute
 * écriture hors-flux DÉTECTABLE — c'est l'objectif d'un journal à intégrité.
 */
import { createHash } from "node:crypto";
import { query } from "../db/pool.js";

/** Racine de chaîne (aucune entrée précédente) : 32 octets à zéro. */
export const GENESIS = Buffer.alloc(32);

/**
 * Forme CANONIQUE des métadonnées : exactement ce que la base stocke (aller-retour
 * JSON, comme `JSON.stringify` à l'INSERT puis la relecture JSONB). Une clé à
 * `undefined` disparaît, une `Date` devient sa chaîne ISO, etc. Hacher cette forme
 * — et non l'objet JS d'origine — garantit que `verifyAuditChain`, qui re-hache le
 * JSONB relu, retrouve le même hash. Pour des métadonnées déjà « propres » (le cas
 * de toutes les entrées historiques saines), le résultat est identique à l'objet
 * d'origine : les maillons existants restent vérifiables.
 */
export function canonicalAuditMetadata(metadata: unknown): unknown {
  try {
    const s = JSON.stringify(metadata ?? {});
    return s === undefined ? {} : (JSON.parse(s) as unknown);
  } catch {
    // Non sérialisable (cycle, BigInt) : marqueur explicite plutôt qu'une divergence.
    return { unserializable: true };
  }
}

/**
 * Variantes HISTORIQUES de métadonnées pour des entrées écrites AVANT la
 * canonicalisation (audit 2026-11) : l'ancien code hachait l'objet JS d'origine,
 * si bien qu'une clé `undefined` était hachée `null` (et absente en base) et
 * qu'une `Date` était hachée `{}` (et stockée en ISO). Seuls les deux appels
 * réellement concernés sont reconstruits — de façon ciblée par action, pour ne
 * pas affaiblir la détection d'altération des autres entrées. Ces entrées sont
 * comptées dans `legacyAccepted`.
 */
function legacyMetadataVariants(action: string, metadata: unknown): unknown[] {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return [];
  const m = metadata as Record<string, unknown>;
  if (action === "node.sign.submit" && !("signerFpr" in m)) return [{ ...m, signerFpr: null }];
  if (action === "site.user.password_reset" && typeof m.expiresAt === "string") return [{ ...m, expiresAt: {} }];
  return [];
}

/** Sérialisation stable (clés triées récursivement) pour hacher les métadonnées. */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`).join(",")}}`;
}

export interface AuditFields {
  orgId: string | null;
  actorUserId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  metadata: unknown;
  ip: string;
  createdAt: string; // ISO 8601 (UTC)
}

/** `entry_hash` d'une entrée à partir du hash précédent et de ses champs. */
export function auditEntryHash(prevHash: Buffer, f: AuditFields): Buffer {
  const payload = JSON.stringify([
    prevHash.toString("hex"),
    f.orgId ?? "",
    f.actorUserId ?? "",
    f.action,
    f.resourceType,
    f.resourceId ?? "",
    stableStringify(canonicalAuditMetadata(f.metadata)),
    f.ip,
    f.createdAt,
  ]);
  return createHash("sha256").update(payload).digest();
}

export interface AuditVerifyResult {
  ok: boolean;
  total: number; // entrées totales dans la chaîne
  hashed: number; // entrées effectivement chaînées (les anciennes peuvent être sans hash)
  brokenAtId?: string; // id de la première entrée dont le maillon est rompu
  /** Entrées antérieures au correctif de canonicalisation, validées via leur forme historique. */
  legacyAccepted?: number;
}

interface AuditRow {
  id: string;
  org_id: string | null;
  actor_user_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  metadata: unknown;
  ip: string;
  created_at: Date;
  prev_hash: Buffer | null;
  entry_hash: Buffer | null;
}

/** Taille de page pour la lecture paginée (voir verifyAuditChain ci-dessous). */
export const VERIFY_PAGE_SIZE = 5000;

/**
 * Rejoue la chaîne d'une organisation (org_id NULL = chaîne système) et vérifie
 * chaque maillon. Les entrées héritées SANS hash (antérieures à la
 * fonctionnalité) sont comptées mais non vérifiées ; la vérification porte sur la
 * queue chaînée. Rend `ok:false` + l'id du premier maillon rompu sinon.
 *
 * Lecture PAGINÉE (pages de `VERIFY_PAGE_SIZE` lignes, `id > curseur ORDER BY id
 * ASC LIMIT`) plutôt qu'un unique `SELECT *` sans LIMIT : une table `audit_log`
 * append-only ne fait que croître, donc charger l'historique entier d'une org en
 * mémoire en une fois est un usage mémoire non borné. L'état de vérification
 * (`expectedPrev`/`started`/`hashed`) est porté ENTRE les pages ; seule la page
 * courante est en mémoire à un instant donné.
 *
 * Dès qu'un maillon rompu est trouvé, on arrête de le vérifier (et `hashed` se
 * fige, exactement comme l'ancien retour anticipé dans la boucle) MAIS on
 * continue à paginer jusqu'à la fin pour que `total` reste le compte EXACT de
 * toutes les lignes de la chaîne — identique à `rows.length` de l'ancienne
 * implémentation à requête unique, qui chargeait tout avant de boucler.
 */
export async function verifyAuditChain(orgId: string | null): Promise<AuditVerifyResult> {
  let total = 0;
  let hashed = 0;
  let expectedPrev: Buffer = GENESIS;
  let started = false;
  let brokenAtId: string | undefined;
  let afterId: AuditRow["id"] | null = null;
  let legacyAccepted = 0;

  while (true) {
    const page: AuditRow[] = await query<AuditRow>(
      `SELECT id, org_id, actor_user_id, action, resource_type, resource_id, metadata, ip, created_at, prev_hash, entry_hash
         FROM audit_log
        WHERE org_id IS NOT DISTINCT FROM $1
          AND ($2::bigint IS NULL OR id > $2::bigint)
        ORDER BY id ASC
        LIMIT $3`,
      [orgId, afterId, VERIFY_PAGE_SIZE],
    );
    if (page.length === 0) break;

    for (const r of page) {
      total++;
      if (brokenAtId !== undefined) {
        // Maillon déjà rompu plus tôt dans la chaîne : ne plus vérifier, on ne
        // fait plus que compter `total` jusqu'à la fin de la table.
        continue;
      }
      if (r.entry_hash == null) {
        if (started) {
          // Une ligne SANS hash APRÈS le début de la chaîne n'est pas une entrée héritée
          // (celles-ci précèdent la 1re entrée hachée) : c'est une insertion hors-chaîne
          // (forgée / altérée) → maillon rompu.
          brokenAtId = r.id;
          continue;
        }
        // Entrée héritée non chaînée : on ne vérifie pas, et elle ne fixe pas le
        // maillon (la chaîne démarre à la première entrée hachée, dont prev = GENESIS).
        continue;
      }
      hashed++;
      const prev = Buffer.from(r.prev_hash ?? GENESIS);
      const entryHash = Buffer.from(r.entry_hash);
      const fields: AuditFields = {
        orgId: r.org_id,
        actorUserId: r.actor_user_id,
        action: r.action,
        resourceType: r.resource_type,
        resourceId: r.resource_id,
        metadata: r.metadata,
        ip: r.ip,
        createdAt: new Date(r.created_at).toISOString(),
      };
      let hashOk = auditEntryHash(prev, fields).equals(entryHash);
      if (!hashOk) {
        for (const variant of legacyMetadataVariants(r.action, r.metadata)) {
          if (auditEntryHash(prev, { ...fields, metadata: variant }).equals(entryHash)) {
            hashOk = true;
            legacyAccepted++;
            break;
          }
        }
      }
      const prevOk = !started ? prev.equals(GENESIS) : prev.equals(expectedPrev);
      if (!prevOk || !hashOk) {
        brokenAtId = r.id;
        continue;
      }
      expectedPrev = entryHash;
      started = true;
    }

    afterId = page[page.length - 1]!.id;
    if (page.length < VERIFY_PAGE_SIZE) break; // dernière page (page incomplète = plus de lignes)
  }

  const legacy = legacyAccepted ? { legacyAccepted } : {};
  if (brokenAtId !== undefined) {
    return { ok: false, total, hashed, brokenAtId, ...legacy };
  }
  return { ok: true, total, hashed, ...legacy };
}
