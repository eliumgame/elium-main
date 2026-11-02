# Audit Elium — lot Drive

Point de départ demandé : `68d913f`. Le checkout partagé a avancé pendant l'audit ; ce bilan confronte les cinq fichiers de constats au code et aux commits présents sur `master` le 2 novembre 2026. Les fichiers de travail des autres agents sont laissés intacts. Aucune release.

**Légende :** « corrigé » indique un changement réalisé dans cette reprise ; « déjà corrigé » indique un changement vérifié dans l'historique ; « reste » indique un constat non clos par cet audit. Les constats initiaux « partially » ou « unverified » restent à confirmer avant d'en déduire une vulnérabilité exploitable. Les points redondants sont conservés pour assurer la traçabilité des cinq lots.

**Bilan : 4 corrigés dans cette reprise, 25 déjà corrigés, 45 restant à traiter ou à confirmer sur 74.**

## Corrections réalisées dans cette reprise

- `f73010b` — historique des refresh tokens limité à 20, recherche de réemploi avec index GIN, expiration absolue des sessions à 90 jours. Vérification : 18 tests `auth-routes` et `npm run build` serveur.
- `2e75a5a` — SCIM ne peut plus suspendre le propriétaire par PATCH ou DELETE. Vérification : 9 tests `scim-deprovision-kick`/`scim` et `npm run build` serveur.
- `1b65da1` — migration des rôles système « Éditeur » déjà clonés dans les organisations : retrait des permissions de lien externe et de gestion des partages/ACL. Vérification : 17 tests `migrate`/`roles` et `npm run build` serveur ; migration SQL non exécutée sur une base réelle pendant cet audit.

## Comparaison des rotations historiques

- `5e89825` (issu du travail historique `1b2e2f8` / `77da243`) conserve les parts des équipes et empêche la perte de modifications collaboratives pendant la rotation ; `web-studio/tests/drive-rotation.test.ts` couvre ces chemins.
- `214c2de` rend la lecture résiliente après une compaction échouée ; `b846c3b` reprend une rotation interrompue à l'ouverture et permet la lecture par la clé précédente. Ces changements sont présents dans `master` ; ils ne sont pas à réappliquer depuis un worktree.
- `e6624d2` réemballe les parts héritées lors d'un déplacement. Le worktree historique `worktree-agent-aa431a3a866416b76` contient le correctif de reprise déjà intégré sous `b846c3b`.

## Inventaire des constats

### A1 — batch-A1-srv-auth.json

| ID | État | Constat | Preuve de correction / suite |
|---|---|---|---|
| A1-01 | reste | SSO : en multi-organisation, le propriétaire de n'importe quelle organisation peut se connecter au nom de ses membres (session globale) | à traiter (partially, medium) |
| A1-02 | déjà corrigé | Second facteur TOTP forçable : aucune limite par compte, mfaToken réutilisable pendant 5 minutes | `9e99038` |
| A1-03 | déjà corrigé | /prelogin : le leurre est distinguable d'un vrai compte par l'ordre des clés JSONB (énumération des comptes) | `0e7168f` |
| A1-04 | déjà corrigé | Enrôlement TOTP sans ré-authentification : un jeton d'accès volé suffit à verrouiller la victime hors de son compte | `191bff5` |
| A1-05 | déjà corrigé | Changement de mot de passe et suppression du compte : premier facteur seulement, et preuve de suppression statique rejouable | `a073c4e` |
| A1-06 | reste | La détection de réemploi du refresh token révoque la session quand le Drive est ouvert dans deux onglets | à traiter (confirmed, medium) |
| A1-07 | corrigé | Historique superseded_refresh_token_hashes non borné et recherche sans index sur une route publique | `f73010b` |
| A1-08 | reste | Énumération des comptes par /register (409) et /users/lookup, contraire à la promesse de la doc | à traiter (unverified, low) |
| A1-09 | reste | Codes de secours hachés en SHA-256 non salé sur 40 bits : retrouvables en clair à partir d'une fuite de la base | à traiter (unverified, low) |
| A1-10 | reste | Jeton d'identité OIDC rejouable : ni nonce, ni usage unique, ni âge maximal | à traiter (unverified, low) |

### A2 — batch-A2-srv-drive.json

