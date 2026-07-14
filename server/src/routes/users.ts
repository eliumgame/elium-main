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
import { verifyEd25519 } from "../lib/crypto-server.js";
import { notFound, badRequest } from "../lib/errors.js";
import { audit } from "../lib/audit.js";

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

const PUBLIC_COLS =
  "id, email, display_name, ed25519_public_hex, p256_public_hex, fingerprint";

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
    fingerprint: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  })
  .refine((q) => (q.email ? 1 : 0) + (q.fingerprint ? 1 : 0) === 1, {
    message: "Fournir exactement un critère : email OU fingerprint.",
  });

const patchMeSchema = z.object({
  displayName: z.string().max(120).optional(),
  keyBundle: z.record(z.unknown()).optional(),
  // Password change: the new login verifier (auth-sign public key) + a proof of
  // possession (signature over the email by the new key).
  authSignPublicHex: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  authSignProof: z.string().regex(/^[0-9a-f]{128}$/).optional(),
  kdfSalt: z.string().min(8).max(256).optional(),
  kdfParams: z.record(z.unknown()).optional(),
});

export default async function userRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authenticate);

  // --- Directory lookup by exact email OR fingerprint ----------------------
  app.get("/lookup", async (req) => {
    const q = lookupSchema.parse(req.query);
    requireUser(req);

    const row = q.email
      ? await queryOne<PublicUserRow>(
          `SELECT ${PUBLIC_COLS} FROM users WHERE email = $1 AND status = 'active'`,
          [q.email],
        )
      : await queryOne<PublicUserRow>(
          `SELECT ${PUBLIC_COLS} FROM users WHERE fingerprint = $1 AND status = 'active'`,
          [q.fingerprint],
        );
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
    if (b.keyBundle !== undefined) {
      sets.push(`key_bundle = $${i++}`);
      params.push(JSON.stringify(b.keyBundle));
    }
    if (b.kdfSalt !== undefined) {
      sets.push(`kdf_salt = $${i++}`);
      params.push(b.kdfSalt);
    }
    if (b.kdfParams !== undefined) {
      sets.push(`kdf_params = $${i++}`);
      params.push(JSON.stringify(b.kdfParams));
    }
    if (b.authSignPublicHex !== undefined) {
      // Verify possession of the NEW auth key before rotating the verifier, so a
      // stolen session cannot lock the owner out with a key they don't control.
      if (!b.authSignProof || !verifyEd25519(user.email.toLowerCase(), b.authSignProof, b.authSignPublicHex)) {
        throw badRequest("Preuve de possession de la nouvelle clé d'authentification invalide.");
      }
      sets.push(`auth_sign_public_hex = $${i++}`);
      params.push(b.authSignPublicHex);
    }

    const row = await queryOne<PublicUserRow>(
      `UPDATE users SET ${sets.join(", ")} WHERE id = $1 RETURNING ${PUBLIC_COLS}`,
      params,
    );
    if (!row) throw notFound("Utilisateur introuvable.");

    await audit(null, user.id, "user.update", "user", user.id, {
      fields: Object.keys(b),
      passwordChanged: b.authSignPublicHex !== undefined,
    }, req.ip);
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
    }>(
      `SELECT id, user_agent, ip, created_at, expires_at, revoked_at
         FROM sessions
        WHERE user_id = $1
        ORDER BY created_at DESC`,
      [user.id],
    );
    return {
      sessions: rows.map((s) => ({
        id: s.id,
        userAgent: s.user_agent,
        ip: s.ip,
        createdAt: s.created_at,
        expiresAt: s.expires_at,
        revokedAt: s.revoked_at,
      })),
    };
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
      const exists = await queryOne<{ id: string }>(
        `SELECT id FROM sessions WHERE id = $1 AND user_id = $2`,
        [sessionId, user.id],
      );
      if (!exists) throw notFound("Session introuvable.");
    }
    await audit(null, user.id, "session.revoke", "session", sessionId, {}, req.ip);
    return { ok: true };
  });

  // --- Directory lookup by user id -----------------------------------------
  app.get("/:id", async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    requireUser(req);
    const row = await queryOne<PublicUserRow>(
      `SELECT ${PUBLIC_COLS} FROM users WHERE id = $1 AND status = 'active'`,
      [id],
    );
    if (!row) throw notFound("Utilisateur introuvable.");
    return { user: publicUserDto(row) };
  });
}
