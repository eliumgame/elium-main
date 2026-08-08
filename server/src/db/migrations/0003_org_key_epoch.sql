-- ===========================================================================
-- Org keypair epoch — supports admin-triggered ORG KEY ROTATION.
--
-- Rotating the org recovery keypair re-wraps every node's org-principal CEK to a
-- new org public key and re-wraps the new org private key to each recovery admin
-- (all client-side; the server never sees a key). `org_key_epoch` counts those
-- generations so a partial/interrupted rotation is detectable and an optimistic
-- concurrency check can guard the swap. It does NOT re-encrypt file content
-- (unlike per-node CEK rotation), so old file versions keep working.
-- ===========================================================================

ALTER TABLE organizations ADD COLUMN IF NOT EXISTS org_key_epoch INTEGER NOT NULL DEFAULT 1;
