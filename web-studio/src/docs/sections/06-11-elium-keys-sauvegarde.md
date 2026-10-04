### Sauvegarde `.eliumkey` v2

La sauvegarde `.eliumkey` v2 est **un seul fichier chiffré** qui porte vos clés
(Ed25519 et P-256) et, quand le trousseau en a un, le **secret maître**. Elle se
crée avec « Sauvegarder tout (.eliumkey) » ou avec « Exporter » sur une clé.

Elle est chiffrée par un **mot de passe de sauvegarde**, demandé à chaque export. Ce
mot de passe est distinct de celui du trousseau : notez-le séparément du fichier.
Le nom suggéré est `elium-cles-AAAA-MM-JJ.eliumkey`, sans empreinte ni identité.

> Même l'export d'**une seule** clé embarque le secret maître si le trousseau en a
> un. Traitez tout fichier `.eliumkey` comme une sauvegarde complète.

**Structure du fichier (JSON)**

| Champ | Contenu |
|---|---|
| `format`, `version` | `"elium-key"` et `2` |
| `suite` | `"elium-keybundle/1"` : l'ensemble d'algorithmes du fichier |
| `kdf` | `argon2id` avec `t`, `m`, `p` (profil `document` : 3, 65 536 Kio, 1) |
| `cipher` | `"aes-256-gcm"` |
| `keys` | Pour chaque clé, les métadonnées **en clair** : `kid`, `type`, `suite`, `label`, `createdAt`, `expiresAt`, `status`, `publicHex`, `fingerprint`, `derivationIndex`, `succession` |
| `enc` | Conteneur v3 chiffré (hexadécimal) qui contient les secrets |
| `exportedAt` | Date d'export (informative) |

Le contenu chiffré (`enc`) est un JSON canonique : `v: 2`, `bound`, `secrets`
(clé privée par `kid`) et `master` (secret maître, facultatif).

**En-tête externe authentifié.** Les champs en clair (`format`, `version`, `suite`,
`kdf`, `cipher`, `keys`) ne sont pas couverts par le chiffrement. Le conteneur
chiffré transporte donc leur empreinte (`bound` = SHA-256 de leur JSON canonique).
À l'ouverture, Elium la recalcule : modifier un libellé, un état, une date ou un
`kid` est détecté. Les paramètres `kdf` et `cipher` annoncés doivent aussi être
**exactement** ceux de l'en-tête du conteneur, lui-même authentifié. Seul
`exportedAt` n'est pas authentifié.

**Validation stricte à la lecture.** Le fichier est refusé si :

- le `format`, la `version` ou la `suite` ne sont pas ceux attendus. Une suite
  inconnue est **refusée** au lieu d'être devinée (agilité cryptographique) ;
- le KDF n'est pas Argon2id ou ses paramètres sortent des bornes ;
- une clé a un type ou une suite inconnus, une clé publique mal formée (Ed25519 : 64
  hexadécimaux ; P-256 : `04` suivi de 128 hexadécimaux), un état invalide, ou un
  `kid` qui n'a pas la forme de 16 hexadécimaux ;
- deux clés ont le même `kid` ;
- une clé privée manque, ne correspond pas à la clé publique annoncée, ou
  l'empreinte ne correspond pas à la clé publique, ou le `kid` aux 16 premiers
  caractères de l'empreinte.

**Confidentialité du fichier.** Les métadonnées des clés sont lisibles sans mot de
passe : on voit le nombre de clés, leurs noms, leurs états et leurs clés publiques.
Les clés privées et le secret maître ne le sont pas.

**Anciens fichiers.** Le Web Studio lit encore les `.eliumkey` **v1** (une identité
Ed25519 seule, protégée par son mot de passe). La ligne de commande ne lit que la
v2.

**Importer.** « Importer une sauvegarde » demande le mot de passe de la sauvegarde.

- Si le fichier porte un secret maître et que le trousseau n'en a pas, le secret est
  installé : les clés dérivées restent dérivées et le **mot de passe de la
  sauvegarde devient celui du trousseau**.
- Si le trousseau a déjà un secret maître, chaque clé importée est chiffrée par le
  mot de passe de la sauvegarde (clé « héritée », avec son propre mot de passe).
- Les clés dont le `kid` existe déjà sont ignorées.

**Sauvegarde imposée.** Elium impose une sauvegarde à la création d'une clé de
réception et lors d'une rotation. Il la propose avant toute suppression.

### Phrase de récupération de 24 mots

La phrase de récupération code le **secret maître** en 24 mots **BIP-39** (liste
anglaise officielle) : 256 bits d'entropie et 8 bits de somme de contrôle. Comme
toutes les clés créées par le trousseau en dérivent, cette phrase suffit à
retrouver identité de signature et clé de réception sur une machine vierge. La
liste anglaise est celle que reconnaît tout outil BIP-39.

Le parcours dans l'interface :

1. Une alerte rappelle qu'une phrase équivaut à toutes vos clés.
2. Les 24 mots s'affichent (masquables). Notez-les sur papier.
3. Elium demande **4 mots tirés au hasard** (positions croissantes) pour vérifier que
   la notation est lisible. La date de vérification est mémorisée.

Cette vérification contrôle que vous savez ressaisir la phrase affichée. Elle ne
prouve pas que le papier existe.

