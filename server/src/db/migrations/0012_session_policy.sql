-- Détection de réemploi MULTI-SAUTS du refresh token : 0011 ne gardait que le
-- hash immédiatement précédent, donc un rejeu de T0 après T0 -> T1 -> T2
-- échouait (bien) mais sans déclencher la détection de compromission, car T0
-- n'était déjà plus dans previous_refresh_token_hash (qui ne contenait que T1).
-- Un historique borné couvre un réemploi différé de plusieurs rotations.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS superseded_refresh_token_hashes TEXT[] NOT NULL DEFAULT '{}';
DROP INDEX IF EXISTS idx_sessions_previous_refresh_token_hash;
ALTER TABLE sessions DROP COLUMN IF EXISTS previous_refresh_token_hash;

-- Époque de révocation des access tokens : un jeton d'accès émis AVANT cette
-- date est refusé même s'il n'est pas encore expiré naturellement (voir
-- middleware/auth.ts). Sans ça, réinitialiser le mot de passe ou le changer ne
-- révoquait que les refresh tokens — un access token déjà émis (jusqu'à
-- ACCESS_TOKEN_TTL_SECONDS, 900 s par défaut) restait utilisable tel quel.
ALTER TABLE users ADD COLUMN IF NOT EXISTS token_epoch TIMESTAMPTZ NOT NULL DEFAULT now();
