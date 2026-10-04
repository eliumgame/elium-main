## Recouvrement d'organisation

Chaque organisation possède son **couple de clés de recouvrement**. À la création,
le client génère ce couple et **emballe la clé privée d'org vers le créateur**
(premier admin) par ECDH-ES P-256 ; le serveur ne la détient jamais (il ne voit
qu'une enveloppe opaque). Chaque nœud reçoit en plus une **part de clé « org »**
(sa CEK emballée vers la clé publique d'org, préservée à chaque rotation de clé) —
un détenteur de la clé privée d'org peut donc, en principe, restaurer l'accès à
n'importe quel nœud.

**Endpoints serveur** (tous gardés par la permission `recovery.perform`) :

| Endpoint | Rôle |
|---|---|
| `GET …/recovery-key` | Récupérer sa propre clé privée d'org emballée |
| `POST …/recovery/admins` | Ré-emballer la clé privée d'org vers un autre admin |
| `POST …/recovery/grant` | Restaurer l'accès d'un membre à un nœud |
| `GET …/recovery/admins` | Lister les administrateurs de recouvrement |
| `GET …/recovery/nodes` | Arborescence de l'org + CEK emballées vers l'org |
| `DELETE …/recovery/admins/:userId` | Révoquer un admin de recouvrement (refuse le dernier) |

**UI interactive livrée.** La crypto côté client (`drive-cloud/recovery.ts`) est
isolée dans un helper `withOrgKey` qui **déballe** la clé privée d'org depuis la
clé P-256 de l'admin, l'utilise le temps d'une seule opération scopée, puis efface
le scalaire brut (zeroization best-effort ; format d'enveloppe audité de
`crypto/recipients.ts`, aucune crypto maison). Deux flux :

- **Promouvoir un administrateur de recouvrement** (`promoteRecoveryAdmin`) —
  ré-emballe la clé privée d'org vers un autre admin.
- **Restaurer l'accès à un nœud** (`restoreNodeAccess`) — déballe la part d'org du
  nœud pour récupérer sa CEK, puis la ré-emballe vers le membre cible.

L'onglet **« Recouvrement »** (`ui/RecoveryPanel.tsx`, visible aux seuls détenteurs
de `recovery.perform`) liste les administrateurs, en promeut de nouveaux et laisse
**parcourir l'arborescence de l'org** (noms déchiffrés localement avec la clé
d'org) pour rendre à un membre l'accès chiffré à un fichier. Le serveur ne voit que
des enveloppes opaques ; seuls les détenteurs de la clé privée d'org déchiffrent.
Couvert de bout en bout (E2E : promotion d'un 2ᵉ admin, restauration d'accès,
déchiffrement effectif du contenu recouvré, négatifs de permission) + tests
unitaires de la crypto de recouvrement.

---
