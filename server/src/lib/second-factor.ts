/**
 * Vérification d'un second facteur : code TOTP à 6 chiffres OU code de secours à
 * usage unique (consommé). Partagé par la connexion, la gestion de la 2FA et la
 * ré-authentification du propriétaire (portail).
 */
import { queryOne } from "../db/pool.js";
import { decryptServerSecret, sha256Hex } from "./crypto-server.js";
import { verifyTotp } from "./totp.js";

/** « ABCD EFGH », « abcdefgh », « ABCD-EFGH » → « abcd-efgh » (forme stockée). */
export function normalizeBackupCode(raw: string): string {
  const s = raw.replace(/[\s-]/g, "").toLowerCase();
  return /^[a-z2-7]{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4)}` : raw.replace(/\s/g, "").toLowerCase();
}

export async function verifySecondFactor(userId: string, code: string): Promise<boolean> {
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
      // Secret illisible (TOKEN_SECRET changé depuis l'enrôlement) : on retombe sur
      // les codes de secours, seule issue restante avant un verrouillage définitif.
    }
  }
  // Code de secours : usage unique, comparé par empreinte puis brûlé.
  const used = await queryOne<{ id: string }>(
    `UPDATE mfa_backup_codes SET used_at = now()
      WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL
      RETURNING id`,
    [userId, sha256Hex(normalizeBackupCode(norm))],
  );
  return !!used;
}
