## Recouvrement d'organisation

Le chiffrement de bout en bout a un prix : si un membre perd ses clés, le serveur ne peut pas l'aider. Le **recouvrement** rend l'accès à des fichiers sans que le serveur ne voie jamais une clé en clair.

### Principe

Chaque organisation possède une **paire de clés de recouvrement** (ECDH P-256).

1. À la création de l'organisation, le navigateur du créateur génère la paire.
2. La clé **privée** est emballée pour le créateur, premier administrateur de recouvrement. Le serveur ne garde qu'une enveloppe opaque.
3. Chaque nœud reçoit une **part « organisation »** : sa clé de contenu emballée pour la clé publique de l'organisation. Cette part est conservée à chaque rotation de clé du nœud.

Un administrateur de recouvrement peut donc ouvrir sa clé d'organisation, retrouver la clé de contenu d'un nœud et la ré-emballer pour un membre. Il n'a pas besoin de la phrase de passe du membre.

> Seuls les détenteurs de la permission `recovery.perform` (propriétaire et administrateurs par défaut) voient l'onglet **Recouvrement**.

### Routes serveur

Toutes sont préfixées par `/api/orgs/:orgId` et exigent `recovery.perform`.

| Route | Rôle |
|---|---|
| `GET /recovery-key` | Récupérer sa propre clé d'organisation emballée |
| `GET /recovery/admins` | Lister les administrateurs de recouvrement |
| `POST /recovery/admins` | Ré-emballer la clé d'organisation pour un autre administrateur |
| `DELETE /recovery/admins/:userId` | Retirer un administrateur (le dernier ne peut pas l'être) |
| `GET /recovery/nodes` | Arborescence de l'organisation, avec les clés emballées pour l'organisation |
| `POST /recovery/grant` | Rendre à un membre l'accès à un nœud |
| `POST /recovery/rotate-org` | Changer la paire de clés de l'organisation (aussi `org.settings.manage`) |

### Ce que fait l'interface

Le code côté navigateur est isolé dans une fonction `withOrgKey`. Elle ouvre la clé privée d'organisation, la prête le temps d'une seule opération, puis **efface** la valeur brute de la mémoire. Aucune cryptographie maison : les enveloppes sont celles du reste du Drive.

- **Promouvoir un administrateur** : ré-emballer la clé d'organisation pour un autre membre. Prévoir **au moins deux** administrateurs de recouvrement.
- **Restaurer l'accès à un nœud** : ouvrir la part « organisation » du nœud, puis ré-emballer sa clé pour le membre ciblé. Les noms des nœuds sont déchiffrés localement pour permettre de parcourir l'arborescence.

### Rotation de la clé d'organisation

Faire tourner la paire de clés limite l'effet d'une clé d'administrateur compromise.

1. Un administrateur ouvre l'ancienne clé et en génère une **nouvelle**.
2. Le navigateur ré-emballe la clé de **chaque nœud** pour la nouvelle clé publique, et la nouvelle clé privée pour **chaque** administrateur de recouvrement.
3. Le serveur remplace le tout en **une seule transaction** et incrémente l'époque de clé de l'organisation.

Le contenu des fichiers n'est pas touché. La requête doit couvrir **tous** les administrateurs, sinon le serveur la refuse pour n'en verrouiller aucun.

**Rotation planifiée (facultative).** Dans l'onglet Recouvrement, on fixe un nombre de jours (0 = désactivée, 3650 au plus). Un balayage périodique **signale** quand la rotation est due, après avoir vérifié que tous les administrateurs ont une clé publique. Elle n'est **jamais** exécutée seule : le serveur n'a pas la clé, un administrateur doit lancer l'opération.

### Transfert de propriété

`POST /api/orgs/:orgId/transfer-ownership` : réservé au propriétaire actuel, vers un membre actif. Le nouveau propriétaire doit aussi être promu administrateur de recouvrement pour pouvoir rendre l'accès à des fichiers. Cette route est dans le SDK, mais **aucun écran** ne la propose pour l'instant.

### Lien avec la suppression de compte

On ne peut pas supprimer son compte tant qu'on est propriétaire d'une organisation qui a d'autres membres, ni seul administrateur de recouvrement d'une organisation qui subsiste. Il faut d'abord transférer la propriété et promouvoir un autre administrateur. Voir le chapitre sur la confidentialité.

### Limites connues du recouvrement

- Le recouvrement est une **porte dérobée voulue** : toute personne qui détient la clé d'organisation peut lire n'importe quel fichier de l'organisation. Limitez le nombre d'administrateurs et protégez leurs comptes (2FA).
- Le retrait d'un administrateur de recouvrement (`DELETE`) n'a pas non plus d'écran : il passe par l'API.
- Si **aucun** administrateur ne peut ouvrir la clé, aucun recouvrement n'est possible.
- Une rotation d'organisation ré-emballe toutes les clés : sur un très grand volume de nœuds, la requête est lourde (plafond de 100 000 nœuds par appel).
- Ce recouvrement concerne le **Drive**. La suite locale n'a pas de recouvrement central, voir le chapitre sur la cryptographie.
