-- Approche A — signature à distance par lien cloud (Tranche 0).
--
-- Le circuit de signature (parties / ordre / statut) vit côté serveur ici, en
-- plus des liens de partage. L'artefact signé revient via une écriture-retour
-- ANONYME scellée par token (POST /api/links/:token/sign) et est stocké comme
-- une node_version (aucune écriture-retour anonyme n'existait auparavant : toutes
-- les routes de lien étaient GET). Zero-knowledge préservé : le signataire
-- re-chiffre l'artefact sous la CEK qu'il détient déjà via le fragment d'URL ;
-- le serveur ne stocke que du ciphertext + un statut.
--
-- Idempotent (CREATE ... IF NOT EXISTS + ADD COLUMN IF NOT EXISTS), comme les
-- autres migrations : re-jouable sans effet sur une base déjà à jour.

-- Capacité « signer » portée par un lien de partage. C'est le token du lien (et
-- non un rôle de compte) qui autorise l'écriture-retour, car le signataire n'a
-- pas de compte.
ALTER TABLE share_links ADD COLUMN IF NOT EXISTS can_sign BOOLEAN NOT NULL DEFAULT false;

-- Une demande de signature portant sur un nœud (fichier). En Tranche 0 elle a
-- une seule partie ; le modèle « circuit » (multi-parties + ordre) est prévu par
-- signature_request_parties dès maintenant pour éviter une migration cassante.
CREATE TABLE IF NOT EXISTS signature_requests (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  node_id       UUID NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  created_by    UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status        TEXT NOT NULL DEFAULT 'pending',   -- pending | completed | cancelled
  ordered       BOOLEAN NOT NULL DEFAULT false,    -- signature séquentielle (Tranche 2)
  deadline      TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_signature_requests_node ON signature_requests(node_id);
CREATE INDEX IF NOT EXISTS idx_signature_requests_org ON signature_requests(org_id);

-- Une partie = un signataire attendu, adossé à un lien scellé « can_sign ».
-- `signer_fpr` = empreinte de la clé publique Ed25519 du signataire (attribution
-- côté émetteur via le carnet de confiance) ; PII faible, jamais la clé privée.
-- `submission_version_id` pointe la node_version produite par cette signature.
CREATE TABLE IF NOT EXISTS signature_request_parties (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id            UUID NOT NULL REFERENCES signature_requests(id) ON DELETE CASCADE,
  party_index           INTEGER NOT NULL,
  label                 TEXT,               -- libellé optionnel fourni par l'émetteur (clair)
  link_id               UUID NOT NULL REFERENCES share_links(id) ON DELETE CASCADE,
  status                TEXT NOT NULL DEFAULT 'pending',   -- pending | signed | declined
  signer_fpr            TEXT,
  submission_version_id UUID REFERENCES node_versions(id) ON DELETE SET NULL,
  signed_at             TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (request_id, party_index)
);
CREATE INDEX IF NOT EXISTS idx_srp_request ON signature_request_parties(request_id);
-- Un lien de signature dessert exactement une partie.
CREATE UNIQUE INDEX IF NOT EXISTS idx_srp_link ON signature_request_parties(link_id);
