/**
 * Authentication routes. Zero-knowledge, ORACLE-FREE model:
 *  - The client derives an Ed25519 `authSign` key and the `masterKey` from the
 *    password via Argon2id + HKDF (DISTINCT info). Only the auth-sign PUBLIC key
 *    reaches the server (at registration). Login is a challenge-response: the
 *    server sends a random nonce, the client signs it — no password-equivalent
 *    ever crosses the wire, so a compromised/observing server cannot mount an
 *    offline dictionary attack (the goal of SRP/OPAQUE, reached with a vetted
 *    Ed25519 primitive rather than hand-rolled PAKE arithmetic).
 *  - The `masterKey` never leaves the client; private keys live in `keyBundle`,
 *    encrypted client-side by masterKey.
 */
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { query, queryOne } from "../db/pool.js";
import {
  verifyEd25519,
  sha256Hex,
  randomHex,
  encryptServerSecret,
  decryptServerSecret,
} from "../lib/crypto-server.js";
import { issueAccessToken, newRefreshToken, hashToken, issueScopedToken, verifyScopedToken } from "../lib/tokens.js";
import { generateTotpSecret, verifyTotp, otpauthUri, generateBackupCodes } from "../lib/totp.js";
import { authenticate, requireUser } from "../middleware/auth.js";
import { badRequest, unauthorized, conflict } from "../lib/errors.js";
import { audit } from "../lib/audit.js";
import { config } from "../config.js";

const MFA_LOGIN_PURPOSE = "mfa-login";
// Standard client KDF parameters (mirror of DEFAULT_KDF_PARAMS in
// web-studio/src/drive-cloud/kdf.ts). The prelogin DECOY must return these so
// an unknown email is shape-identical to a real account (real accounts store
// these same values at registration).
const DECOY_KDF_PARAMS = { alg: "argon2id", t: 3, m: 262144, p: 4 } as const;
// Shared verbatim across every /login/verify failure branch (unknown email,
// expired/reused/decoy challenge, bad signature) so the response text itself
// can never be used to enumerate which emails have an account — only the
// (oracle-free) challenge-response outcome distinguishes them.
const LOGIN_FAILURE_MESSAGE = "E-mail ou mot de passe incorrect, ou session de connexion expirée.";

/** Verify a submitted 6-digit TOTP OR consume a one-time backup code. */
async function verifySecondFactor(userId: string, code: string): Promise<boolean> {
  const norm = code.replace(/\s/g, "");
  const u = await queryOne<{ mfa_secret_enc: Buffer | null; mfa_secret_nonce: Buffer | null }>(
    `SELECT mfa_secret_enc, mfa_secret_nonce FROM users WHERE id = $1 AND mfa_enabled = true`,
    [userId],
  );
  if (u?.mfa_secret_enc && u.mfa_secret_nonce && /^\d{6}$/.test(norm)) {
    try {
      const secret = decryptServerSecret(u.mfa_secret_enc, u.mfa_secret_nonce);
      if (verifyTotp(secret, norm)) return true;
    } catch {
      // The stored secret failed to decrypt (e.g. TOKEN_SECRET was rotated
      // since enrollment). Don't crash the request with an uncaught 500 —
      // fall through to the backup-code path below, which still works
      // (backup codes are hashed, not encrypted under TOKEN_SECRET) and is
      // the account's only remaining way out of a permanent lockout.
    }
  }
  // Backup code fallback: single-use, matched by hash, then burned.
  const used = await queryOne<{ id: string }>(
    `UPDATE mfa_backup_codes SET used_at = now()
      WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL
      RETURNING id`,
    [userId, sha256Hex(norm.toLowerCase())],
  );
  return !!used;
}

const hex = (len?: number) => (len ? z.string().regex(new RegExp(`^[0-9a-f]{${len}}$`)) : z.string().regex(/^[0-9a-f]+$/));

const registerSchema = z.object({
  email: z.string().email().max(320),
  displayName: z.string().max(120).default(""),
  ed25519PublicHex: hex(64),
  p256PublicHex: hex(130),
  fingerprint: hex(64),
  // Public key of the password-derived Ed25519 auth key (the login verifier),
  // plus a signature over the email proving the client holds the private half.
  authSignPublicHex: hex(64),
  authSignProof: hex(128),
  kdfSalt: z.string().min(8).max(256),
  kdfParams: z.record(z.unknown()).default({}),
  keyBundle: z.record(z.unknown()),
  // Ed25519 signature over `email|ed25519PublicHex|p256PublicHex`, proving the
  // client controls the identity private key it is registering.
  bindingProof: hex(128),
});

