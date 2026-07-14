-- ===========================================================================
-- Elium Drive Entreprise — Postgres schema (zero-knowledge / E2E).
--
-- Golden rule: this database stores ONLY ciphertext, wrapped keys, and
-- authorization metadata. No plaintext content, no passwords, no private keys,
-- no plaintext file names. `*_encrypted` columns hold AES-256-GCM ciphertext
-- (bytea) and their `*_nonce` the 12-byte IV. `wrapped_*` columns hold an
-- ECDH-ES multi-recipient envelope (see web-studio/src/crypto/recipients.ts).
--
-- Idempotent: safe to run repeatedly (CREATE ... IF NOT EXISTS + guarded DO
-- blocks for enum-like check constraints).
-- ===========================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS citext;      -- case-insensitive email

-- --- Users -----------------------------------------------------------------
-- A user is an identity with two public keys. Private keys never touch the
-- server; only the client-encrypted `key_bundle` (wrapped by the password-
-- derived master key) is stored, so a user can log in from any device.
CREATE TABLE IF NOT EXISTS users (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email              CITEXT UNIQUE NOT NULL,
  display_name       TEXT NOT NULL DEFAULT '',
  -- public keys (hex). Ed25519 = identity/auth, P-256 = key-wrapping recipient.
  ed25519_public_hex TEXT NOT NULL,
  p256_public_hex    TEXT NOT NULL,
  fingerprint        TEXT NOT NULL,               -- sha256(ed25519_public_hex)
  -- login verifier: server stores scrypt(authSecret, auth_salt); never the pw.
  auth_verifier      TEXT NOT NULL,
  auth_salt          TEXT NOT NULL,
  -- client-side Argon2id parameters used to derive authSecret + masterKey from
  -- the password. Public (not secret): returned at prelogin so a new device can
  -- recompute the derivation. Never lets the server derive keys (distinct info).
  kdf_salt           TEXT NOT NULL,
  kdf_params         JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- client-side-encrypted bundle of private keys (JSON string, opaque to us).
  key_bundle         JSONB NOT NULL,
  status             TEXT NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active','suspended','deleted')),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_users_fpr ON users (fingerprint);

-- --- Organizations ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS organizations (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name             TEXT NOT NULL,
  slug             TEXT UNIQUE NOT NULL,
  owner_user_id    UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  -- org recovery keypair: public stored, private wrapped to admins (below).
  org_public_hex   TEXT NOT NULL,
  settings         JSONB NOT NULL DEFAULT '{}'::jsonb,
  storage_quota_bytes BIGINT,                      -- NULL = unlimited
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The org private key, wrapped to each admin's P-256 public key. Any admin can
-- unwrap it and thereby recover any org node. The server never holds it.
CREATE TABLE IF NOT EXISTS org_recovery_keys (
  org_id           UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  admin_user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wrapped_org_private JSONB NOT NULL,              -- recipients envelope
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, admin_user_id)
);

-- --- Roles (system + custom, per org) --------------------------------------
-- Permissions are an array of permission keys (see rbac/permissions.ts).
CREATE TABLE IF NOT EXISTS roles (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID REFERENCES organizations(id) ON DELETE CASCADE, -- NULL = global template
  key          TEXT NOT NULL,                      -- e.g. 'owner','editor','custom-abc'
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  color        TEXT NOT NULL DEFAULT '#1d4ed8',
  is_system    BOOLEAN NOT NULL DEFAULT false,     -- system roles are not deletable
  permissions  TEXT[] NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, key)
);
CREATE INDEX IF NOT EXISTS idx_roles_org ON roles (org_id);
-- Global templates have org_id NULL; SQL NULLs are pairwise distinct so the
-- UNIQUE above never guards them. This partial index makes the template seed
-- idempotent (see migrate.ts ON CONFLICT target).
CREATE UNIQUE INDEX IF NOT EXISTS uq_roles_global_key ON roles (key) WHERE org_id IS NULL;

