-- La recherche de réemploi sur une route publique doit utiliser un index.
-- Les anciennes sessions peuvent déjà avoir accumulé un historique très long.
UPDATE sessions
   SET superseded_refresh_token_hashes =
       superseded_refresh_token_hashes[
         greatest(1, cardinality(superseded_refresh_token_hashes) - 19):
       ]
 WHERE cardinality(superseded_refresh_token_hashes) > 20;

CREATE INDEX IF NOT EXISTS idx_sessions_superseded_refresh_active
  ON sessions USING gin (superseded_refresh_token_hashes)
  WHERE revoked_at IS NULL;
