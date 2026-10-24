/**
 * Portail du propriétaire — réglages du déploiement et gestion des utilisateurs.
 * Monté sous /api/site (voir app.ts).
 *
 *  - GET  /policy                       PUBLIC : ce que l'écran de connexion doit savoir
 *                                       (inscription, longueur du mot de passe, 2FA…). Sa
 *                                       présence indique aussi au front « je suis sur un
 *                                       site déployé » (garde d'authentification).
 *  - GET  /me                           suis-je le propriétaire du déploiement ?
 *  - GET/PUT /admin/settings            réglages (propriétaire uniquement)
 *  - GET  /admin/users                  liste des utilisateurs (rôle, quota, usage, 2FA…)
 *  - PATCH /admin/users/:userId         suspendre / réactiver, changer de rôle, quota
 *  - POST /admin/users/:userId/revoke-sessions
 *
 * « Propriétaire du déploiement » = propriétaire de l'organisation du site
 * (organizations.owner_user_id) : on RÉUTILISE le modèle organisation / rôles
 * existant, le portail n'en crée pas un second.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "../config.js";
import { query, queryOne, withTx } from "../db/pool.js";
import { authenticate, requireUser } from "../middleware/auth.js";
import { ApiError, badRequest, conflict, notFound } from "../lib/errors.js";
import { verifySecondFactor } from "../lib/second-factor.js";
import { randomToken, sha256Hex } from "../lib/crypto-server.js";
import { audit } from "../lib/audit.js";
import { isActivationRequired } from "../lib/activation.js";
import { diskMarginBytes, getDiskStats } from "../lib/disk.js";
import {
  getSiteState,
  getSiteSettings,
  invalidateSiteSettings,
  isSiteOwner,
  mfaEnrollmentRequired,
  hasSecondFactor,
  requireSiteOwner,
  saveSiteSettings,
  siteSettingsSchema,
  type SiteSettings,
  userUsageBytes,
} from "../lib/site-settings.js";

const RESET_TTL_MS = 24 * 60 * 60 * 1000;
const idParam = z.object({ userId: z.string().uuid() });

/**
 * Imposer la 2FA à tous est la seule réglage capable d'enfermer le propriétaire
 * dehors : on exige donc une RÉ-AUTHENTIFICATION — un code TOTP (ou de secours)
 * valide, produit à l'instant. Un propriétaire qui n'a que des clés d'accès (pas de
 * TOTP) n'a pas de code à fournir : la confirmation explicite de l'interface suffit.
 */
async function assertMfaProofForEnforcement(userId: string, currentPolicy: string, proof?: string): Promise<void> {
  if (currentPolicy === "required") return; // pas un changement
  const u = await queryOne<{ mfa_enabled: boolean }>(`SELECT mfa_enabled FROM users WHERE id = $1`, [userId]);
  if (!u?.mfa_enabled) return;
  if (!proof) {
    throw new ApiError(
      403,
      "mfa_proof_required",
      "Saisissez un code de votre application d'authentification (ou un code de secours) pour imposer la 2FA.",
    );
  }
  if (!(await verifySecondFactor(userId, proof))) {
    throw new ApiError(403, "mfa_proof_invalid", "Code de vérification invalide : la 2FA n'a pas été imposée.");
  }
}

/** Jauge de stockage réel + allocation des quotas (null si pas de disque local à mesurer). */
async function diskReport(orgId: string, settings: SiteSettings) {
  const stats = await getDiskStats();
  if (!stats) {
    return {
      available: false as const,
      reason:
        config.storage.driver === "fs"
          ? "L'espace disque n'a pas pu être mesuré sur ce serveur."
          : "Le stockage est externe (S3) : il n'y a pas de disque local à mesurer ; surveillez-le chez votre fournisseur.",
    };
  }
  const m = await queryOne<{ n: number | string; nodef: number | string; sum: number | string }>(
    `SELECT COUNT(*) AS n, COUNT(*) FILTER (WHERE quota_bytes IS NULL) AS nodef,
            COALESCE(SUM(quota_bytes), 0) AS sum
       FROM memberships WHERE org_id = $1 AND status = 'active'`,
    [orgId],
  );
  const nodef = Number(m?.nodef ?? 0);
  const unlimited = nodef > 0 && settings.perUserQuotaBytes == null;
  const allocated = unlimited ? null : Number(m?.sum ?? 0) + nodef * (settings.perUserQuotaBytes ?? 0);
  const margin = diskMarginBytes(stats.totalBytes, settings);
  return {
    available: true as const,
    totalBytes: stats.totalBytes,
    freeBytes: stats.freeBytes,
    marginBytes: margin,
    allocatedQuotaBytes: allocated,
    quotaUnlimited: unlimited,
    overAllocated: allocated != null && allocated > stats.totalBytes,
    // « Proche de la limite » : moins de deux marges libres. « Critique » : sous la marge (envois refusés).
    low: stats.freeBytes < margin * 2,
    critical: stats.freeBytes < margin,
  };
}

