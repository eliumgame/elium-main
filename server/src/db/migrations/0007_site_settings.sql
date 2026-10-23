-- Portail du propriétaire : réglages du déploiement (un VPS = un Drive).
--
-- Table singleton (id = 1) : `org_id` désigne l'organisation « du site » (la
-- première créée — son propriétaire est le propriétaire du déploiement),
-- `settings` porte la politique réglable depuis l'interface (inscription,
-- rôle par défaut, quotas, rétention, sécurité). Les valeurs absentes
-- retombent sur les défauts de config.ts.
CREATE TABLE IF NOT EXISTS site_settings (
  id         SMALLINT PRIMARY KEY CHECK (id = 1),
  org_id     UUID REFERENCES organizations(id) ON DELETE SET NULL,
  settings   JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO site_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Déploiement existant : l'organisation la plus ancienne devient celle du site.
UPDATE site_settings
   SET org_id = (SELECT id FROM organizations ORDER BY created_at ASC LIMIT 1)
 WHERE id = 1 AND org_id IS NULL;

-- Quota individuel (NULL = valeur par défaut du site).
ALTER TABLE memberships ADD COLUMN IF NOT EXISTS quota_bytes BIGINT;

-- Dernière activité d'une session (gestion des appareils).
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;
