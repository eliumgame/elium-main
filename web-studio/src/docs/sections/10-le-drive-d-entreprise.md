## Le Drive d'entreprise

Le Drive est un service **auto-hébergé** : une équipe y partage, co-édite et signe des fichiers. La suite locale fonctionne sans lui. Le Drive est un ajout, jamais un prérequis.

Le principe tient en une phrase : **le serveur ne voit que du chiffré**. Il ne reçoit jamais de mot de passe, de clé privée ni de contenu en clair.

### Architecture du serveur

| Brique | Rôle |
|---|---|
| **Caddy** | Point d'entrée : HTTPS automatique (Let's Encrypt), en-têtes de sécurité, route `/api/*` vers l'API et le reste vers l'interface |
| **API** | Fastify 5 (Node 20, TypeScript). REST, relais WebSocket de collaboration, image non root |
| **Web** | Interface statique servie par un conteneur non root, système de fichiers en lecture seule |
| **PostgreSQL 16** | Métadonnées, droits, clés emballées, versions, journal d'audit |
| **Blobs** | Contenu chiffré : volume local (`fs`) ou S3 / MinIO (`s3`) |
| **Redis 7** | Relais temps réel entre instances et limitation de débit partagée. Protégé par mot de passe, aucun port publié |

Les migrations SQL sont **versionnées** (table `schema_migrations`) et jouées au démarrage de l'API. Au démarrage, le dossier `fs` ou le bucket S3 est créé s'il manque.

> L'API ne démarre pas en production si `TOKEN_SECRET` est absent, plus court que 32 caractères ou resté à une valeur d'exemple. Elle refuse aussi une base dont le mot de passe est celui par défaut.

### Ce que le serveur stocke

- Le contenu des fichiers, **chiffré** et rembourré (Padmé), donc sans taille exacte.
- Les noms et les métadonnées, **chiffrés**.
- Les clés de contenu (CEK) **emballées** pour chaque destinataire.
- La clé publique de chaque compte et un paquet de clés privées déjà chiffré côté client.
- Les droits (qui peut quoi), les versions et le journal d'audit.

Le serveur connaît donc la **structure** (arbre, dates, tailles approximatives, qui a accès à quoi). Il ignore les noms et les contenus. Voir le chapitre sur le modèle de menace pour les limites.

### Chiffrement de bout en bout

1. Chaque fichier ou dossier (un **nœud**) a sa propre clé de contenu (CEK).
2. Cette clé est emballée pour chaque personne ou équipe qui y a accès, par ECDH-ES sur P-256.
3. Chaque équipe a sa propre paire de clés P-256, partagée entre ses membres.
4. L'organisation a une paire de clés de recouvrement (voir le chapitre sur le recouvrement).

Le client chiffre avant d'envoyer et déchiffre après avoir reçu. Le navigateur ne confie rien au serveur qui permette de lire un fichier.

### Rôles et permissions (RBAC)

Le catalogue compte **37 permissions**, regroupées en six domaines : contenu, partage, membres, rôles, organisation, sécurité. Sept rôles système sont clonés dans chaque organisation. Un rôle personnalisé est n'importe quel sous-ensemble de permissions.

| Rôle | Portée |
|---|---|
| Propriétaire | Tout, y compris le transfert de propriété et la clé de recouvrement |
| Administrateur | Toutes les permissions |
| Gestionnaire | Personnes, groupes, partages et rôles dans son périmètre |
| Éditeur | Crée et modifie le contenu, partage en interne |
| Commentateur | Consulte et commente |
| Lecteur | Voit et télécharge |
| Invité | Voit seulement (accès par lien) |

Les droits réels d'une personne sur un nœud sont l'**union** de son rôle d'organisation, des rôles de ses équipes et des accès hérités des dossiers parents. Le partage est **profond** : un accès donné sur un dossier vaut pour tout son sous-arbre. Les permissions sont vérifiées **côté serveur** à chaque requête.

### Partage

- **Membre ou équipe** : la clé du nœud est emballée pour la personne ou l'équipe.
- **Lien externe** : lien chiffré dont la clé est dans le fragment de l'URL (jamais envoyée au serveur). Options : mot de passe, date d'expiration, nombre maximal de téléchargements. Une page publique l'ouvre.
- **Demande de signature par lien** : un lien à usage de signature, par partie, séquentiel ou non. Voir le chapitre sur les signatures.

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

> L'option `--quota-gb` de `install.sh` est **obsolète** : elle est ignorée avec un avertissement.

### Versions et corbeille

- Chaque enregistrement crée une **version**. On peut la consulter, la restaurer et la rechiffrer en cas de rotation.
- La suppression met le nœud à la **corbeille** (réversible).
- « Supprimer définitivement » efface la ligne et les blobs.
- Un balayage toutes les 15 minutes supprime définitivement les nœuds restés plus de **30 jours** à la corbeille.

### PDF dans le Drive

Un double-clic sur un PDF l'ouvre dans l'éditeur PDF, après déchiffrement dans le navigateur. **Enregistrer** (Ctrl+S) rechiffre le fichier et le dépose comme **nouvelle version**. Si un collègue l'a modifié entre-temps, Elium le signale et demande avant de remplacer. Il n'y a **pas** de co-édition temps réel des PDF.

### Co-édition temps réel chiffrée

La co-édition utilise des CRDT **Yjs** pour Documents, Tableur et Présentations : curseurs colorés, présence, fusion au caractère près. Les éditeurs collaboratifs partagent leur code avec les éditeurs locaux.

- Les mises à jour sont chiffrées **dans le navigateur** avant de partir. Le relais ne fait que les distribuer et les stocker.
- Un nouvel arrivant rattrape l'historique, ensuite compacté sous la clé courante.
- Les accès sont contrôlés à la connexion et après chaque changement de droits.
- Avec Redis, plusieurs instances de l'API partagent la salle : un pair révoqué est éjecté même s'il est connecté à une autre instance. Sans Redis, l'API fonctionne seule, en mémoire.
- L'état de Redis est visible dans `/api/health`. Une panne dégrade le temps réel entre instances, pas la sauvegarde (Postgres reste la source de vérité).

### Interface

Authentification et invitation par lien, explorateur chiffré, partage, rôles et permissions, membres, équipes, versions, corbeille, journal d'audit, pages publiques (ouverture d'un lien, signature). Onglet **Sécurité** (mot de passe, 2FA, clés d'accès, suppression du compte), onglet **SSO et SCIM**, onglet **Recouvrement**.

### Limites connues

- **Aucune interface** pour lister ou révoquer ses sessions : les routes existent (`GET` et `DELETE /api/users/me/sessions`), l'écran non.
- La co-édition n'existe pas pour les PDF.
- Le serveur voit les métadonnées de structure (arbre, dates, tailles arrondies, membres).
- Un compte dont la phrase de passe est perdue ne peut pas être récupéré par le serveur. Seul le recouvrement d'organisation permet de rendre l'accès à des fichiers.
