-- Backfill : rétro-propage `node.sign.request` aux rôles déjà clonés dans des
-- organisations EXISTANTES.
--
-- La création d'une demande de signature (POST /nodes/:id/sign-requests) est
-- passée de la permission `node.share.link` à la nouvelle `node.sign.request`
-- (voir rbac/permissions.ts + rbac/roles.ts, MANAGER_PERMS/EDITOR_PERMS).
-- `seedSystemRoles()` (server/src/db/migrate.ts) ne met à jour que les
-- gabarits GLOBAUX (org_id IS NULL) — le patron utilisé pour cloner les rôles
-- des NOUVELLES organisations. Les rôles déjà clonés dans des organisations
-- créées AVANT ce déploiement ne sont eux jamais retouchés par ce seed, donc
-- tout Manager/Editor d'une organisation existante perdrait silencieusement
-- l'accès à « Envoyer en signature » après la mise à jour.
--
-- On ajoute donc `node.sign.request` à tout rôle non-global qui possède déjà
-- `node.share.link` (signal qu'il avait accès à la fonctionnalité AVANT la
-- migration de permission), sans toucher aux rôles personnalisés qui ne
-- l'avaient jamais. Idempotent : une ré-exécution ne trouve plus aucune ligne
-- à modifier (le WHERE exclut déjà les rôles qui portent la permission).
UPDATE roles
   SET permissions = array_append(permissions, 'node.sign.request'),
       updated_at = now()
 WHERE org_id IS NOT NULL
   AND 'node.share.link' = ANY(permissions)
   AND NOT ('node.sign.request' = ANY(permissions));
