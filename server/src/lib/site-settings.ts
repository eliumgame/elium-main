/**
 * Réglages du déploiement (« portail du propriétaire »). Un VPS = un Drive : la
 * table `site_settings` (singleton) désigne l'organisation du site et porte la
 * politique réglable depuis l'interface. Lecture mise en cache quelques secondes
 * (elle est consultée par `authenticate` à chaque requête quand la 2FA est
 * obligatoire) ; toute écriture invalide le cache.
 *
 * Les défauts viennent de config.ts (variables d'environnement) ; les valeurs
 * enregistrées en base les remplacent champ par champ.
 */
import { z } from "zod";
import { config } from "../config.js";
import { query, queryOne } from "../db/pool.js";
import { forbidden, insufficientStorage } from "./errors.js";
import { sha256Hex } from "./crypto-server.js";
import { hasWebauthn } from "./webauthn.js";

export const siteSettingsSchema = z.object({
  /** open = inscription libre ; invite = sur invitation du propriétaire ; closed = personne ne s'inscrit. */
  signupMode: z.enum(["open", "closed", "invite"]),
  /** Clé du rôle donné aux nouveaux inscrits (jamais « owner »). */
  defaultRoleKey: z.string().min(1).max(60),
  /** Quota par utilisateur en octets (null = illimité, sauf quota individuel). */
  perUserQuotaBytes: z.number().int().nonnegative().nullable(),
  /** Sauvegarde automatique du poste vers le Drive : imposée aux utilisateurs. */
  backupRequired: z.boolean(),
  /** Anciennes versions (dont sauvegardes) conservées N jours ; 0 = pour toujours. */
  versionRetentionDays: z.number().int().min(0).max(3650),
  /** Éléments de la corbeille purgés après N jours. */
  trashRetentionDays: z.number().int().min(1).max(3650),
  /** « optional » ou « required » : 2FA obligatoire pour tous les comptes. */
  mfaPolicy: z.enum(["optional", "required"]),
  /** Longueur minimale du mot de passe (appliquée à la création/changement, côté client). */
  passwordMinLength: z.number().int().min(8).max(128),
  /** Les membres simples peuvent créer leur espace privé à la racine du Drive. */
  membersCanCreateSpaces: z.boolean(),
  /** Nom affiché sur l'écran de connexion. */
  siteName: z.string().max(80),
});
export type SiteSettings = z.infer<typeof siteSettingsSchema>;

export function defaultSiteSettings(): SiteSettings {
  const d = config.site.defaults;
  return {
    signupMode: d.signupMode,
    defaultRoleKey: d.defaultRoleKey,
    perUserQuotaBytes: null,
    backupRequired: false,
    versionRetentionDays: 0,
    trashRetentionDays: 30,
    mfaPolicy: d.mfaPolicy,
    passwordMinLength: d.passwordMinLength,
    // Drive partagé (un VPS = un Drive) : chaque membre a son espace privé par défaut.
    membersCanCreateSpaces: config.site.singleDrive,
    siteName: "",
  };
}

export interface SiteState {
  orgId: string | null;
  settings: SiteSettings;
}

const TTL_MS = 5000;
let cache: { at: number; state: SiteState } | null = null;

export function invalidateSiteSettings(): void {
  cache = null;
}

export async function getSiteState(): Promise<SiteState> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.state;
  let row: { org_id: string | null; settings: unknown } | null = null;
  try {
    row = await queryOne<{ org_id: string | null; settings: unknown }>(
      `SELECT org_id, settings FROM site_settings WHERE id = 1`,
    );
  } catch (err) {
    // Migration pas encore appliquée : on retombe sur les défauts.
    if ((err as { code?: string }).code !== "42P01") throw err;
  }
  const merged = siteSettingsSchema.safeParse({
    ...defaultSiteSettings(),
    ...((row?.settings as object | null) ?? {}),
  });
  const state: SiteState = {
    orgId: row?.org_id ?? null,
    settings: merged.success ? merged.data : defaultSiteSettings(),
  };
  cache = { at: Date.now(), state };
  return state;
}

export async function getSiteSettings(): Promise<SiteSettings> {
  return (await getSiteState()).settings;
}

