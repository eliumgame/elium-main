-- Verrouillage du second facteur PAR COMPTE (audit A1) : sans compteur, le TOTP
-- (3 codes valides sur 10^6) se forçait à 20 essais/min/IP avec un mfaToken
-- réutilisable 5 minutes. Chaque vérification réserve d'abord un essai
-- (mfa_failed_count + 1, atomique) ; au-delà du seuil, le compte refuse toute
-- vérification du second facteur jusqu'à mfa_locked_until. Une réussite remet
-- le compteur à zéro.
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_failed_count INT NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_locked_until TIMESTAMPTZ;
