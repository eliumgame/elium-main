## Le Drive d'entreprise

Le Drive est un service **auto-hébergé** : une équipe y partage, co-édite et signe des fichiers. La suite locale fonctionne sans lui. Le Drive est un ajout, jamais un prérequis.

Les contenus, noms et métadonnées descriptives sont **chiffrés côté client**. Le serveur conserve aussi les informations nécessaires aux accès et au fonctionnement du Drive, détaillées ci-dessous.

### Architecture du serveur

| Brique | Rôle |
|---|---|
| **Caddy** | Point d'entrée : HTTPS automatique (Let's Encrypt), en-têtes de sécurité, route `/api/*` vers l'API et le reste vers l'interface |
| **API** | Fastify 5, TypeScript, version Node épinglée dans le Dockerfile. REST, relais WebSocket de collaboration, image non root |
| **Web** | Interface statique servie par un conteneur non root, système de fichiers en lecture seule |
| **PostgreSQL 16** | Métadonnées, droits, clés emballées, versions, journal d'audit |
| **Blobs** | Contenu chiffré : volume local (`fs`) ou S3 / MinIO (`s3`) |
| **Redis 7** | Relais temps réel entre instances et limitation de débit partagée. Protégé par mot de passe, aucun port publié |

Les migrations SQL sont **versionnées** (table `schema_migrations`) et jouées au démarrage de l'API. Au démarrage, le dossier `fs` ou le bucket S3 est créé s'il manque.

> L'API ne démarre pas en production si `TOKEN_SECRET` est absent, plus court que 32 caractères ou resté à une valeur d'exemple. Elle refuse aussi une base dont le mot de passe est celui par défaut.

### Ce que le serveur stocke

- Le contenu des fichiers, **chiffré** et rembourré (Padmé), donc sans taille exacte.
- Les noms et les métadonnées descriptives, **chiffrés**. Le type applicatif (`appKind` : document, tableur, présentation, PDF…) est transmis en clair pour l'ouverture et le classement.
- Les clés de contenu (CEK) **emballées** pour chaque destinataire.
- La clé publique de chaque compte et un paquet de clés privées déjà chiffré côté client.
- Les droits (qui peut quoi), les versions et le journal d'audit.

Le serveur connaît donc la **structure** (arbre, dates, tailles approximatives, type applicatif, qui a accès à quoi). Il ignore les noms et les contenus. Voir le chapitre sur le modèle de menace pour les limites.

### Chiffrement de bout en bout

1. Chaque fichier ou dossier (un **nœud**) a sa propre clé de contenu (CEK).
2. Cette clé est emballée pour chaque personne ou équipe qui y a accès, par ECDH-ES sur P-256.
3. Chaque équipe a sa propre paire de clés P-256, partagée entre ses membres.
4. L'organisation a une paire de clés de recouvrement (voir le chapitre sur le recouvrement).

Le client chiffre avant d'envoyer et déchiffre après avoir reçu. Le navigateur ne confie au serveur aucune clé en clair : il ne reçoit que des clés emballées.

**Limite importante : l'origine des clés publiques.** Pour emballer une clé vers une personne, une équipe ou l'organisation, le navigateur utilise la clé publique que le **serveur** lui fournit. Un serveur compromis ou malveillant pourrait donc substituer sa propre clé et recevoir ensuite des clés de contenu. Elium applique la **confiance au premier usage** (TOFU), comme SSH :

- la première clé vue pour une identité est mémorisée dans votre navigateur ; si le serveur en présente ensuite une autre, l'envoi est **bloqué** et une alerte s'affiche dans Sécurité, avec les mots de sécurité de l'ancienne et de la nouvelle clé ;
- pour un partage direct ou un ajout d'équipe, Elium vous demande de comparer les **mots de sécurité** du destinataire par un autre canal avant d'emballer la clé (vous pouvez annuler) ;
- les destinataires hérités d'un dossier (nouveau fichier dans un dossier partagé, déplacement) jamais vus auparavant sont mémorisés **et signalés** dans Sécurité comme « nouveaux destinataires non vérifiés » ;
- cette protection ne vaut **que** si la première clé vue est authentique : un serveur déjà compromis lors de la toute première rencontre n'est pas détecté, et l'épinglage est local à chaque navigateur (un nouvel appareil repart de zéro). Seule la comparaison des mots de sécurité hors bande lève ce doute.

### Rôles et permissions (RBAC)