-- --- Memberships (user <-> org, with an org-level role) --------------------
CREATE TABLE IF NOT EXISTS memberships (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id    UUID NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  status     TEXT NOT NULL DEFAULT 'active'
               CHECK (status IN ('active','invited','suspended')),
  joined_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships (user_id);
CREATE INDEX IF NOT EXISTS idx_memberships_org ON memberships (org_id);

-- --- Groups / teams (cryptographic principals) -----------------------------
-- A group has its own P-256 keypair. Sharing to a group wraps to group_public;
-- the group private key is wrapped to each member (group_members below).
CREATE TABLE IF NOT EXISTS groups (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  description      TEXT NOT NULL DEFAULT '',
  color            TEXT NOT NULL DEFAULT '#0ea5e9',
  group_public_hex TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_groups_org ON groups (org_id);

CREATE TABLE IF NOT EXISTS group_members (
  group_id             UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id              UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wrapped_group_private JSONB NOT NULL,            -- group priv wrapped to member
  is_manager           BOOLEAN NOT NULL DEFAULT false,
  added_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_group_members_user ON group_members (user_id);

-- --- Nodes (folders & files) -----------------------------------------------
-- The tree. Names/metadata are encrypted under the node key. `content_ref`
-- points to the blob in object storage; blob bytes are AES-256-GCM ciphertext.
CREATE TABLE IF NOT EXISTS nodes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  parent_id     UUID REFERENCES nodes(id) ON DELETE CASCADE,   -- NULL = space root
  kind          TEXT NOT NULL CHECK (kind IN ('folder','file')),
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  -- encrypted metadata (opaque to server)
  name_encrypted BYTEA NOT NULL,
  name_nonce     BYTEA NOT NULL,
  meta_encrypted BYTEA,          -- optional: mime/app-kind/tags, encrypted
  meta_nonce     BYTEA,
  -- content (files only)
  content_ref    TEXT,           -- storage key of the encrypted blob
  content_nonce  BYTEA,
  size_bytes     BIGINT NOT NULL DEFAULT 0,   -- plaintext-ish size (leaks size)
  app_kind       TEXT,           -- coarse, non-sensitive hint: doc|sheet|slides|pdf|other
  current_version_id UUID,
  trashed_at     TIMESTAMPTZ,    -- soft delete
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_by    UUID REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes (parent_id);
CREATE INDEX IF NOT EXISTS idx_nodes_org ON nodes (org_id);
CREATE INDEX IF NOT EXISTS idx_nodes_owner ON nodes (owner_user_id);
CREATE INDEX IF NOT EXISTS idx_nodes_trashed ON nodes (org_id, trashed_at);

-- --- node_keys = crypto-ACL ------------------------------------------------
-- One row = "this principal can DECRYPT this node, with this role". The node
-- key (CEK) is wrapped to the principal's public key. Combines the crypto grant
-- and the authorization grant (role_id) so they never drift apart.
CREATE TABLE IF NOT EXISTS node_keys (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  node_id        UUID NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  principal_type TEXT NOT NULL CHECK (principal_type IN ('user','group','org')),
  principal_id   UUID NOT NULL,          -- users.id | groups.id | organizations.id
  role_id        UUID NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  wrapped_key    JSONB NOT NULL,         -- recipients envelope of the node CEK
  inherited_from UUID REFERENCES nodes(id) ON DELETE SET NULL, -- ancestor granting it
  granted_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (node_id, principal_type, principal_id)
);
CREATE INDEX IF NOT EXISTS idx_node_keys_node ON node_keys (node_id);
CREATE INDEX IF NOT EXISTS idx_node_keys_principal ON node_keys (principal_type, principal_id);

-- --- Versions --------------------------------------------------------------
CREATE TABLE IF NOT EXISTS node_versions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  node_id       UUID NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  version_no    INTEGER NOT NULL,
  content_ref   TEXT NOT NULL,
  content_nonce BYTEA NOT NULL,
  size_bytes    BIGINT NOT NULL DEFAULT 0,
  comment_encrypted BYTEA,
  comment_nonce BYTEA,
  created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (node_id, version_no)
);
CREATE INDEX IF NOT EXISTS idx_versions_node ON node_versions (node_id);

-- --- External share links --------------------------------------------------
-- The node key is wrapped to a link-secret-derived key; the secret lives in the
-- URL fragment and never reaches the server. We store only its hash for lookup.
CREATE TABLE IF NOT EXISTS share_links (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  node_id         UUID NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  token_hash      TEXT NOT NULL UNIQUE,     -- sha256(link token)
  role_id         UUID NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  wrapped_key     JSONB NOT NULL,           -- node CEK wrapped for the link
  has_password    BOOLEAN NOT NULL DEFAULT false,
  expires_at      TIMESTAMPTZ,
  max_downloads   INTEGER,
  download_count  INTEGER NOT NULL DEFAULT 0,
  created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  revoked_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_share_links_node ON share_links (node_id);

-- --- Collaboration relay (opaque encrypted Yjs update log) -----------------
CREATE TABLE IF NOT EXISTS collab_updates (
  id             BIGSERIAL PRIMARY KEY,
  node_id        UUID NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  update_ciphertext BYTEA NOT NULL,         -- AES-256-GCM under the node key
  update_nonce   BYTEA NOT NULL,
  author_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_collab_node_seq ON collab_updates (node_id, id);

-- --- Invitations -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS invites (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email        CITEXT NOT NULL,
  role_id      UUID NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  token_hash   TEXT NOT NULL UNIQUE,
  invited_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  accepted_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_invites_org ON invites (org_id);

-- --- Sessions (refresh tokens) ---------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token_hash TEXT NOT NULL UNIQUE,
  user_agent         TEXT NOT NULL DEFAULT '',
  ip                 TEXT NOT NULL DEFAULT '',
  expires_at         TIMESTAMPTZ NOT NULL,
  revoked_at         TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);

-- --- Login challenges (short-lived nonces for auth defi-reponse) ------------
CREATE TABLE IF NOT EXISTS login_challenges (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  nonce      TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_login_challenges_user ON login_challenges (user_id);

-- --- Audit log -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
  id            BIGSERIAL PRIMARY KEY,
  org_id        UUID REFERENCES organizations(id) ON DELETE CASCADE,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action        TEXT NOT NULL,
  resource_type TEXT NOT NULL DEFAULT '',
  resource_id   UUID,
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip            TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_org ON audit_log (org_id, created_at DESC);

-- current_version_id FK added after node_versions exists.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'nodes_current_version_fk'
  ) THEN
    ALTER TABLE nodes
      ADD CONSTRAINT nodes_current_version_fk
      FOREIGN KEY (current_version_id) REFERENCES node_versions(id) ON DELETE SET NULL;
  END IF;
END $$;

-- --- Key rotation (revocation hardening) -------------------------------------
-- `key_epoch` counts CEK generations for a node. Rotation (client-driven: the
-- server never sees a CEK) replaces the whole crypto-ACL, re-encrypts name/meta,
-- bumps the epoch, and revokes active share links (their wrapped keys hold the
-- old CEK). Version rows carry the epoch their blob was encrypted under so the
-- rotating client knows which blobs still need re-encryption.
ALTER TABLE nodes         ADD COLUMN IF NOT EXISTS key_epoch INTEGER NOT NULL DEFAULT 1;
ALTER TABLE node_versions ADD COLUMN IF NOT EXISTS key_epoch INTEGER NOT NULL DEFAULT 1;
-- Crash resilience: the PREVIOUS CEK, AES-256-GCM-encrypted under the CURRENT
-- CEK. Lets any current key holder finish an interrupted rotation (re-encrypt
-- version blobs left on the old epoch); a revoked principal never obtains the
-- current CEK, so this discloses nothing to them.
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS prev_key_wrapped BYTEA;
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS prev_key_nonce   BYTEA;

-- --- MFA (TOTP second factor) ----------------------------------------------
-- The TOTP seed is a SECOND factor, unrelated to the zero-knowledge content
-- keys. It is stored AES-256-GCM-encrypted under a server-held key (never in
-- the clear). `*_pending_*` holds an enrollment not yet confirmed by a first
-- valid code; on confirmation it is promoted to the active `mfa_secret_*`.
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_enabled       BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_secret_enc    BYTEA;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_secret_nonce  BYTEA;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_pending_enc   BYTEA;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_pending_nonce BYTEA;

-- Single-use recovery codes (sha256-hashed), consumed when a device is lost.
CREATE TABLE IF NOT EXISTS mfa_backup_codes (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash  TEXT NOT NULL,
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mfa_backup_user ON mfa_backup_codes (user_id);

-- --- Oracle-free login (Ed25519 challenge-response) ------------------------
-- The login verifier is now the PUBLIC key of a password-derived Ed25519 key.
-- The server issues a random challenge and checks the client's signature; it
-- never receives a password-equivalent. The legacy scrypt(authSecret) verifier
-- becomes optional (transition), so its NOT NULL constraints are relaxed.
ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_sign_public_hex TEXT;
ALTER TABLE users ALTER COLUMN auth_verifier DROP NOT NULL;
ALTER TABLE users ALTER COLUMN auth_salt DROP NOT NULL;

-- Login challenges become single-use signed nonces for the handshake.
ALTER TABLE login_challenges ADD COLUMN IF NOT EXISTS used_at TIMESTAMPTZ;

-- --- SSO (OIDC) + SCIM provisioning ----------------------------------------
-- Enterprise SSO authenticates IDENTITY only (the IdP proves who the user is);
-- it never unlocks the zero-knowledge content keys, which stay derived from a
-- client-side passphrase. `sso_config` = { issuer, clientId, jwks[], allowedDomains[] }.
-- `scim_token_hash` = sha256 of the per-org SCIM bearer token (provisioning).
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS sso_config      JSONB;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS scim_token_hash TEXT;
-- The user's OIDC subject, bound on first SSO sign-in (identity link).
ALTER TABLE users ADD COLUMN IF NOT EXISTS sso_subject TEXT;
CREATE INDEX IF NOT EXISTS idx_users_sso ON users (sso_subject);
