-- Dernière sauvegarde de l'espace de travail signalée par le client de chaque compte.
-- Le serveur ne voit pas le contenu (chiffré de bout en bout) : il garde seulement la date et le
-- nombre d'éléments, pour que le propriétaire constate si la sauvegarde imposée est réellement faite.
ALTER TABLE users ADD COLUMN IF NOT EXISTS backup_last_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS backup_items INTEGER;
