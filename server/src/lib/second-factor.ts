/**
 * Vérification d'un second facteur : code TOTP à 6 chiffres OU code de secours à
 * usage unique (consommé). Partagé par la connexion, la gestion de la 2FA et la
 * ré-authentification du propriétaire (portail).
 *
 * Verrouillage PAR COMPTE (audit A1) : la limite de débit est par IP et le jeton
 * MFA vaut 5 minutes, donc sans compteur un attaquant qui connaît le mot de passe
 * forçait le TOTP depuis plusieurs IP. Chaque vérification RÉSERVE d'abord un
 * essai (incrément atomique, donc sûr face aux requêtes concurrentes) ; au
 * `MFA_MAX_FAILURES`-ième essai sans réussite, le compte refuse toute vérification
 * du second facteur pendant `MFA_LOCK_SECONDS`, quel que soit le jeton ou l'IP.
 * Une réussite remet le compteur à zéro.
 */
import { queryOne } from "../db/pool.js";
import { decryptServerSecret, backupCodeHash } from "./crypto-server.js";
import { matchTotpStep } from "./totp.js";
import { ApiError } from "./errors.js";
import { audit } from "./audit.js";

/** Usage du jeton intermédiaire émis entre le mot de passe (ou le SSO) et le second facteur. */
export const MFA_LOGIN_PURPOSE = "mfa-login";

/** Essais consécutifs sans réussite avant verrouillage du second facteur du compte. */
export const MFA_MAX_FAILURES = 5;
/** Durée du verrouillage (secondes). 5 essais / 15 min ≈ 480 essais par jour au plus. */
export const MFA_LOCK_SECONDS = 15 * 60;

/** Erreur levée quand le second facteur du compte est temporairement verrouillé. */
export function mfaLockedError(): ApiError {
  return new ApiError(
    429,
    "mfa_locked",
    "Trop de codes de vérification incorrects : le second facteur de ce compte est bloqué pendant 15 minutes.",
  );
}

/** « ABCD EFGH », « abcdefgh », « ABCD-EFGH » → « abcd-efgh » (forme stockée). */
export function normalizeBackupCode(raw: string): string {
  const s = raw.replace(/[\s-]/g, "").toLowerCase();
  return /^[a-z2-7]{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4)}` : raw.replace(/\s/g, "").toLowerCase();
}

/**
 * Réserve un essai : incrémente le compteur (ou le réarme si un verrouillage précédent est
 * échu) et pose le verrou quand le seuil est atteint. Ne renvoie rien si le compte est
 * DÉJÀ verrouillé → l'appelant refuse sans même évaluer le code.
 */
async function reserveAttempt(userId: string): Promise<{ count: number; locked: boolean } | null> {
  return queryOne<{ count: number; locked: boolean }>(
    `UPDATE users
        SET mfa_failed_count = CASE WHEN mfa_locked_until <= now() THEN 1 ELSE mfa_failed_count + 1 END,
            mfa_locked_until = CASE
              WHEN (CASE WHEN mfa_locked_until <= now() THEN 1 ELSE mfa_failed_count + 1 END) >= $2
                THEN now() + make_interval(secs => $3)
              WHEN mfa_locked_until <= now() THEN NULL
              ELSE mfa_locked_until
            END
      WHERE id = $1 AND (mfa_locked_until IS NULL OR mfa_locked_until <= now())
      RETURNING mfa_failed_count AS count, (mfa_locked_until IS NOT NULL) AS locked`,
    [userId, MFA_MAX_FAILURES, MFA_LOCK_SECONDS],
  );
}

async function resetAttempts(userId: string): Promise<void> {
  await queryOne(`UPDATE users SET mfa_failed_count = 0, mfa_locked_until = NULL WHERE id = $1 RETURNING id`, [userId]);
}

/** Vérifie le code sans tenir compte du verrouillage (anti-rejeu TOTP + codes de secours brûlés). */
async function checkCode(userId: string, code: string): Promise<boolean> {
  const norm = code.replace(/\s/g, "");
  const u = await queryOne<{ mfa_secret_enc: Buffer | null; mfa_secret_nonce: Buffer | null }>(
    `SELECT mfa_secret_enc, mfa_secret_nonce FROM users WHERE id = $1 AND mfa_enabled = true`,
    [userId],
  );
  if (u?.mfa_secret_enc && u.mfa_secret_nonce && /^\d{6}$/.test(norm)) {
    try {
      const secret = decryptServerSecret(u.mfa_secret_enc, u.mfa_secret_nonce);
      const step = matchTotpStep(secret, norm);
      if (step !== null) {
        // Anti-rejeu : le pas ne doit pas être ≤ au dernier consommé (UPDATE atomique).
        const fresh = await queryOne<{ id: string }>(
          `UPDATE users SET mfa_last_step = $2
            WHERE id = $1 AND (mfa_last_step IS NULL OR mfa_last_step < $2)
            RETURNING id`,
          [userId, step],
        );
        if (fresh) return true;
        return false; // code déjà consommé : pas de repli sur les codes de secours
      }
    } catch {
      // Secret illisible (TOKEN_SECRET changé depuis l'enrôlement) : on retombe sur
      // les codes de secours, seule issue restante avant un verrouillage définitif.
    }
  }
  // Code de secours : usage unique, comparé par empreinte puis brûlé.
  const used = await queryOne<{ id: string }>(
    `UPDATE mfa_backup_codes SET used_at = now()
      WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL
      RETURNING id`,
    [userId, backupCodeHash(userId, normalizeBackupCode(norm))],
  );
  return !!used;
}

/**
 * Vrai si le code est valide. Lève `mfa_locked` (429) si le second facteur du compte est
 * verrouillé par trop d'échecs récents — y compris pour un code juste, sinon le verrou
 * n'empêcherait pas le forçage.
 */
export async function verifySecondFactor(userId: string, code: string, ip = ""): Promise<boolean> {
  const attempt = await reserveAttempt(userId);
  if (!attempt) throw mfaLockedError();
  const ok = await checkCode(userId, code);
  if (ok) {
    await resetAttempts(userId);
    return true;
  }
  if (attempt.locked) {
    await audit(null, userId, "auth.mfa.locked", "user", userId, { failures: attempt.count }, ip);
  }
  return false;
}
