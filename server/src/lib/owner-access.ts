/**
 * Procédure de secours : rendre l'accès à un compte bloqué par sa 2FA (téléphone
 * perdu, codes de secours perdus) — typiquement le propriétaire qui s'est enfermé
 * dehors après avoir imposé la 2FA. Appelée par la ligne de commande
 * `scripts/reset-owner-access.ts` : elle exige un accès au serveur, pas une session.
 *
 * Elle NE TOUCHE PAS aux clés ni au mot de passe (zéro connaissance) : elle
 * désactive seulement le second facteur, remet la politique 2FA à « facultative »
 * si elle était imposée, et coupe les sessions du compte. Tout est tracé dans le
 * journal d'audit chaîné.
 */
import { queryOne, withTx } from "../db/pool.js";
import { audit } from "./audit.js";
import { getSiteState, saveSiteSettings } from "./site-settings.js";

export interface ResetOutcome {
  userId: string;
  email: string;
  hadTotp: boolean;
  passkeysRemoved: number;
  policyReset: boolean;
  orgId: string | null;
}

export async function resetOwnerAccess(email: string): Promise<ResetOutcome> {
  const user = await queryOne<{ id: string; email: string; mfa_enabled: boolean; status: string }>(
    `SELECT id, email, mfa_enabled, status FROM users WHERE email = $1`,
    [email],
  );
  if (!user) throw new Error(`Aucun compte pour « ${email} ».`);
  if (user.status === "deleted") throw new Error("Ce compte est supprimé.");

  let passkeys = 0;
  await withTx(async (c) => {
    await c.query(
      `UPDATE users SET mfa_enabled = false, mfa_secret_enc = NULL, mfa_secret_nonce = NULL,
              mfa_pending_enc = NULL, mfa_pending_nonce = NULL, updated_at = now() WHERE id = $1`,
      [user.id],
    );
    await c.query(`DELETE FROM mfa_backup_codes WHERE user_id = $1`, [user.id]);
    const del = await c.query(`DELETE FROM webauthn_credentials WHERE user_id = $1`, [user.id]);
    passkeys = del.rowCount ?? 0;
    await c.query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [user.id]);
  });

  // La politique « 2FA obligatoire » doit retomber, sinon le compte serait aussitôt
  // renvoyé vers l'enrôlement forcé (acceptable, mais pas de piège pour le propriétaire).
  const { orgId, settings } = await getSiteState();
  let policyReset = false;
  if (settings.mfaPolicy === "required") {
    await saveSiteSettings({ ...settings, mfaPolicy: "optional" }, user.id);
    policyReset = true;
  }

  await audit(
    orgId,
    null,
    "owner.access.reset",
    "user",
    user.id,
    { email: user.email, via: "cli", hadTotp: user.mfa_enabled, passkeysRemoved: passkeys, policyReset },
    "",
  );
  return {
    userId: user.id,
    email: user.email,
    hadTotp: user.mfa_enabled,
    passkeysRemoved: passkeys,
    policyReset,
    orgId,
  };
}
