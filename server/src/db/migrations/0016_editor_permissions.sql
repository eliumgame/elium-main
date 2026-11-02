-- Les modèles globaux sont réensemencés au démarrage, mais les rôles système
-- clonés dans les organisations existantes conservent leurs permissions.
-- Aligner les Éditeurs existants avec le modèle réduit de roles.ts.
UPDATE roles
   SET permissions = array_remove(
         array_remove(
           array_remove(permissions, 'node.share.link'),
           'node.share.manage'),
         'node.acl.manage'),
       updated_at = now()
 WHERE org_id IS NOT NULL
   AND is_system = true
   AND key = 'editor'
   AND permissions && ARRAY['node.share.link', 'node.share.manage', 'node.acl.manage']::text[];
