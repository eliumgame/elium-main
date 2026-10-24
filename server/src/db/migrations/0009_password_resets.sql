-- Réinitialisation de mot de passe déclenchée par le propriétaire du Drive.
-- Lien à usage unique et à durée limitée ; seul l'empreinte du jeton est stockée.
-- Le serveur ne peut pas « changer » un mot de passe (clés chiffrées par celui-ci) :
-- l'utilisateur génère un NOUVEAU jeu de clés, et le propriétaire rétablit ses accès
-- via la clé d'organisation (recouvrement).
CREATE TABLE IF NOT EXISTS password_resets (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets (user_id);