Le catalogue compte **37 permissions**, regroupées en six domaines : contenu, partage, membres, rôles, organisation, sécurité. Sept rôles système sont clonés dans chaque organisation. Un rôle personnalisé est n'importe quel sous-ensemble de permissions.

| Rôle | Portée |
|---|---|
| Propriétaire | Tout, y compris le transfert de propriété et la clé de recouvrement |
| Administrateur | Toutes les permissions |
| Gestionnaire | Personnes, groupes, partages et rôles dans son périmètre |
| Éditeur | Crée et modifie le contenu, partage en interne et peut créer une demande de signature par lien |
| Commentateur | Consulte et commente |
| Lecteur | Voit et télécharge |
| Invité | Voit seulement (accès par lien) |

Le rôle d'organisation gouverne l'administration et la création. Il ne donne pas, à lui seul, accès à tous les fichiers. Les droits sur un nœud viennent des accès attribués à la personne ou à ses équipes, des dossiers parents et des droits implicites du propriétaire du nœud. Le partage est **profond** : un accès donné sur un dossier vaut pour tout son sous-arbre. Les permissions sont vérifiées **côté serveur** à chaque requête.

### Partage

- **Membre ou équipe** : la clé du nœud est emballée pour la personne ou l'équipe.
- **Lien externe** : lien chiffré dont la clé est dans le fragment de l'URL (jamais envoyée au serveur). Options : mot de passe, date d'expiration, nombre maximal de téléchargements. Une page publique l'ouvre.
- **Demande de signature par lien** : un lien à usage de signature, par partie, séquentiel ou non. Voir le chapitre sur les signatures.

La permission de demander une signature externe (`node.sign.request`) est distincte du partage par lien libre. Elle est accordée au rôle Éditeur par défaut ; retirez-la d'un rôle personnalisé si ces invitations doivent être réservées à d'autres personnes.

### Révocation d'un accès et rotation de clé

Retirer un accès **change la clé du nœud**. Un destinataire retiré ne peut donc plus lire les versions futures.