function userDto(u: {
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

async function issueSession(app: FastifyInstance, userId: string, fingerprint: string, ua: string, ip: string) {
  const access = issueAccessToken(userId, fingerprint);
  const refresh = newRefreshToken();
  await query(
    `INSERT INTO sessions (user_id, refresh_token_hash, user_agent, ip, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, refresh.hash, ua.slice(0, 400), ip.slice(0, 64), refresh.expiresAt],
  );
  return {
    accessToken: access.token,
    accessTokenExpiresAt: access.expiresAt,
    refreshToken: refresh.raw,
  };
}

// Per-route rate limits (override the global limiter) to throttle credential
// stuffing / brute force on the sensitive auth surface. Keyed by client IP.
const rl = (max: number) => ({ config: { rateLimit: { max, timeWindow: "1 minute" } } });

export default async function authRoutes(app: FastifyInstance): Promise<void> {
  // --- Register ------------------------------------------------------------
  app.post("/register", rl(20), async (req) => {
    const b = registerSchema.parse(req.body);

    // Convention Elium : l'empreinte est sha256 des OCTETS BRUTS de la clé
    // publique (voir web-studio/src/sign/keys.ts), pas de sa représentation hex.
    if (sha256Hex(Buffer.from(b.ed25519PublicHex, "hex")) !== b.fingerprint) {
      throw badRequest("Empreinte incohérente avec la clé publique.");
    }
    const bindingMsg = `${b.email.toLowerCase()}|${b.ed25519PublicHex}|${b.p256PublicHex}`;
    if (!verifyEd25519(bindingMsg, b.bindingProof, b.ed25519PublicHex)) {
      throw badRequest("Preuve de possession de clé invalide.");
    }
    // Prove the client also holds the auth-sign private key it is registering.
    if (!verifyEd25519(b.email.toLowerCase(), b.authSignProof, b.authSignPublicHex)) {
      throw badRequest("Preuve de possession de la clé d'authentification invalide.");
    }

    const existing = await queryOne(`SELECT id FROM users WHERE email = $1`, [b.email]);
    if (existing) throw conflict("Un compte existe déjà pour cet e-mail.");

    const row = await queryOne<{
      id: string;
      email: string;
      display_name: string;
      ed25519_public_hex: string;
      p256_public_hex: string;
      fingerprint: string;
    }>(
      `INSERT INTO users (email, display_name, ed25519_public_hex, p256_public_hex, fingerprint,
                          auth_sign_public_hex, kdf_salt, kdf_params, key_bundle)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id, email, display_name, ed25519_public_hex, p256_public_hex, fingerprint`,
      [
        b.email,
        b.displayName,
        b.ed25519PublicHex,
        b.p256PublicHex,
        b.fingerprint,
        b.authSignPublicHex,
        b.kdfSalt,
        JSON.stringify(b.kdfParams),
        JSON.stringify(b.keyBundle),
      ],
    );
    if (!row) throw badRequest("Création du compte impossible.");

    const session = await issueSession(app, row.id, row.fingerprint, req.headers["user-agent"] ?? "", req.ip);
    await audit(null, row.id, "auth.register", "user", row.id, {}, req.ip);
    return { user: userDto(row), ...session };
  });

  // --- Prelogin: fetch the client KDF salt/params for an email -------------
  // Returns generic (non-existence-revealing) defaults for unknown emails so an
  // attacker cannot enumerate accounts.
  app.post("/prelogin", rl(30), async (req) => {
    const { email } = z.object({ email: z.string().email().max(320) }).parse(req.body);
    const row = await queryOne<{ kdf_salt: string; kdf_params: unknown }>(
      `SELECT kdf_salt, kdf_params FROM users WHERE email = $1 AND status = 'active'`,
      [email],
    );
    if (row) return { kdfSalt: row.kdf_salt, kdfParams: row.kdf_params };
    // Decoy for an unknown email must be INDISTINGUISHABLE from a real account,
    // or the response shape itself is an enumeration oracle:
    //  - a 16-byte (32 hex) salt, exactly like a real random one — NOT a 32-byte
    //    (64 hex) sha256 digest, whose length alone would betray the decoy;
    //  - the standard Argon2id params a real client stores — NOT `{}`.
    // Peppered with the server secret (so an attacker cannot recompute the
    // expected decoy salt for an email and compare) yet deterministic per email
    // (a real account returns the same salt on every prelogin).
    const decoySalt = sha256Hex(`${config.tokenSecret}|prelogin-decoy|${email.toLowerCase()}`).slice(0, 32);
    return { kdfSalt: decoySalt, kdfParams: DECOY_KDF_PARAMS };
  });

  // --- Login step 1: fetch a challenge -------------------------------------
  // Oracle-free login: the server issues a random challenge; the client proves
  // knowledge of the password-derived auth key by SIGNING it (never sending a
  // password-equivalent). Unknown emails still receive a (decoy) challenge so
  // account existence is not revealed.
  app.post("/login/init", rl(25), async (req) => {
    const { email } = z.object({ email: z.string().email().max(320) }).parse(req.body);
    const challenge = randomHex(32);
    const row = await queryOne<{ id: string }>(
      `SELECT id FROM users WHERE email = $1 AND status = 'active' AND auth_sign_public_hex IS NOT NULL`,
      [email],
    );
    if (!row) {
      // Decoy: a UUID-shaped challengeId that is never stored, so /login/verify
      // returns the SAME 401 as a wrong signature — no account-existence oracle.
      return { challengeId: randomUUID(), challenge };
    }
    const ch = await queryOne<{ id: string }>(
      `INSERT INTO login_challenges (user_id, nonce, expires_at)
       VALUES ($1, $2, now() + interval '5 minutes') RETURNING id`,
      [row.id, challenge],
    );
    return { challengeId: ch!.id, challenge };
  });

  // --- Login step 2: verify the signature ----------------------------------
  // On success: issue the session, UNLESS MFA is enabled — then stop and return
  // a short-lived `mfaToken` (the key bundle is withheld until factor 2).
  app.post("/login/verify", rl(30), async (req) => {
    const b = z
      .object({ email: z.string().email().max(320), challengeId: z.string().uuid(), signature: hex(128) })
      .parse(req.body);

    const ch = await queryOne<{ id: string; user_id: string; nonce: string; expires_at: string; used_at: string | null }>(
      `SELECT id, user_id, nonce, expires_at, used_at FROM login_challenges WHERE id = $1`,
      [b.challengeId],
    );
    if (!ch || ch.used_at || new Date(ch.expires_at).getTime() < Date.now()) {
      throw unauthorized(LOGIN_FAILURE_MESSAGE);
    }
    const row = await queryOne<{
      id: string;
      email: string;
      display_name: string;
      ed25519_public_hex: string;
      p256_public_hex: string;
      fingerprint: string;
      auth_sign_public_hex: string | null;
      key_bundle: unknown;
      status: string;
      mfa_enabled: boolean;
    }>(`SELECT * FROM users WHERE id = $1 AND email = $2`, [ch.user_id, b.email]);

    // Burn the challenge regardless of the outcome (single use).
    await query(`UPDATE login_challenges SET used_at = now() WHERE id = $1`, [b.challengeId]);

    if (
      !row ||
      row.status !== "active" ||
      !row.auth_sign_public_hex ||
      !verifyEd25519(ch.nonce, b.signature, row.auth_sign_public_hex)
    ) {
      throw unauthorized(LOGIN_FAILURE_MESSAGE);
    }

    if (row.mfa_enabled) {
      await audit(null, row.id, "auth.login.mfa_required", "user", row.id, {}, req.ip);
      return { mfaRequired: true as const, mfaToken: issueScopedToken(row.id, MFA_LOGIN_PURPOSE) };
    }

    const session = await issueSession(app, row.id, row.fingerprint, req.headers["user-agent"] ?? "", req.ip);
    await audit(null, row.id, "auth.login", "user", row.id, {}, req.ip);
    return { user: userDto(row), keyBundle: row.key_bundle, ...session };
  });

  // --- Login step 2: second factor -----------------------------------------
  app.post("/login/mfa", rl(20), async (req) => {
    const b = z.object({ mfaToken: z.string().min(10), code: z.string().min(4).max(16) }).parse(req.body);
    const userId = verifyScopedToken(b.mfaToken, MFA_LOGIN_PURPOSE);
    if (!userId) throw unauthorized("Session de connexion expirée, recommencez.");
    if (!(await verifySecondFactor(userId, b.code))) {
      await audit(null, userId, "auth.login.mfa_failed", "user", userId, {}, req.ip);
      throw unauthorized("Code de vérification invalide.");
    }
    const row = await queryOne<{
      id: string;
      email: string;
      display_name: string;
      ed25519_public_hex: string;
      p256_public_hex: string;
      fingerprint: string;
      key_bundle: unknown;
      status: string;
    }>(`SELECT * FROM users WHERE id = $1`, [userId]);
    if (!row || row.status !== "active") throw unauthorized();
    const session = await issueSession(app, row.id, row.fingerprint, req.headers["user-agent"] ?? "", req.ip);
    await audit(null, row.id, "auth.login", "user", row.id, { mfa: true }, req.ip);
    return { user: userDto(row), keyBundle: row.key_bundle, ...session };
  });

  // --- Refresh -------------------------------------------------------------
  app.post("/refresh", rl(60), async (req) => {
    const { refreshToken } = z.object({ refreshToken: z.string().min(10) }).parse(req.body);
    const h = hashToken(refreshToken);
    const s = await queryOne<{ id: string; user_id: string; expires_at: string; revoked_at: string | null }>(
      `SELECT id, user_id, expires_at, revoked_at FROM sessions WHERE refresh_token_hash = $1`,
      [h],
    );
    if (!s || s.revoked_at || new Date(s.expires_at).getTime() < Date.now()) throw unauthorized("Session expirée.");
    const u = await queryOne<{ fingerprint: string; status: string }>(
      `SELECT fingerprint, status FROM users WHERE id = $1`,
      [s.user_id],
    );
    if (!u || u.status !== "active") throw unauthorized();

    // Rotate the refresh token.
    const rotated = newRefreshToken();
    await query(`UPDATE sessions SET refresh_token_hash = $1, expires_at = $2 WHERE id = $3`, [
      rotated.hash,
      rotated.expiresAt,
      s.id,
    ]);
    const access = issueAccessToken(s.user_id, u.fingerprint);
    return { accessToken: access.token, accessTokenExpiresAt: access.expiresAt, refreshToken: rotated.raw };
  });

  // --- Logout --------------------------------------------------------------
  app.post("/logout", rl(30), async (req) => {
    const parsed = z.object({ refreshToken: z.string().optional() }).safeParse(req.body ?? {});
    if (parsed.success && parsed.data.refreshToken) {
      await query(`UPDATE sessions SET revoked_at = now() WHERE refresh_token_hash = $1`, [
        hashToken(parsed.data.refreshToken),
      ]);
    }
    return { ok: true };
  });

  // =========================================================================
  //  MFA management (all authenticated)
  // =========================================================================

  // --- Status --------------------------------------------------------------
  app.get("/mfa/status", { preHandler: authenticate }, async (req) => {
    const user = requireUser(req);
    const row = await queryOne<{ mfa_enabled: boolean; remaining: number }>(
      `SELECT u.mfa_enabled,
              (SELECT COUNT(*)::int FROM mfa_backup_codes b WHERE b.user_id = u.id AND b.used_at IS NULL) AS remaining
         FROM users u WHERE u.id = $1`,
      [user.id],
    );
    return { enabled: !!row?.mfa_enabled, backupCodesRemaining: row?.remaining ?? 0 };
  });

  // --- Setup: generate a pending secret + otpauth URI ----------------------
  app.post("/mfa/setup", { preHandler: authenticate }, async (req) => {
    const user = requireUser(req);
    const secret = generateTotpSecret();
    const { ct, nonce } = encryptServerSecret(secret);
    await query(`UPDATE users SET mfa_pending_enc = $2, mfa_pending_nonce = $3 WHERE id = $1`, [user.id, ct, nonce]);
    await audit(null, user.id, "auth.mfa.setup", "user", user.id, {}, req.ip);
    return { secret, otpauthUri: otpauthUri(secret, user.email) };
  });

  // --- Enable: confirm the pending secret with a first valid code ----------
  app.post("/mfa/enable", { preHandler: authenticate, config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req) => {
    const b = z.object({ code: z.string().min(6).max(6) }).parse(req.body);
    const user = requireUser(req);
    const row = await queryOne<{ mfa_pending_enc: Buffer | null; mfa_pending_nonce: Buffer | null; mfa_enabled: boolean }>(
      `SELECT mfa_pending_enc, mfa_pending_nonce, mfa_enabled FROM users WHERE id = $1`,
      [user.id],
    );
    if (row?.mfa_enabled) throw conflict("Le MFA est déjà activé.");
    if (!row?.mfa_pending_enc || !row.mfa_pending_nonce) throw badRequest("Aucun enrôlement en attente — relancez la configuration.");
    const secret = decryptServerSecret(row.mfa_pending_enc, row.mfa_pending_nonce);
    if (!verifyTotp(secret, b.code)) throw unauthorized("Code invalide — vérifiez l'heure de votre téléphone.");

    const backupCodes = generateBackupCodes(10);
    await query(`DELETE FROM mfa_backup_codes WHERE user_id = $1`, [user.id]);
    for (const c of backupCodes) {
      await query(`INSERT INTO mfa_backup_codes (user_id, code_hash) VALUES ($1, $2)`, [user.id, sha256Hex(c)]);
    }
    await query(
      `UPDATE users
          SET mfa_enabled = true,
              mfa_secret_enc = mfa_pending_enc, mfa_secret_nonce = mfa_pending_nonce,
              mfa_pending_enc = NULL, mfa_pending_nonce = NULL
        WHERE id = $1`,
      [user.id],
    );
    await audit(null, user.id, "auth.mfa.enable", "user", user.id, {}, req.ip);
    return { enabled: true, backupCodes };
  });

  // --- Disable: requires a valid current second factor ---------------------
  app.post("/mfa/disable", { preHandler: authenticate, config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req) => {
    const b = z.object({ code: z.string().min(4).max(16) }).parse(req.body);
    const user = requireUser(req);
    if (!(await verifySecondFactor(user.id, b.code))) throw unauthorized("Code de vérification invalide.");
    await query(
      `UPDATE users
          SET mfa_enabled = false, mfa_secret_enc = NULL, mfa_secret_nonce = NULL,
              mfa_pending_enc = NULL, mfa_pending_nonce = NULL
        WHERE id = $1`,
      [user.id],
    );
    await query(`DELETE FROM mfa_backup_codes WHERE user_id = $1`, [user.id]);
    await audit(null, user.id, "auth.mfa.disable", "user", user.id, {}, req.ip);
    return { enabled: false };
  });

  // --- Regenerate backup codes (requires a valid second factor) ------------
  app.post("/mfa/backup-codes", { preHandler: authenticate, config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req) => {
    const b = z.object({ code: z.string().min(4).max(16) }).parse(req.body);
    const user = requireUser(req);
    if (!(await verifySecondFactor(user.id, b.code))) throw unauthorized("Code de vérification invalide.");
    const backupCodes = generateBackupCodes(10);
    await query(`DELETE FROM mfa_backup_codes WHERE user_id = $1`, [user.id]);
    for (const c of backupCodes) {
      await query(`INSERT INTO mfa_backup_codes (user_id, code_hash) VALUES ($1, $2)`, [user.id, sha256Hex(c)]);
    }
    await audit(null, user.id, "auth.mfa.backup_regen", "user", user.id, {}, req.ip);
    return { backupCodes };
  });

  // --- Me ------------------------------------------------------------------
  app.get("/me", { preHandler: authenticate }, async (req) => {
    const user = requireUser(req);
    const orgs = await query(
      `SELECT o.id, o.name, o.slug, m.role_id, r.key AS role_key
         FROM memberships m
         JOIN organizations o ON o.id = m.org_id
         JOIN roles r ON r.id = m.role_id
        WHERE m.user_id = $1 AND m.status = 'active'
        ORDER BY o.name`,
      [user.id],
    );
    return { user, organizations: orgs };
  });
}
