-- Code d'activation à usage unique (amorçage d'un déploiement neuf).
-- On ne stocke que l'empreinte ; le code lui-même n'apparaît que dans les journaux
-- du serveur au démarrage (voir lib/activation.ts).
CREATE TABLE IF NOT EXISTS site_activation (
  id          SMALLINT PRIMARY KEY CHECK (id = 1),
  code_hash   TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ
);