| ID | État | Constat | Preuve de correction / suite |
|---|---|---|---|
| A2-01 | déjà corrigé | PATCH /orgs/:orgId/settings permet de réécrire settings.scim : contournement de la garde propriétaire + ré-authentification, et attribution du rôle « owner » par annuaire | `cd2a33e` |
| A2-02 | corrigé | Le rôle système « Éditeur » (rôle par défaut des membres) détient toutes les permissions de nœud : liens externes, gestion des ACL, révocation, rotation | Modèle `cd2a33e`, migration des rôles existants `1b65da1` |
| A2-03 | déjà corrigé | Destruction irréversible des clés et de l'historique : l'upsert de partage écrase la part du propriétaire et de l'organisation, et la réécriture de version supprime l'ancien blob sans condition | `c024fc4` |
| A2-04 | reste | Les liens externes survivent au retrait, à la suspension ou à la déprovision SCIM de leur créateur | à traiter (confirmed, medium) |
| A2-05 | corrigé | SCIM peut suspendre le propriétaire de l'organisation, qui ne peut plus rien rétablir (pas même régénérer le jeton SCIM) | `2e75a5a` |
| A2-06 | déjà corrigé | Contournement du quota : la réécriture d'une version ne met à jour ni size_bytes ni le quota | `26cd454` |
| A2-07 | reste | La purge d'un dossier laisse orphelins les blobs de tous ses descendants (quota libéré, données conservées sur disque) | à traiter (confirmed, medium) |
| A2-08 | reste | Rotation de la clé d'organisation sans contrôle de couverture : les nœuds omis ou créés pendant la rotation deviennent irrécupérables en silence | à traiter (confirmed, medium) |
| A2-09 | reste | Un détenteur de org.settings.manage peut écraser la clé de recouvrement enveloppée d'un autre administrateur (la garde « dernier admin » est contournable) | à traiter (confirmed, medium) |
| A2-10 | reste | Plafond de privilège asymétrique : retrait d'un membre plus puissant, modification d'un rôle porté par plus puissant, clonage sans plafond | à traiter (partially, medium) |
| A2-11 | déjà corrigé | group.manage permet de s'ajouter soi-même à n'importe quelle équipe : autorisation complète sur ses nœuds (corbeille, purge, écrasement), et écrasement des clés d'équipe des autres membres | `cd2a33e` |
| A2-12 | reste | Après un transfert de propriété, l'ancien propriétaire garde le rôle « owner » (toutes permissions), et ce rôle ne peut plus être modifié | à traiter (unverified, low) |
| A2-13 | reste | L'acceptation d'une invitation réactive une membership suspendue par SCIM et écrase le rôle d'un membre existant | à traiter (unverified, low) |
| A2-14 | reste | Écart doc/code : les droits sur un nœud n'incluent pas le rôle d'organisation | à traiter (unverified, info) |
| A2-15 | déjà corrigé | La chaîne d'audit se déclare rompue à chaque signature PDF par lien et à chaque réinitialisation de mot de passe par l'admin (canonicalisation incohérente) | `93bf3f6` |
| A2-16 | déjà corrigé | Une mise à jour collaborative trop volumineuse est perdue silencieusement (fermeture 1009 ou rejet muet, sans renvoi côté client) | `a3e3806` |
| A2-17 | déjà corrigé | Les gestionnaires WebSocket attachent close et error après plusieurs await : le compteur de connexions et les salles fuient, et le compte finit verrouillé en « too many connections » | `6127181` |
| A2-18 | reste | Purger un dossier de la corbeille (automatique ou manuel) supprime les lignes descendantes en cascade mais laisse leurs blobs chiffrés pour toujours | à traiter (confirmed, medium) |
| A2-19 | déjà corrigé | Le journal collab (collab_updates) échappe au quota d'organisation, au quota personnel et au garde-fou disque | `c320461` |
| A2-20 | reste | La signature anonyme par lien ne repose que sur le jeton du chemin, journalisé en clair : son seul détenteur peut remplacer le contenu courant et clôturer la partie | à traiter (partially, low) |
| A2-21 | reste | Signature multi-parties non ordonnée (le défaut) : chaque retour écrase le contenu courant sans version de base, d'où des signatures absentes du fichier « terminé » | à traiter (confirmed, medium) |
| A2-22 | corrigé | Le rôle « Éditeur » porte toutes les permissions de nœud (node.acl.manage, node.share.link/manage, node.sign.request), contrairement à la doc : tout éditeur peut compacter (effacer) le journal collab ou faire tourner la clé | Modèle `cd2a33e`, migration `1b65da1` ; `node.sign.request` reste volontairement accordée |
| A2-23 | reste | Les liens publics (lecture et signature) restent actifs sur un nœud mis à la corbeille | à traiter (unverified, low) |
| A2-24 | reste | La route publique de signature contourne le quota personnel et le contrôle disque post-envoi appliqués par PUT content | à traiter (unverified, low) |
| A2-25 | reste | Le relais TSA public sert de proxy POST anonyme vers n'importe quel hôte ou port public et renvoie la réponse | à traiter (unverified, low) |
| A2-26 | reste | Le gestionnaire d'erreurs convertit les erreurs 4xx de Fastify non prévues (415, 406…) en 500 journalisées au niveau error | à traiter (unverified, low) |
| A2-27 | reste | L'API publique tourne sur Node 22.20.0 (sept. 2025), qui manque 5 versions de sécurité Node ; d'autres images sont aussi figées sur des versions anciennes | à traiter (partially, low) |
| A2-28 | reste | Retirer un membre de l'organisation laisse ses parts de clé, ses équipes et sa propriété de nœuds : une simple ré-invitation (même en Lecteur) les réactive, sans rotation | à traiter (confirmed, medium) |

