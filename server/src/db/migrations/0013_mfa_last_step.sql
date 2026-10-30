-- Anti-rejeu TOTP : dernier pas de 30 s consommé par le compte. Un code déjà
-- accepté (ou antérieur) est refusé, donc un code observé ne peut pas être rejoué
-- pendant sa fenêtre de validité (RFC 6238 §5.2).
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_last_step BIGINT;
