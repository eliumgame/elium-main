### Carnet de confiance

Un sceau ou une signature dit « ce fichier est intègre et signé par **cette clé** ».
Il ne dit pas **qui** détient la clé. Le **carnet de confiance** fait le pont : si la
clé figure au carnet, Elium affiche « scellé par Alice » au lieu de « clé non
vérifiée ».

Le carnet est une décision de confiance **locale**. Il est stocké dans le
navigateur (`localStorage`, clés `elium_trust_book` et `elium_trust_revocations`).
Il ne voyage **pas** dans le `.elium` et il n'est **pas** dans la sauvegarde
`.eliumkey`. La sauvegarde d'espace de travail l'embarque seulement si vous
demandez les secrets.

**Signataires et destinataires.** Un contact a une nature :

| Nature | Clé | Sert à |
|---|---|---|
| Signataire | Ed25519, 64 caractères hexadécimaux | Attribuer un nom à un sceau ou à une signature |
| Destinataire | P-256, 130 caractères hexadécimaux (`04`…) | Chiffrer un document pour cette personne |

Un contact porte : nom, clé publique, empreinte, date d'ajout, niveau, nature,
notes, date d'expiration et date de vérification.

**Niveaux de confiance.** Du plus faible au plus fort :

| Niveau | Sens | Comment on l'obtient aujourd'hui |
|---|---|---|
| Non vérifié | Clé ajoutée sans contrôle hors bande | Par défaut : ajout manuel, ou « Faire confiance » depuis un sceau ou une signature |
| Première vue (TOFU) | Clé vue puis mémorisée | Hérité d'une succession vérifiée (voir « Limites connues d'Elium Keys ») |
| Vérifié par mots de sécurité | Empreinte comparée avec la personne | Bouton « Les mots correspondent — ajouter » du sélecteur de destinataires |
| Attesté par l'organisation | Clé attestée par l'annuaire de l'organisation | **Prévu par le modèle, pas encore attribué par le client** |

Le niveau est une **déclaration de votre part** : Elium ne vérifie pas
cryptographiquement que vous avez réellement comparé les mots.

**Sélecteur de destinataires.** Pour chiffrer un document pour d'autres personnes,
choisissez dans le carnet les contacts de nature « destinataire ». Pour chacun,
Elium affiche :

- le nom et le niveau de confiance ;
- ses **mots de sécurité** : six mots, tirés d'une liste de 64 mots français, qui
  représentent l'empreinte (6 mots × 6 bits = 36 bits) ;
- un avertissement « empreinte jamais vérifiée » pour un contact non vérifié ;
- un blocage si la clé est **révoquée** ou **expirée**.

Pour ajouter un destinataire, collez sa clé publique. Elium affiche alors ses mots
de sécurité et un **QR code** de la clé. Comparez les mots avec la personne par un
autre canal (appel, en personne). L'application affiche le QR code pour que votre
correspondant le scanne ; elle ne contient pas de lecteur de QR code.

**Ce que valent les mots de sécurité.** Ils servent à repérer une clé qui n'est pas
la bonne. Ils représentent 36 bits d'empreinte. À titre d'ordre de grandeur, un
attaquant déterminé qui chercherait une fausse clé aux mêmes six mots devrait en
générer de l'ordre de 2^36 : c'est coûteux, mais pas hors de portée de moyens
sérieux. Pour un enjeu élevé, comparez l'empreinte complète.

**Épinglage du sceau.** Distinct du carnet, l'épinglage TOFU des sceaux est décrit
dans le chapitre « Signatures — Elium Sign ».

### Ligne de commande : `elium keys`

La ligne de commande gère son propre trousseau, sans jamais passer une clé privée en
argument (donc hors de l'historique du shell et de la liste des processus).

| Commande | Effet |
|---|---|
| `elium keys list` | Liste les clés : `kid`, type, état, nom, expiration, succession, empreinte |
| `elium keys generate identity` ou `recipient` | Crée une clé Ed25519 ou P-256 (`--label` pour la nommer) |
| `elium keys public <kid>` | Affiche la clé publique |
| `elium keys export` | Écrit une sauvegarde `.eliumkey` v2 (`--output`, `--kid` répétable) |
| `elium keys import <fichier>` | Importe une sauvegarde `.eliumkey` v2 |
| `elium keys rotate <kid>` | Fait tourner une clé active ; une identité reçoit un certificat de succession |

Détails :

- Le trousseau est le fichier `keyring.json` du dossier `~/.elium/keys`, ou du
  dossier donné par la variable `ELIUM_KEYS_DIR` ou par l'option `--dir`. Chaque clé y
  est chiffrée dans un conteneur v3 (Argon2id et AES-256-GCM) sous le mot de passe du
  trousseau. Les droits du fichier sont réduits au propriétaire quand le système le
  permet.
- Le mot de passe est demandé **sans écho**. La variable d'environnement
  `ELIUM_KEYRING_PASSWORD` permet les scripts, avec le risque que cela implique.
- Un `kid` peut être abrégé s'il reste unique.
- Les clés de la ligne de commande sont **aléatoires** : il n'y a ni secret maître,
  ni dérivation. La sauvegarde produite est compatible avec le Web Studio, mais sans
  secret maître. À l'import, la ligne de commande ignore le secret maître d'une
  sauvegarde Web et ne garde que les clés.
- La ligne de commande ne lit que les `.eliumkey` **v2**.

**Ouvrir un document chiffré pour des destinataires.** Les commandes `doc-open`,
`doc-sign` et `doc-verify` acceptent `--recipient-kid <kid>` : la clé de réception
vient du trousseau et son mot de passe est demandé sans écho.

L'ancienne option `--recipient-key <clé privée en hexadécimal>` est **dépréciée** :
elle affiche un avertissement, car une clé privée passée en argument reste dans
l'historique du shell et dans la liste des processus. Utilisez `elium keys generate`
ou `elium keys import`, puis `--recipient-kid`.

Pour **chiffrer** pour des destinataires, `doc-create --recipient <clé publique>`
prend des clés **publiques** (répétable). `doc-sign --key` et `--seal-key` lisent
encore un **fichier** contenant la clé privée Ed25519 : ils n'utilisent pas encore le
trousseau.
