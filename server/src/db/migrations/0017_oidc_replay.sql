-- Bounded one-use OIDC assertions, shared across instances.
CREATE TABLE IF NOT EXISTS oidc_used_assertions (
  token_hash TEXT PRIMARY KEY,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_oidc_assertion_expiry ON oidc_used_assertions (expires_at);
