-- Détection de réemploi du refresh token après rotation (voir POST /api/auth/refresh).
-- On garde le hash qui vient d'être remplacé : un jeton présenté qui correspond à ce
-- hash plutôt qu'au hash courant est un jeton DÉJÀ tourné qu'on retente (concurrence
-- ou vol) — distinct d'un jeton simplement inconnu/expiré. Index partiel : la grande
-- majorité des lignes n'ont pas (encore) de hash précédent.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS previous_refresh_token_hash TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_previous_refresh_token_hash
  ON sessions (previous_refresh_token_hash) WHERE previous_refresh_token_hash IS NOT NULL;
