/**
 * Enterprise SSO (OIDC) + SCIM token management.
 *
 * ZERO-KNOWLEDGE reminder: SSO authenticates the user's IDENTITY (the IdP proves
 * who they are) and lets the server issue a session. It does NOT unlock the
 * end-to-end content keys — the client still derives its master key from a
 * passphrase the server never sees, and uses it to open the returned key bundle.
 * So an org can mandate SSO for login while remaining zero-knowledge.
 *
 * Mounted at "/api": org-scoped SSO/SCIM-token config is authenticated; the
 * `/auth/sso/verify` endpoint is public (like /auth/login).
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { query, queryOne } from "../db/pool.js";
import { authenticate, requireUser, requireOrgPerm } from "../middleware/auth.js";
import { issueAccessToken, newRefreshToken } from "../lib/tokens.js";
import { sha256Hex, randomToken } from "../lib/crypto-server.js";
import { verifyIdTokenAsync, OidcError, type OidcConfig } from "../lib/oidc.js";
import { badRequest, unauthorized, notFound } from "../lib/errors.js";
import { audit } from "../lib/audit.js";
import { resyncOrgGroupRoles } from "./scim.js";

// Basic SSRF guard: the jwksUri is set by a semi-trusted org admin, but it must
// still not be pointed at loopback / link-local / obvious private ranges. This
// blocks literal private hosts; it does NOT defend against DNS pointing a public
// name at a private IP (documented residual — a network egress policy is the
// real fix in a hostile-tenant deployment).
function isSafeJwksUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h === "::1" || h === "[::1]") return false;
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false;
  return true;
}

const ssoConfigSchema = z
  .object({
    issuer: z.string().min(1).max(512),
    clientId: z.string().min(1).max(512),
    // Keys may be supplied inline (static) and/or fetched from a jwksUri.
    jwks: z.array(z.record(z.unknown())).max(10).optional(),
    jwksUri: z.string().url().max(1024).refine(isSafeJwksUrl, "jwksUri doit être https et non privée.").optional(),
    allowedDomains: z.array(z.string().max(253)).max(50).optional(),
  })
  .refine((c) => (c.jwks && c.jwks.length > 0) || !!c.jwksUri, {
    message: "Fournir au moins une clé statique (jwks) ou un jwksUri.",
  });

function userDto(u: Record<string, unknown>) {
  return {
    id: u.id,
    email: u.email,
    displayName: u.display_name,
    ed25519PublicHex: u.ed25519_public_hex,
    p256PublicHex: u.p256_public_hex,
    fingerprint: u.fingerprint,
  };
}

async function issueSession(userId: string, fingerprint: string, ua: string, ip: string) {
  const access = issueAccessToken(userId, fingerprint);
  const refresh = newRefreshToken();
  await query(
    `INSERT INTO sessions (user_id, refresh_token_hash, user_agent, ip, expires_at) VALUES ($1,$2,$3,$4,$5)`,
    [userId, refresh.hash, ua.slice(0, 400), ip.slice(0, 64), refresh.expiresAt],
  );
  return { accessToken: access.token, accessTokenExpiresAt: access.expiresAt, refreshToken: refresh.raw };
}

export default async function ssoRoutes(app: FastifyInstance): Promise<void> {
  // --- Configure an org's OIDC provider ------------------------------------
  app.put("/orgs/:orgId/sso", { preHandler: authenticate }, async (req) => {
    const { orgId } = z.object({ orgId: z.string().uuid() }).parse(req.params);
    const b = ssoConfigSchema.parse(req.body);
    const actor = requireUser(req);
    await requireOrgPerm(req, orgId, "org.settings.manage");
    await query(`UPDATE organizations SET sso_config = $2, updated_at = now() WHERE id = $1`, [
      orgId,
      JSON.stringify(b),
    ]);
    await audit(orgId, actor.id, "org.sso.configure", "org", orgId, { issuer: b.issuer }, req.ip);
    return { ok: true };
  });

  // --- Read the current SSO config (public keys only; safe to return) ------
  app.get("/orgs/:orgId/sso", { preHandler: authenticate }, async (req) => {
    const { orgId } = z.object({ orgId: z.string().uuid() }).parse(req.params);
    await requireOrgPerm(req, orgId, "org.settings.view");
    const row = await queryOne<{ sso_config: OidcConfig | null }>(
      `SELECT sso_config FROM organizations WHERE id = $1`,
      [orgId],
    );
    if (!row) throw notFound();
    return { sso: row.sso_config ?? null };
  });

  // --- Disable SSO ----------------------------------------------------------
  app.delete("/orgs/:orgId/sso", { preHandler: authenticate }, async (req) => {
    const { orgId } = z.object({ orgId: z.string().uuid() }).parse(req.params);
    const actor = requireUser(req);
    await requireOrgPerm(req, orgId, "org.settings.manage");
    await query(`UPDATE organizations SET sso_config = NULL WHERE id = $1`, [orgId]);
    await audit(orgId, actor.id, "org.sso.disable", "org", orgId, {}, req.ip);
    return { ok: true };
  });

  // --- (Re)generate the org's SCIM provisioning token ----------------------
  app.post("/orgs/:orgId/scim-token", { preHandler: authenticate }, async (req) => {
    const { orgId } = z.object({ orgId: z.string().uuid() }).parse(req.params);
    const actor = requireUser(req);
    await requireOrgPerm(req, orgId, "org.settings.manage");
    const token = randomToken(32);
    await query(`UPDATE organizations SET scim_token_hash = $2 WHERE id = $1`, [orgId, sha256Hex(token)]);
    await audit(orgId, actor.id, "org.scim.token", "org", orgId, {}, req.ip);
    // Returned ONCE; only its hash is stored. Give it to the IdP's SCIM client.
    return { token };
  });

  // --- Read SCIM provisioning config (default role + group→role mapping) ----
  app.get("/orgs/:orgId/scim-config", { preHandler: authenticate }, async (req) => {
    const { orgId } = z.object({ orgId: z.string().uuid() }).parse(req.params);
    await requireOrgPerm(req, orgId, "org.settings.view");
    const row = await queryOne<{
      settings: { scim?: { defaultRoleKey?: string; groupRoleMap?: Record<string, string> } } | null;
    }>(`SELECT settings FROM organizations WHERE id = $1`, [orgId]);
    if (!row) throw notFound();
    const scim = row.settings?.scim ?? {};
    return { defaultRoleKey: scim.defaultRoleKey ?? null, groupRoleMap: scim.groupRoleMap ?? {} };
  });

  // --- Set SCIM provisioning config -----------------------------------------
  app.put("/orgs/:orgId/scim-config", { preHandler: authenticate }, async (req) => {
    const { orgId } = z.object({ orgId: z.string().uuid() }).parse(req.params);
    const b = z
      .object({
        defaultRoleKey: z.string().min(1).max(64),
        groupRoleMap: z.record(z.string().min(1).max(64)).optional(),
      })
      .parse(req.body);
    const actor = requireUser(req);
    await requireOrgPerm(req, orgId, "org.settings.manage");

    // Every referenced role key must exist in this org.
    const keys = [b.defaultRoleKey, ...Object.values(b.groupRoleMap ?? {})];
    const known = await query<{ key: string }>(`SELECT key FROM roles WHERE org_id = $1 AND key = ANY($2::text[])`, [
      orgId,
      keys,
    ]);
    const knownSet = new Set(known.map((r) => r.key));
    const missing = [...new Set(keys.filter((k) => !knownSet.has(k)))];
    if (missing.length) throw badRequest(`Rôle(s) inconnu(s) : ${missing.join(", ")}.`);

    const scim = { defaultRoleKey: b.defaultRoleKey, groupRoleMap: b.groupRoleMap ?? {} };
    await query(
      `UPDATE organizations
          SET settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{scim}', $2::jsonb, true), updated_at = now()
        WHERE id = $1`,
      [orgId, JSON.stringify(scim)],
    );
    // Re-apply group→role mapping to existing SCIM-group members.
    await resyncOrgGroupRoles(orgId);
    await audit(
      orgId,
      actor.id,
      "org.scim.config",
      "org",
      orgId,
      { defaultRoleKey: b.defaultRoleKey, groups: Object.keys(scim.groupRoleMap).length },
      req.ip,
    );
    return { ok: true };
  });

  // --- Public: verify an OIDC ID token and open a session ------------------
  // Rate-limited like /auth/login/* — it's an unauthenticated endpoint doing
  // non-trivial signature verification (RS/ES/EdDSA against a configured JWKS).
  app.post("/auth/sso/verify", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req) => {
    const b = z.object({ orgId: z.string().uuid(), idToken: z.string().min(10).max(8192) }).parse(req.body);
    const org = await queryOne<{ sso_config: OidcConfig | null }>(
      `SELECT sso_config FROM organizations WHERE id = $1`,
      [b.orgId],
    );
    if (!org?.sso_config) throw badRequest("SSO non configuré pour cette organisation.");

    let claims;
    try {
      claims = await verifyIdTokenAsync(b.idToken, org.sso_config);
    } catch (e) {
      throw unauthorized(e instanceof OidcError ? e.message : "Jeton d'identité invalide.");
    }

    // SÉCURITÉ : l'appariement de compte se fait par e-mail. Un IdP qui émet un
    // jeton pour un e-mail NON vérifié permettrait de lier le `sub` d'un
    // attaquant à un compte existant (prise de contrôle). On exige donc que le
    // fournisseur ait vérifié l'e-mail (`email_verified: true`).
    if (!claims.emailVerified) {
      await audit(
        b.orgId,
        null,
        "auth.sso.denied",
        "user",
        null,
        { email: claims.email, reason: "email_unverified" },
        req.ip,
      );
      throw unauthorized("E-mail non vérifié par le fournisseur d'identité.");
    }

    // The user must already be an ACTIVE member of the org (created normally
    // once, or invited via SCIM and having completed key generation).
    const row = await queryOne<{
      id: string;
      email: string;
      display_name: string;
      ed25519_public_hex: string;
      p256_public_hex: string;
      fingerprint: string;
      key_bundle: unknown;
      status: string;
      sso_subject: string | null;
      membership_status: string;
    }>(
      `SELECT u.*, m.status AS membership_status
         FROM users u JOIN memberships m ON m.user_id = u.id
        WHERE u.email = $1 AND m.org_id = $2`,
      [claims.email, b.orgId],
    );
    if (!row || row.status !== "active" || row.membership_status !== "active") {
      await audit(b.orgId, null, "auth.sso.denied", "user", null, { email: claims.email }, req.ip);
      throw unauthorized("Aucun compte Elium actif pour cet e-mail dans cette organisation.");
    }
    // Bind the OIDC subject on first use; refuse a mismatched subject later.
    if (!row.sso_subject) {
      await query(`UPDATE users SET sso_subject = $2 WHERE id = $1`, [row.id, claims.sub]);
    } else if (row.sso_subject !== claims.sub) {
      throw unauthorized("L'identité SSO ne correspond pas au compte lié.");
    }

    const session = await issueSession(row.id, row.fingerprint, req.headers["user-agent"] ?? "", req.ip);
    await audit(b.orgId, row.id, "auth.sso.login", "user", row.id, {}, req.ip);
    // The client unlocks this bundle with the user's passphrase (zero-knowledge).
    return { user: userDto(row), keyBundle: row.key_bundle, ...session };
  });
}