**Restaurer.** Le menu « Restaurer le trousseau » accepte la phrase. La saisie est
tolérante (casse, espaces multiples, retours à la ligne, numérotation) et la somme
de contrôle est vérifiée. Un **nouveau mot de passe** est demandé. Elium réinstalle
le secret maître et re-dérive les **indices 0 à 3** de chaque type.

Ce que la restauration par phrase ne sait pas faire :

- elle ne connaît pas l'historique réel de vos rotations : l'indice 0 est marqué
  **actif** et les indices 1 à 3 **retirés**, même si votre clé active était en réalité
  l'indice 2. Vous pouvez réactiver la bonne clé depuis « Mes clés » ;
- les clés d'indice 4 ou plus ne sont **pas** retrouvées ;
- les clés **héritées** (aléatoires, non dérivées) ne sont **pas** couvertes :
  seul un `.eliumkey` les porte ;
- elle ne restaure ni le carnet de confiance, ni les sceaux épinglés.

Quiconque lit les 24 mots peut se faire passer pour vous. Ne les photographiez pas.

### Parts de Shamir

Le **partage de secret de Shamir** répartit le secret maître entre plusieurs
personnes ou supports : **k parts quelconques** sur **n** le reconstituent, et
**k − 1 parts n'apprennent rien** (sécurité inconditionnelle). On l'utilise pour
qu'aucune personne seule ne détienne la récupération.

| Paramètre | Valeur |
|---|---|
| Bornes | 2 ≤ k ≤ n ≤ 16 (valeurs proposées : k = 2, n = 3) |
| Arithmétique | Corps GF(256), polynôme `0x11b`, octet par octet |
| Fichier d'une part | `.eliumshare` (JSON) |

Un fichier `.eliumshare` porte : `format: "elium-share"`, `version: 1`, `setId`
(identifiant du lot), `k`, `n`, `x` (abscisse de la part), `y` (ordonnées, en
hexadécimal), `check` et `createdAt`. Le `check` est le début (8 octets) du SHA-256
du secret : il ne permet pas de retrouver le secret mais détecte une part erronée.
Si plus de k parts sont fournies et que l'une est corrompue, la reconstitution
cherche un sous-ensemble cohérent avec ce témoin.

**Une part n'est pas chiffrée.** Une part seule ne révèle rien, mais k fichiers
réunis donnent le secret maître sans mot de passe. Répartissez-les entre des
personnes ou des lieux distincts. Comme la phrase, les parts ne récupèrent que le
secret maître : mêmes limites.

### Préparation à la récupération

La rubrique « Préparation à la récupération » de « Mes clés » liste trois étapes et
calcule un score de 0 à 3 :

| Étape | Condition |
|---|---|
| Sauvegarde `.eliumkey` effectuée | **Toutes** vos clés non révoquées ont une date de sauvegarde |
| Phrase de récupération vérifiée | Les 4 mots ont été ressaisis une fois |
| Clé d'accès enrôlée | Au moins une passkey est enrôlée |

À 3 sur 3, Elium annonce que la récupération est prête. À 0, il avertit
qu'une réinitialisation du navigateur détruirait vos clés. L'export des parts de
Shamir est suivi à part et **ne compte pas** dans le score.

### Rotation et certificat de succession

**Faire tourner une identité de signature** crée une nouvelle clé (indice suivant)
et passe l'ancienne à « retirée ». Elle reste vérifiable. Les deux clés sont liées
par un **certificat de succession**.

| Champ du certificat | Contenu |
|---|---|
| `type` | `"elium-succession/1"` |
| `oldPublicKeyHex`, `newPublicKeyHex` | Les deux clés publiques |
| `issuedAt` | Date d'émission |
| `oldSig` | Signature Ed25519 de l'**ancienne** clé |
| `newSig` | Signature Ed25519 de la **nouvelle** clé : preuve de possession |

Les deux signatures portent sur le JSON canonique de `type`, des deux clés et de la
date. Quelqu'un qui fait déjà confiance à l'ancienne clé peut vérifier le
certificat. Le certificat est stocké avec la nouvelle clé, voyage dans la
sauvegarde `.eliumkey` et se vérifie en Python comme en TypeScript.

**Faire tourner une clé de réception** crée une nouvelle clé. L'ancienne est
**conservée** dans la liste de déchiffrement : le champ `kid` de l'enveloppe
retrouve la bonne clé. Communiquez votre nouvelle clé publique à vos
correspondants.

La rotation ne s'applique qu'à une clé **active**. Elle impose une sauvegarde.

### Expiration et révocation

- **Expiration** : sur chaque clé, l'action « Expiration » fixe une date
  (AAAA-MM-JJ). À cette date la clé passe à l'état **expirée**. Un avertissement
  s'affiche 30 jours avant.
- **Révocation** d'une de **vos** clés : elle la rend non réactivable et ajoute la
  clé publique à la liste de révocation du carnet, avec la raison « compromise ».
- Une clé révoquée ou expirée (selon cette liste ou la date d'expiration d'un
  contact) s'affiche à côté de l'état TOFU du sceau dans le bandeau de vérification
  et est bloquée dans le sélecteur de destinataires.

Le modèle du carnet prévoit aussi une expiration et une révocation par contact
(raisons « compromise », « remplacée », « autre »). **Aucun écran ne permet encore
de les saisir** pour un contact : voir « Limites connues d'Elium Keys ».

La révocation est **locale** : elle vit dans votre navigateur. Elle n'est ni
publiée, ni transmise à vos correspondants.
