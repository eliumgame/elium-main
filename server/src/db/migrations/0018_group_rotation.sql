-- Revocation can happen before a manager has the keys to finish rewrapping.
-- New shares are refused until an exact-cover rotation clears this marker.
ALTER TABLE groups ADD COLUMN IF NOT EXISTS rotation_required BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS key_rotation_required BOOLEAN NOT NULL DEFAULT false;