export default async function siteRoutes(app: FastifyInstance): Promise<void> {
  // --- Public : politique du site -----------------------------------------
  app.get("/policy", async () => {
    const { orgId, settings } = await getSiteState();
    return {
      deployed: true,
      // Pas encore de Drive : le premier compte créé en sera le propriétaire.
      bootstrapped: !!orgId,
      // Code d'activation exigé pour créer le premier compte / le Drive.
      activationRequired: await isActivationRequired(),
      signupMode: settings.signupMode,
      mfaPolicy: settings.mfaPolicy,
      passwordMinLength: settings.passwordMinLength,
      backupRequired: settings.backupRequired,
      siteName: settings.siteName,
    };
  });

  // --- Tout le reste exige un compte --------------------------------------
  app.register(async (priv) => {
    priv.addHook("preHandler", authenticate);

    priv.get("/me", async (req) => {
      const user = requireUser(req);
      const { orgId, settings } = await getSiteState();
      return {
        orgId,
        isOwner: await isSiteOwner(user.id),
        // Politique effective pour CE compte (quota personnel inclus).
        backupRequired: settings.backupRequired,
        mfaPolicy: settings.mfaPolicy,
        mfaEnrollmentRequired: await mfaEnrollmentRequired(user.id),
      };
    });

    // ---- Réglages --------------------------------------------------------
    priv.get("/admin/settings", async (req) => {
      const user = requireUser(req);
      const orgId = await requireSiteOwner(user.id);
      const { settings } = await getSiteState();
      const org = await queryOne<{ storage_quota_bytes: number | string | null; name: string }>(
        `SELECT storage_quota_bytes, name FROM organizations WHERE id = $1`,
        [orgId],
      );
      const used = await queryOne<{ used: string | number; files: string | number }>(
        `SELECT COALESCE(SUM(v.size_bytes), 0) AS used, COUNT(v.id) AS files
           FROM node_versions v JOIN nodes n ON n.id = v.node_id WHERE n.org_id = $1`,
        [orgId],
      );
      const roles = await query<{ key: string; name: string }>(
        `SELECT key, name FROM roles WHERE org_id = $1 AND key <> 'owner' ORDER BY name`,
        [orgId],
      );
      const disk = await diskReport(orgId, settings);
      return {
        orgId,
        orgName: org?.name ?? "",
        disk,
        settings,
        globalQuotaBytes: org?.storage_quota_bytes != null ? Number(org.storage_quota_bytes) : null,
        usedBytes: Number(used?.used ?? 0),
        versionCount: Number(used?.files ?? 0),
        roles,
      };
    });

    priv.put("/admin/settings", async (req) => {
      const user = requireUser(req);
      const orgId = await requireSiteOwner(user.id);
      const b = z
        .object({
          settings: siteSettingsSchema,
          globalQuotaBytes: z.number().int().nonnegative().nullable(),
          // Ré-authentification : code TOTP ou code de secours du propriétaire, exigé pour IMPOSER la 2FA.
          mfaProof: z.string().max(32).optional(),
        })
        .parse(req.body);

      const current = await getSiteSettings();
      const role = await queryOne<{ id: string }>(`SELECT id FROM roles WHERE org_id = $1 AND key = $2`, [
        orgId,
        b.settings.defaultRoleKey,
      ]);
      if (!role || b.settings.defaultRoleKey === "owner") {
        throw badRequest("Rôle par défaut invalide (le rôle propriétaire ne peut pas être attribué par défaut).");
      }

      // Garde-fou : ne pas s'enfermer dehors. Imposer la 2FA exige que le
      // propriétaire en ait une lui-même.
      if (b.settings.mfaPolicy === "required") {
        await assertMfaProofForEnforcement(user.id, current.mfaPolicy, b.mfaProof);
        if (!(await hasSecondFactor(user.id))) {
          throw conflict("Activez d'abord votre propre vérification en deux étapes avant de l'imposer à tous.");
        }
      }

      await saveSiteSettings(b.settings, user.id);
      await query(`UPDATE organizations SET storage_quota_bytes = $2, updated_at = now() WHERE id = $1`, [
        orgId,
        b.globalQuotaBytes,
      ]);
      invalidateSiteSettings();
      await audit(orgId, user.id, "site.settings.update", "org", orgId, { settings: b.settings }, req.ip);
      return { ok: true, settings: b.settings, globalQuotaBytes: b.globalQuotaBytes };
    });

    // ---- Utilisateurs ----------------------------------------------------
    priv.get("/admin/users", async (req) => {
      const user = requireUser(req);
      const orgId = await requireSiteOwner(user.id);
      const { settings } = await getSiteState();
      const rows = await query<{
        user_id: string;
        email: string;
        display_name: string;
        user_status: string;
        mem_status: string;
        role_id: string;
        role_key: string;
        quota_bytes: number | string | null;
        mfa_enabled: boolean;
        passkeys: number | string;
        used: number | string;
        sessions: number | string;
        last_seen: string | null;
        joined_at: string;
        is_owner: boolean;
      }>(
        `SELECT u.id AS user_id, u.email, u.display_name, u.status AS user_status, m.status AS mem_status,
                m.role_id, r.key AS role_key, m.quota_bytes, u.mfa_enabled,
                (SELECT COUNT(*) FROM webauthn_credentials w WHERE w.user_id = u.id) AS passkeys,
                COALESCE((SELECT SUM(v.size_bytes) FROM node_versions v JOIN nodes n ON n.id = v.node_id
                           WHERE n.org_id = m.org_id AND n.owner_user_id = u.id), 0) AS used,
                (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.revoked_at IS NULL
                    AND s.expires_at > now()) AS sessions,
                (SELECT MAX(COALESCE(s.last_seen_at, s.created_at)) FROM sessions s WHERE s.user_id = u.id) AS last_seen,
                m.joined_at, (o.owner_user_id = u.id) AS is_owner
           FROM memberships m
           JOIN users u ON u.id = m.user_id
           JOIN roles r ON r.id = m.role_id
           JOIN organizations o ON o.id = m.org_id
          WHERE m.org_id = $1
          ORDER BY u.display_name, u.email`,
        [orgId],
      );
      return {
        defaultQuotaBytes: settings.perUserQuotaBytes,
        users: rows.map((r) => ({
          userId: r.user_id,
          email: r.email,
          displayName: r.display_name,
          suspended: r.user_status === "suspended" || r.mem_status === "suspended",
          roleId: r.role_id,
          roleKey: r.role_key,
          quotaBytes: r.quota_bytes != null ? Number(r.quota_bytes) : null,
          usedBytes: Number(r.used),
          mfa: r.mfa_enabled || Number(r.passkeys) > 0,
          activeSessions: Number(r.sessions),
          lastSeenAt: r.last_seen,
          joinedAt: r.joined_at,
          isOwner: r.is_owner,
        })),
      };
    });

    priv.patch("/admin/users/:userId", async (req) => {
      const actor = requireUser(req);
      const orgId = await requireSiteOwner(actor.id);
      const { userId } = idParam.parse(req.params);
      const b = z
        .object({
          suspended: z.boolean().optional(),
          roleId: z.string().uuid().optional(),
          quotaBytes: z.number().int().nonnegative().nullable().optional(),
        })
        .parse(req.body);

      const mem = await queryOne<{ id: string }>(`SELECT id FROM memberships WHERE org_id = $1 AND user_id = $2`, [
        orgId,
        userId,
      ]);
      if (!mem) throw notFound("Utilisateur introuvable dans ce Drive.");
      const targetIsOwner =
        (
          await queryOne<{ ok: boolean }>(`SELECT owner_user_id = $2 AS ok FROM organizations WHERE id = $1`, [
            orgId,
            userId,
          ])
        )?.ok === true;
      if ((b.suspended !== undefined || b.roleId !== undefined) && targetIsOwner) {
        throw conflict("Le propriétaire du Drive ne peut être ni suspendu ni rétrogradé.");
      }

      if (b.roleId !== undefined) {
        const role = await queryOne<{ key: string }>(`SELECT key FROM roles WHERE id = $1 AND org_id = $2`, [
          b.roleId,
          orgId,
        ]);
        if (!role) throw badRequest("Rôle invalide pour ce Drive.");
        if (role.key === "owner") throw badRequest("Utilisez le transfert de propriété pour désigner un propriétaire.");
        await query(`UPDATE memberships SET role_id = $3 WHERE org_id = $1 AND user_id = $2`, [
          orgId,
          userId,
          b.roleId,
        ]);
        await audit(orgId, actor.id, "member.role.assign", "membership", mem.id, { userId, roleId: b.roleId }, req.ip);
      }
      if (b.quotaBytes !== undefined) {
        await query(`UPDATE memberships SET quota_bytes = $3 WHERE org_id = $1 AND user_id = $2`, [
          orgId,
          userId,
          b.quotaBytes,
        ]);
        await audit(orgId, actor.id, "site.user.quota", "user", userId, { quotaBytes: b.quotaBytes }, req.ip);
      }
      if (b.suspended !== undefined) {
        await withTx(async (c) => {
          await c.query(`UPDATE users SET status = $2, updated_at = now() WHERE id = $1 AND status <> 'deleted'`, [
            userId,
            b.suspended ? "suspended" : "active",
          ]);
          await c.query(`UPDATE memberships SET status = $3 WHERE org_id = $1 AND user_id = $2`, [
            orgId,
            userId,
            b.suspended ? "suspended" : "active",
          ]);
          if (b.suspended) {
            await c.query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
          }
        });
        await audit(
          orgId,
          actor.id,
          b.suspended ? "site.user.suspend" : "site.user.reactivate",
          "user",
          userId,
          {},
          req.ip,
        );
      }
      return { ok: true, usedBytes: await userUsageBytes(orgId, userId) };
    });

    // ---- Réinitialisation de mot de passe (lien à usage unique) ------------
    priv.post("/admin/users/:userId/password-reset", async (req) => {
      const actor = requireUser(req);
      const orgId = await requireSiteOwner(actor.id);
      const { userId } = idParam.parse(req.params);
      if (userId === actor.id)
        throw conflict("Pour votre propre compte, utilisez « Changer de mot de passe » (menu Sécurité).");
      const mem = await queryOne<{ id: string }>(`SELECT id FROM memberships WHERE org_id = $1 AND user_id = $2`, [
        orgId,
        userId,
      ]);
      if (!mem) throw notFound("Utilisateur introuvable dans ce Drive.");
      const token = randomToken(32);
      const expiresAt = new Date(Date.now() + RESET_TTL_MS);
      // Un seul lien valable à la fois par utilisateur.
      await query(`UPDATE password_resets SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`, [userId]);
      await query(`INSERT INTO password_resets (user_id, token_hash, created_by, expires_at) VALUES ($1,$2,$3,$4)`, [
        userId,
        sha256Hex(token),
        actor.id,
        expiresAt,
      ]);
      await audit(orgId, actor.id, "site.user.password_reset", "user", userId, { expiresAt }, req.ip);
      return { token, expiresAt };
    });

    priv.post("/admin/users/:userId/revoke-sessions", async (req) => {
      const actor = requireUser(req);
      const orgId = await requireSiteOwner(actor.id);
      const { userId } = idParam.parse(req.params);
      const mem = await queryOne<{ id: string }>(`SELECT id FROM memberships WHERE org_id = $1 AND user_id = $2`, [
        orgId,
        userId,
      ]);
      if (!mem) throw notFound("Utilisateur introuvable dans ce Drive.");
      await query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
      await audit(orgId, actor.id, "site.user.revoke_sessions", "user", userId, {}, req.ip);
      return { ok: true };
    });
  });
}