| Étape | Effet |
|---|---|
| Nouvelle CEK | Nom, métadonnées, contenu et **toutes les versions** sont rechiffrés |
| Sous-arbre | Les parts de clé héritées sont nettoyées, le propriétaire est préservé |
| Liens externes | Révoqués |
| Époque de clé | Une écriture avec une époque périmée reçoit un 409 |
| Pairs connectés | Éjectés (code WebSocket 4001), puis reconnexion transparente |
| Interruption | Reprise possible (l'ancienne clé est conservée, chiffrée sous la nouvelle) |

> Un contenu **déjà lu** ou téléchargé par la personne reste en sa possession. La rotation protège l'avenir, pas le passé.

### Quotas

Chaque organisation a un **quota de stockage** (vide = illimité). Une nouvelle version compte pour sa taille, car les versions précédentes sont conservées. Au-delà, l'API répond **507**. Le quota se règle dans l'interface d'administration ou par `PATCH /api/orgs/:id/quota` (permission `storage.quota.manage`).

Le **journal de co-édition** (mises à jour chiffrées en attente de compactage) compte aussi : quand le quota est atteint, ou quand le disque passe sous la marge de sécurité, le relais refuse la mise à jour avec une erreur explicite. Un plafond de débit en octets par utilisateur (`MAX_COLLAB_BYTES_PER_USER_PER_MINUTE`, 64 Mio par minute par défaut) empêche de saturer la base. La réécriture d'une version pendant une rotation de clé est comptée à sa nouvelle taille.

> L'option `--quota-gb` de `install.sh` est **obsolète** : elle est ignorée avec un avertissement.

### Versions et corbeille

- Chaque enregistrement crée une **version**. On peut la consulter, la restaurer et la rechiffrer en cas de rotation.
- La suppression met le nœud à la **corbeille** (réversible).
- « Supprimer définitivement » efface la ligne et les blobs.
- Un balayage toutes les 15 minutes supprime définitivement les nœuds restés plus de **30 jours** à la corbeille.

### PDF dans le Drive

Un double-clic sur un PDF l'ouvre dans l'éditeur PDF, après déchiffrement dans le navigateur. **Enregistrer** (Ctrl+S) rechiffre le fichier et le dépose comme **nouvelle version**. Si un collègue l'a modifié entre-temps, Elium le signale et demande avant de remplacer. Il n'y a **pas** de co-édition temps réel des PDF.

### Co-édition temps réel chiffrée

La co-édition utilise des CRDT **Yjs** pour Documents, Tableur et Présentations : curseurs colorés, présence, fusion au caractère près lorsque deux personnes écrivent dans la **même cellule de texte** ou le même paragraphe. Dans le Tableur, les opérations **structurelles** (insertion ou suppression de lignes ou de colonnes, tri) remplacent l'état de la feuille concernée : une frappe saisie au même instant par un collègue dans cette feuille peut être perdue. Évitez de trier ou de restructurer pendant que d'autres éditent la même feuille. Les éditeurs collaboratifs partagent leur code avec les éditeurs locaux.

- Les mises à jour sont chiffrées **dans le navigateur** avant de partir. Le relais ne fait que les distribuer et les stocker.
- Chaque mise à jour persistée est **acquittée** (`ack` avec son numéro de séquence). Une mise à jour refusée n'est jamais perdue en silence : l'émetteur reçoit une erreur (`update_too_large`, `quota_exceeded`, `disk_full`, `rate_limited_bytes`, `read_only`, `invalid_update`, `persist_failed`). Une trame plus grande que la limite du serveur WebSocket ferme la connexion avec le code **1009**.
- Un nouvel arrivant rattrape l'historique, ensuite compacté sous la clé courante.
- Les accès sont contrôlés à la connexion et après chaque changement de droits.
- Avec Redis, plusieurs instances de l'API partagent la salle : un pair révoqué est éjecté même s'il est connecté à une autre instance. Sans Redis, l'API fonctionne seule, en mémoire.
- L'état de Redis est visible dans `/api/health`. Une panne dégrade le temps réel entre instances, pas la sauvegarde (Postgres reste la source de vérité).

### Interface

Authentification et invitation par lien, explorateur chiffré, partage, rôles et permissions, membres, équipes, versions, corbeille, journal d'audit, pages publiques (ouverture d'un lien, signature). Onglet **Sécurité** (mot de passe, 2FA, clés d'accès, suppression du compte), onglet **SSO et SCIM**, onglet **Recouvrement**.

### Compatibilité des anciens clients (période transitoire)

Les durcissements récents exigent des nouveaux clients des préconditions : version et époque de clé de base sur l'écriture d'un fichier (`x-base-version-id`, `x-key-epoch`) et sur la signature par lien, époque de la clé d'organisation et clé publique d'équipe sur la création, la rotation et le partage, corps complets pour les équipes et la rotation d'organisation. Les anciens clients (onglets restés ouverts, application de bureau dont l'interface web n'est pas à jour) ne les envoient pas.

Pendant **une version**, le serveur les tolère (`LEGACY_CLIENT_COMPAT`, vrai par défaut) :

- **Écriture et signature sans en-têtes** : la base est déduite de l'état courant du fichier, sous verrou. Une nouvelle version est **toujours** créée, l'historique n'est jamais supprimé. La réponse porte `x-elium-deprecated: client-outdated`.
- **Partage et création sans époque d'organisation ou clé d'équipe** : le serveur utilise l'état courant lu sous verrou.
- **Toujours refusé**, même en compatibilité : un fichier dont la clé doit être renouvelée (`409`), une organisation ou une équipe à rotation requise (`409`), un seul des deux en-têtes (`428`, client incohérent), et toutes les vérifications de droits et de quota.
- **Équipes et rotation d'organisation** : un ancien client ne peut pas produire ces corps (le serveur n'a jamais les clés). Refus `400` de code `client_outdated`, sans écriture partielle.

**Ce que la compatibilité ne protège plus.** Sans en-tête, le serveur ne sait pas quelle version l'ancien client a ouverte : une écriture d'un client périmé peut devenir la version courante au-dessus d'une modification plus récente d'un collègue. Elle ne la détruit pas (elle reste dans les versions et peut être restaurée) mais la détection de conflit n'existe plus pour ces clients.

**Calendrier recommandé.** Gardez la compatibilité pour cette version, laissez les utilisateurs recharger leurs onglets et mettre à jour l'application de bureau, puis passez `LEGACY_CLIENT_COMPAT=false` à la version suivante. Les anciens clients reçoivent alors `428` avec le code `client_outdated` et le message « Cette version de l'application est trop ancienne : rechargez la page ou mettez l'application à jour. »

### Limites connues du Drive

- L'onglet **Sécurité** permet de lister et de révoquer ses sessions.
- La co-édition n'existe pas pour les PDF.
- Le serveur voit les métadonnées de structure (arbre, dates, tailles arrondies, type applicatif, membres).
- Un compte dont la phrase de passe est perdue ne peut pas être récupéré par le serveur. Seul le recouvrement d'organisation permet de rendre l'accès à des fichiers.
