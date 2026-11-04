-- Nonces OIDC à usage unique, liés à la requête d'autorisation (stockés hachés, TTL court).
CREATE TABLE IF NOT EXISTS sso_nonces (
  nonce_hash TEXT PRIMARY KEY,
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sso_nonces_expiry ON sso_nonces (expires_at);