### B — batch-B-drive-client.json

| ID | État | Constat | Preuve de correction / suite |
|---|---|---|---|
| B-01 | reste | Le client fait confiance sans vérification aux clés publiques et aux destinataires fournis par le serveur (clé d'organisation, membres, équipes, ACL du parent) : un serveur compromis reçoit les CEK | à traiter (partially, medium) |
| B-02 | déjà corrigé | Rotation de clé d'un document collaboratif : la compaction supprime sans le dire les modifications que les co-auteurs ont déjà envoyées sous la nouvelle clé | `5e89825` |
| B-03 | reste | Après une rotation de la clé d'organisation, les autres clients continuent d'emballer les nouveaux fichiers vers l'ancienne clé, détruite : le recouvrement devient impossible sans alerte | à traiter (partially, medium) |
| B-04 | déjà corrigé | Le glisser-déposer retire leurs parts de clé aux collaborateurs (même à l'intérieur du même dossier partagé) et ne les ré-emballe jamais | `e6624d2` |
| B-05 | reste | Jetons : la rotation du jeton de rafraîchissement n'est pas synchronisée entre onglets (réemploi détecté, session révoquée), et tout échec de rafraîchissement, même 5xx ou 429, efface la session | à traiter (confirmed, medium) |
| B-06 | reste | Le serveur peut abaisser le coût Argon2id de la connexion (t=1, 8 Mio) et obtenir une signature exploitable pour un dictionnaire hors ligne ~100× moins cher | à traiter (confirmed, medium) |
| B-07 | reste | La signature par lien re-scelle le .elium avec une clé jetable : le sceau de l'auteur est remplacé, et le détenteur du lien peut renvoyer un contenu modifié avec un sceau « valide » | à traiter (partially, low) |
| B-08 | reste | Le type de chaque fichier (appKind) part en clair au serveur, alors que la doc promet des métadonnées chiffrées | à traiter (unverified, low) |
| B-09 | reste | La doc affirme qu'aucun écran ne liste ni ne révoque les sessions, alors que l'onglet Sécurité le fait | à traiter (unverified, low) |
| B-10 | reste | Tableur collaboratif : un état Y.Doc forgé (entrée non-Y.Map dans sheets, rows/cols négatifs ou géants) rend le classeur inouvrable pour tous, de façon persistante | à traiter (confirmed, medium) |
| B-11 | reste | Présentations collaboratives : shapes, elements, slides ou sections d'un type inattendu font planter la lecture du deck chez tous les co-auteurs | à traiter (confirmed, medium) |
| B-12 | reste | Présence usurpable et sabotable par n'importe quel participant, y compris en lecture seule : faux nom, effacement d'un autre pair, plantage de l'application des co-auteurs | à traiter (confirmed, medium) |
| B-13 | reste | Les opérations structurelles collaboratives perdent en silence les frappes concurrentes des pairs, contrairement à la « fusion au caractère près » promise | à traiter (confirmed, medium) |
| B-14 | reste | Commentaires et suivi des modifications du Document collaboratif : auteur et date déclarés par l'émetteur, et attributs malformés qui plantent l'application | à traiter (unverified, low) |
| B-15 | reste | Enregistrement d'un PDF depuis le Drive : la version de base n'est vérifiée que côté client (TOCTOU), PUT /content part sans précondition | à traiter (unverified, low) |
| B-16 | déjà corrigé | Une révocation par un Éditeur efface en silence les accès des équipes au nœud et à tout son sous-arbre | `5e89825` |
| B-17 | déjà corrigé | Rotation sur un document collaboratif : une compaction échouée rend le document vide pour tous, puis le perd définitivement à la rotation suivante | `214c2de` |
| B-18 | déjà corrigé | Une rotation de fichier interrompue n'est reprise qu'à la révocation suivante : contenu illisible pour les ayants droit, lisible par l'ancien détenteur, et message trompeur | `b846c3b` |
| B-19 | reste | Retirer quelqu'un d'une équipe ne fait tourner ni la clé d'équipe ni les CEK : l'ex-membre garde la clé privée de l'équipe pour tous les fichiers futurs | à traiter (confirmed, medium) |
| B-20 | reste | Les clés publiques servies par le serveur (membre d'équipe, destinataire, organisation) ne sont ni vérifiées ni affichées : un serveur compromis obtient la clé privée d'une équipe | à traiter (confirmed, medium) |
| B-21 | reste | La synchronisation du circuit de signature réécrit le contenu sans époque de clé ni contrôle de conflit | à traiter (unverified, low) |
| B-22 | reste | VersionsDialog : une restauration en échec ne donne aucun retour et le bouton est proposé à tous | à traiter (unverified, low) |
| B-23 | reste | Écart doc/code : la doc affirme qu'il n'existe aucun écran de sessions, alors que DevicesSection est livré | à traiter (unverified, info) |

### C — batch-C-workspace.json

| ID | État | Constat | Preuve de correction / suite |
|---|---|---|---|
| C-01 | reste | Application Windows : le miroir Documents\Elium réimporte au redémarrage les données du compte précédent, ce qui annule la purge au changement de compte | à traiter (partially, medium) |
| C-02 | reste | Brouillons de récupération PDF chiffrés avec le coffre, mais absents du rechiffrement : irrécupérables après changement ou désactivation du coffre | à traiter (confirmed, medium) |
| C-03 | reste | Purge au changement de compte incomplète : bibliographie, tampons image, réglages et racines C2PA du Détecteur et journal d'incidents survivent, puis partent dans la sauvegarde Drive du nouveau compte | à traiter (confirmed, medium) |
| C-04 | déjà corrigé | Dossier « Sauvegarde Elium » détournable par un autre membre : injection automatique d'ancres de confiance PDF, de racines C2PA et de réglages, puis exfiltration de tout l'espace local | `d995166` |
| C-05 | déjà corrigé | Les secrets de la sauvegarde d'espace ne contiennent aucune clé privée pour les clés dérivées, et leur restauration empêche ensuite la restauration par phrase ou .eliumkey | `5caefd2` |
| C-06 | déjà corrigé | Envoi automatique de tout l'espace local dans une seconde organisation (parts de clé pour l'organisation de destination) | `44e23ef` |
| C-07 | déjà corrigé | Les révocations du carnet de confiance ne sont pas sauvegardées : une clé déclarée compromise redevient un contact nommé après restauration | `5caefd2` |
| C-08 | déjà corrigé | Sauvegarde Drive multi-appareils : l'index est écrasé sans contrôle de conflit, et les éléments de l'autre appareil disparaissent de la restauration | `5caefd2` |
| C-09 | reste | Carnet et épingles restaurés sans validation, avertissement incomplet : niveaux « vérifié » ou « attesté » importés, épingles TOFU préchargées, vérification cassable | à traiter (unverified, low) |
| C-10 | reste | Doc 04-07 périmée sur la sauvegarde Drive : archive monolithique, envoi arrêté en cas de conflit, racines C2PA « jamais » sauvegardées | à traiter (unverified, low) |

### D — batch-D-passport.json

| ID | État | Constat | Preuve de correction / suite |
|---|---|---|---|
| D-01 | déjà corrigé | Passeport : expression régulière à retour arrière catastrophique sur document.xml (gel de l'onglet) | `8233256` |
| D-02 | déjà corrigé | Réinitialiser le coffre local laisse le passeport E4 chiffré sous l'ancien secret : le module reste verrouillé sans issue | `2b46b22` |
| D-03 | déjà corrigé | Sauvegarde automatique du passeport dans un fichier : écrase le fichier à l'ouverture sans le lire | `8b86a0a` |

## Priorité de reprise

Traiter d'abord les prises de session et pertes irréversibles encore ouvertes : SSO multi-organisation (A1-01), liens externes après retrait (A2-04), purge des blobs descendants (A2-07/A2-18), couverture de rotation de clé d'organisation (A2-08), signatures concurrentes (A2-21), rotation de clé d'équipe (B-19), puis les pertes de données et contaminations entre comptes du lot C. Chaque correction doit être testée et commitée séparément.