export async function saveSiteSettings(settings: SiteSettings, updatedBy: string): Promise<void> {
  await query(
    `INSERT INTO site_settings (id, settings, updated_by, updated_at) VALUES (1, $1, $2, now())
     ON CONFLICT (id) DO UPDATE SET settings = EXCLUDED.settings, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [JSON.stringify(settings), updatedBy],
  );
  invalidateSiteSettings();
}

/** Désigne `orgId` comme organisation du site si aucune ne l'est encore. */
export async function claimSiteOrg(orgId: string): Promise<void> {
  await query(
    `INSERT INTO site_settings (id, org_id) VALUES (1, $1)
     ON CONFLICT (id) DO UPDATE SET org_id = COALESCE(site_settings.org_id, EXCLUDED.org_id)`,
    [orgId],
  );
  invalidateSiteSettings();
}

/** Le compte a-t-il un second facteur (TOTP ou clé d'accès) ? */
export async function hasSecondFactor(userId: string): Promise<boolean> {
  const u = await queryOne<{ mfa_enabled: boolean }>(`SELECT mfa_enabled FROM users WHERE id = $1`, [userId]);
  return u?.mfa_enabled === true || (await hasWebauthn(userId));
}

/** Le Drive impose la 2FA et ce compte n'en a pas encore : il doit l'activer. */
export async function mfaEnrollmentRequired(userId: string): Promise<boolean> {
  return (await getSiteSettings()).mfaPolicy === "required" && !(await hasSecondFactor(userId));
}

/** Le propriétaire du déploiement = propriétaire de l'organisation du site. */
export async function isSiteOwner(userId: string): Promise<boolean> {
  const { orgId } = await getSiteState();
  if (!orgId) return false;
  const row = await queryOne<{ owner_user_id: string }>(`SELECT owner_user_id FROM organizations WHERE id = $1`, [
    orgId,
  ]);
  return row?.owner_user_id === userId;
}

export async function requireSiteOwner(userId: string): Promise<string> {
  const { orgId } = await getSiteState();
  if (!orgId || !(await isSiteOwner(userId))) {
    throw forbidden("Réservé au propriétaire du déploiement.");
  }
  return orgId;
}

/**
 * Contrôle d'inscription. Appelé par POST /auth/register avant toute création.
 *  - Aucun Drive encore (pas d'organisation du site) : inscription du futur
 *    propriétaire, restreinte à OWNER_EMAIL s'il est défini.
 *  - Sinon : selon `signupMode` ; « invite » exige un jeton d'invitation valide
 *    émis pour cet e-mail.
 */
export async function assertSignupAllowed(email: string, inviteToken?: string): Promise<void> {
  const { orgId, settings } = await getSiteState();
  if (!orgId) {
    const owner = config.site.ownerEmail;
    if (owner && owner !== email.trim().toLowerCase()) {
      throw forbidden("Ce Drive n'attend pas encore son propriétaire : seul le compte prévu peut s'inscrire.");
    }
    return;
  }
  if (settings.signupMode === "open") return;
  if (settings.signupMode === "closed") {
    throw forbidden("Les inscriptions sont fermées sur ce Drive. Contactez son propriétaire.");
  }
  if (!inviteToken) {
    throw forbidden("L'inscription se fait sur invitation. Demandez un lien d'invitation au propriétaire.");
  }
  const inv = await queryOne<{ id: string }>(
    `SELECT id FROM invites
      WHERE token_hash = $1 AND org_id = $2 AND lower(email::text) = lower($3)
        AND accepted_at IS NULL AND expires_at > now()`,
    [sha256Hex(inviteToken), orgId, email],
  );
  if (!inv) throw forbidden("Invitation invalide, expirée ou destinée à une autre adresse.");
}

/**
 * Inscription libre : le nouvel inscrit devient « membre simple » de l'organisation
 * du site avec le rôle par défaut (jamais « owner »). Sans effet en mode
 * invitation (le jeton d'invitation porte déjà le rôle) ou sans Drive.
 */
export async function autoJoinSiteOrg(userId: string): Promise<void> {
  const { orgId, settings } = await getSiteState();
  if (!orgId || settings.signupMode !== "open") return;
  const key = settings.defaultRoleKey === "owner" ? "editor" : settings.defaultRoleKey;
  const role = await queryOne<{ id: string }>(`SELECT id FROM roles WHERE org_id = $1 AND key = $2`, [orgId, key]);
  if (!role) return;
  await query(
    `INSERT INTO memberships (org_id, user_id, role_id, status) VALUES ($1,$2,$3,'active')
     ON CONFLICT (org_id, user_id) DO NOTHING`,
    [orgId, userId, role.id],
  );
}

/** Octets consommés par un utilisateur (versions de ses nœuds) dans l'org. */
export async function userUsageBytes(orgId: string, userId: string): Promise<number> {
  const row = await queryOne<{ used: string | number }>(
    `SELECT COALESCE(SUM(v.size_bytes), 0) AS used
       FROM node_versions v JOIN nodes n ON n.id = v.node_id
      WHERE n.org_id = $1 AND n.owner_user_id = $2`,
    [orgId, userId],
  );
  return Number(row?.used ?? 0);
}

/** Quota effectif d'un utilisateur : individuel, sinon défaut du site (null = illimité). */
export async function effectiveUserQuota(orgId: string, userId: string): Promise<number | null> {
  const m = await queryOne<{ quota_bytes: number | string | null }>(
    `SELECT quota_bytes FROM memberships WHERE org_id = $1 AND user_id = $2`,
    [orgId, userId],
  );
  if (m?.quota_bytes != null) return Number(m.quota_bytes);
  return (await getSiteSettings()).perUserQuotaBytes;
}

/** Refuse (507) si `addBytes` fait dépasser le quota de `ownerUserId`. */
export async function assertUserQuota(orgId: string, ownerUserId: string, addBytes: number): Promise<void> {
  const quota = await effectiveUserQuota(orgId, ownerUserId);
  if (quota == null) return;
  const used = await userUsageBytes(orgId, ownerUserId);
  if (used + addBytes > quota) {
    throw insufficientStorage(`Quota personnel atteint : ${used + addBytes} octets requis pour ${quota} alloués.`);
  }
}

/** Dans un déploiement à Drive unique, refuse la création d'une 2e organisation. */
export async function assertCanCreateOrg(): Promise<void> {
  if (!config.site.singleDrive) return;
  const { orgId } = await getSiteState();
  if (orgId) throw forbidden("Ce déploiement n'héberge qu'un seul Drive : l'organisation existe déjà.");
}
