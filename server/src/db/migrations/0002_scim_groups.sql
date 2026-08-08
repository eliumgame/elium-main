-- ===========================================================================
-- SCIM Groups (metadata + role mapping).
--
-- These are NOT cryptographic teams (see the `groups` table): in a
-- zero-knowledge model the server cannot mint a group keypair, so an IdP-driven
-- SCIM group carries only provisioning metadata + membership, plus an OPTIONAL
-- mapping to an Elium role (organizations.settings.scim.groupRoleMap, keyed by
-- display_name). A member of >=1 mapped group is assigned the most-privileged
-- mapped role on their org membership.
--
-- Membership is keyed by EMAIL, not by the SCIM resource id: a provisioned user
-- starts life as an invite (one id) and becomes a real user (a different id)
-- once they register + generate keys. Email is the stable identifier across
-- that transition, so role mapping keeps working seamlessly.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS scim_groups (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  external_id  TEXT,                                   -- IdP's own group id (optional)
  display_name TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, display_name)
);
CREATE INDEX IF NOT EXISTS idx_scim_groups_org ON scim_groups (org_id);

CREATE TABLE IF NOT EXISTS scim_group_members (
  group_id     UUID NOT NULL REFERENCES scim_groups(id) ON DELETE CASCADE,
  email        CITEXT NOT NULL,                        -- stable across invite->user
  member_value TEXT,                                   -- SCIM id the IdP sent (echoed back)
  added_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, email)
);
CREATE INDEX IF NOT EXISTS idx_scim_group_members_email ON scim_group_members (email);
