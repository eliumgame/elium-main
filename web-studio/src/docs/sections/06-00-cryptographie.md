## Cryptographie

Ce chapitre décrit ce que fait réellement le code : algorithmes, paramètres,
formats d'enveloppe. Les clés privées, les sauvegardes et la récupération sont
traitées dans le chapitre « Elium Keys ».

### Principe : la sécurité dépend du profil

Les protections sont **optionnelles**. Les profils `standard`, `signed`, `tracked`
et `locked` laissent le contenu **non chiffré** : le fichier est portable, pas
confidentiel. `locked` et `tracked` offrent de la *détection d'altération*, pas de
la confidentialité. Les profils `protected`, `encrypted` et `secure_max` chiffrent
le corps du document. Le détail est dans « Les sept profils de protection ».

### Primitives

| Usage | Algorithme | Bibliothèque |
|---|---|---|
| Dérivation depuis un mot de passe | Argon2id | `argon2-cffi` (Python), `hash-wasm` (Web) |
| Chiffrement authentifié | AES-256-GCM | `cryptography` (Python), WebCrypto (Web) |
| Seconde couche (`secure_max`) | ChaCha20-Poly1305 | `cryptography`, `@noble/ciphers` |
| Dérivation de sous-clés | HKDF-SHA-256 | `cryptography`, WebCrypto |
| Intégrité du conteneur | HMAC-SHA-256, comparaison à temps constant | `hmac`, WebCrypto |
| Signatures et sceau | Ed25519 | `cryptography`, `@noble/ed25519` |
| Chiffrement multi-destinataires | ECDH-ES sur P-256, AES-256-GCM | `cryptography`, WebCrypto |
| Empreintes | SHA-256 | `hashlib`, WebCrypto |
| Phrase de récupération | BIP-39 (liste anglaise) | `@scure/bip39` |
| Certificats PDF (PAdES) | RSA ou courbes elliptiques, PKCS#12 | WebCrypto, `node-forge` |

Aucune primitive cryptographique n'est réimplémentée : les algorithmes viennent des
bibliothèques ci-dessus. Deux **constructions** sont en revanche écrites dans
Elium et ne sont pas auditées par un tiers : le **partage de Shamir** (arithmétique
GF(256), environ vingt lignes) et l'**assemblage du CMS PAdES** des signatures PDF
(`pdf/ops/der.ts`). Elles sont couvertes par des tests, dont un test exhaustif des
sous-ensembles pour Shamir.

### Profils Argon2id nommés

Les coûts de dérivation sont décidés à un seul endroit
(`web-studio/src/crypto/kdf-profiles.ts`). Il existe trois profils :

| Profil | `t` | Mémoire | `p` | Utilisé pour |
|---|:---:|---|:---:|---|
| `document` | 3 | 64 Mio | 1 | Conteneur v3 : corps d'un document, sauvegarde `.eliumkey`, enveloppe du secret maître, clé privée au repos. Payé à **chaque ouverture**. |
| `account` | 3 | 256 Mio | 4 | Racine du compte Drive. Payé une fois par connexion. |
| `local-cache` | 2 | 19 Mio | 1 | Brouillons, historique de versions et coffre local dans IndexedDB. Dérivation dans un Worker. |

Le profil `document` est aussi celui que le miroir Python utilise (`ARGON2_TIME`,
`ARGON2_MEMORY_KIB`, `ARGON2_PARALLELISM`). 64 Mio reste très au-dessus du minimum
OWASP 2023 pour Argon2id (19 Mio, `t` = 2). 256 Mio provoquait des manques de
mémoire sur mobile et, en WebAssembly mono-thread, `p` > 1 ne parallélise rien.

Le profil `account` n'a pas changé : les comptes Drive existants gardent les
paramètres stockés côté serveur. Les paramètres ne sont **jamais** modifiés en
silence pour un fichier ou un compte existant.

**Rétrocompatibilité.** Un fichier garde les paramètres de son écriture : `t`, `m`,
`p` et le sel sont dans l'en-tête. Un ancien fichier écrit en 256 Mio et `p` = 4 reste
lisible.

**Bornes de lecture** (identiques en Python et sur le Web), contre un en-tête
malveillant qui demanderait une allocation énorme :

| Paramètre | Minimum | Maximum |
|---|---:|---:|
| `t` (passes) | 1 | 6 |
| `m` (Kio) | 8 192 | 262 144 (256 Mio) |
| `p` (parallélisme) | 1 | 16 |

Sur le Web, Argon2id est calculé dans un **Worker** (`argon2-worker.ts`) pour ne pas
geler l'interface. Si le Worker échoue, le calcul se fait sur le thread principal,
avec les mêmes octets en sortie.

### Le conteneur chiffré par mot de passe

Chiffrement d'un corps de document, d'une sauvegarde de clés ou d'une clé privée :

1. Un sel de 16 octets est tiré au hasard.
2. La clé maîtresse de 32 octets vient d'Argon2id (profil `document`) appliqué à
   `mot de passe` ou, avec un fichier-clé, à `mot de passe + "|KF|" + SHA-256(fichier-clé)`.
3. HKDF-SHA-256 (sel de 32 octets nuls) en tire trois sous-clés, avec les
   informations `elium-v3-aes-gcm`, `elium-v3-chacha` et `elium-v3-hmac`.
4. Le manifeste interne et le contenu sont compressés (zlib) puis chiffrés en
   AES-256-GCM. L'en-tête JSON sert de **donnée associée**.
5. Pour `secure_max`, le résultat est chiffré une seconde fois en ChaCha20-Poly1305
   (voir « La cascade de `secure_max` »).
6. Une signature Ed25519 facultative est ajoutée, puis un HMAC-SHA-256 couvre tout
   ce qui précède.

À la lecture, l'ordre est : bornes KDF, algorithme déclaré, **HMAC** (avant tout
déchiffrement), signature Ed25519 si une clé publique est fournie, déchiffrement,
décompression plafonnée à 512 Mio. Un en-tête qui déclare un autre algorithme est
**refusé** au lieu d'être déchiffré en AES par défaut. Les nonces (12 octets) sont
tirés au hasard à chaque écriture.

La disposition binaire est décrite dans « Conteneur v3 (primitive de chiffrement) ».

### La cascade de `secure_max`

Le profil `secure_max` ajoute une couche ChaCha20-Poly1305 par-dessus le texte
chiffré en AES-GCM. La clé ChaCha dérive de la même clé maîtresse par HKDF, avec
un nonce propre. L'objectif est de ne pas dépendre d'un seul algorithme si l'un
d'eux était un jour affaibli.

Ce que la cascade **ne** fait **pas** : elle ne protège pas contre un mot de passe
faible. Les deux couches dérivent du même mot de passe, donc quiconque le devine
ouvre les deux. La force du mot de passe (et du fichier-clé) reste le facteur
décisif.

### Fichier-clé : second facteur

Un fichier-clé est un fichier quelconque. Son contenu entier est haché en SHA-256,
puis ajouté au mot de passe avant Argon2id. Trois règles :

- fourni **en plus** du mot de passe, il est un second facteur ;
- fourni **seul**, il remplace le mot de passe : il suffit alors à ouvrir le
  document, et sa confidentialité devient la seule protection ;
- perdu, il rend le document **définitivement illisible**.

Le fichier-clé n'est jamais écrit dans le `.elium`. Une fois le document ouvert, il
reste en mémoire le temps de la session et il est effacé au verrouillage du
trousseau.

### Chiffrement multi-destinataires

Pour chiffrer un document **pour d'autres personnes** sans mot de passe partagé,
Elium utilise une enveloppe `elium-recipients/1` (ECDH-ES sur la courbe P-256).

| Élément | Valeur |
|---|---|
| Clé de contenu (CEK) | 32 octets aléatoires |
| Chiffrement du corps | AES-256-GCM, nonce de 12 octets, donnée associée = `elium-recipients/1` |
| Par destinataire | Une paire éphémère P-256, un ECDH, puis HKDF-SHA-256 (sel nul de 32 octets, info `elium-recipients/1/wrap`) pour obtenir une clé qui emballe la CEK en AES-256-GCM |
| Clé publique | Point non compressé (`04` + X + Y), 65 octets, en hexadécimal |
| `fpr` | SHA-256 du point public, hexadécimal |
| `kid` | 16 premiers caractères de `fpr`. Champ **additif** : les anciennes enveloppes sans `kid` restent lisibles |
| `alg` | `ecdh-es-p256+aes-256-gcm`, suivi de `+chacha20-poly1305-cascade` si la cascade est active |

Avec `secure_max`, la cascade s'applique aussi aux destinataires : la CEK est
étendue par HKDF en deux sous-clés (`elium-recipients/1/cek-aes` et
`elium-recipients/1/cek-cha`) et un second nonce est stocké. Le lecteur refuse une
enveloppe dont `alg` ne correspond pas à son champ `cascade`.

**Clés retirées.** Pour déchiffrer, Elium choisit dans le trousseau la clé dont le
`kid` figure dans l'enveloppe : d'abord la clé active, puis les clés **retirées**
(après rotation). Un document chiffré avant une rotation reste donc lisible.

Propriétés et limites à connaître :

- Un document est chiffré **soit** par mot de passe, **soit** pour des
  destinataires. Les deux ne se combinent pas.
- La liste des empreintes des destinataires est dans le manifeste, **en clair**.
- ECDH-ES n'authentifie pas l'expéditeur : n'importe qui connaissant votre clé
  publique peut chiffrer pour vous. L'authenticité vient du sceau et des
  signatures.
- On ne peut pas retirer un destinataire d'un fichier déjà distribué : il garde
  sa copie et sa clé. Il faut rechiffrer le document et le redistribuer.
- Un destinataire dont la clé est **révoquée** dans le carnet est bloqué dans le
  sélecteur, mais cela ne change rien aux fichiers déjà chiffrés pour lui.

### Le sceau de document

Le sceau est une signature **Ed25519** de l'auteur sur un condensé canonique. Ce
condensé lie *ensemble* un sous-ensemble du manifeste, l'empreinte des signatures
et l'empreinte du journal :

```
message = canonicalJSON({ v:1,
  manifest:{ format, formatVersion, profile, title, language, createdAt,
             accessExpiresAt?, docId?,
             protection{encrypted, locked, keyfileRequired, contentEntry, recipients?},
             integrity{algorithm, contentHash} },
  signaturesHash: sha256(canonicalJSON(signatures)),
  journalHash:    sha256(canonicalJSON(journal)) })
```

Toute modification du contenu, du journal, de l'ensemble des signatures, du profil,
du `docId` ou de la liste des destinataires **casse le sceau**. C'est vrai même
pour un fichier `secure_max` modifié sans le mot de passe.

Les champs volatils sont exclus pour qu'un enregistrement légitime ne casse pas le
sceau : `modifiedAt`, `generator`, `features`, `rgpd`, le sceau lui-même, et le
circuit de signature.

**Verdicts :** `valid`, `unknown_key` (le sceau est authentique mais la clé n'est
pas celle attendue), `broken` et `unsealed`.

**Évolution du sous-ensemble signé.** `docId`, `accessExpiresAt` et la liste des
destinataires ont été ajoutés au fil des versions. Le vérificateur essaie la forme
complète, puis les formes plus anciennes, pour que les anciens fichiers scellés
restent valides. Conséquence : pour un fichier **scellé par une ancienne version**,
`docId` n'est pas authentifié. Un fichier scellé par une version récente l'est.

**Ce que le sceau prouve, et ne prouve pas.** Il prouve que ces parties n'ont pas
changé depuis qu'une clé donnée les a scellées. Il ne dit pas **qui** détient la
clé : un attaquant peut re-sceller un document falsifié avec **sa** clé et obtenir
un sceau `valid`, mais avec une empreinte de clé différente. Il faut comparer cette
empreinte à une clé connue (carnet de confiance, épinglage TOFU). Voir le chapitre
« Signatures — Elium Sign ».

> **Le verdict n'est pas bloquant à l'ouverture.** `read_elium` et
> `readEliumPackage` calculent le verdict mais **ne lèvent jamais d'exception** si
> le sceau est `broken` : ils renvoient quand même le document, pour permettre
> d'inspecter un fichier suspect. Toute intégration qui exige une garantie stricte
> doit tester `result.seal.verdict !== "broken"`. Les interfaces livrées (CLI et Web
> Studio) affichent le verdict et un bandeau d'alerte, sans bloquer l'ouverture.

### Chiffrement optionnel des métadonnées

Sur un profil chiffré, l'option « Chiffrer aussi les métadonnées » déplace le
titre, les signatures, le journal et le circuit de signature dans une enveloppe
`elium-secure/1`, **à l'intérieur** du corps chiffré. Les entrées en clair sont
vidées : titre « Document chiffré », signatures et journal vides.

C'est une option, désactivée par défaut : les métadonnées en clair permettent de
lister et de rechercher sans ouvrir le fichier.

Même avec l'option, **ces éléments restent lisibles sans mot de passe** :

- le profil, la langue, les dates de création et de modification, le `docId` ;
- les indicateurs de protection (chiffré, verrouillé, fichier-clé requis) ;
- l'empreinte du contenu chiffré ;
- le sceau : clé publique, empreinte et date de scellement de l'auteur ;
- les empreintes des destinataires, pour un document chiffré pour des clés ;
- la taille du fichier et les noms des entrées de l'archive, dont l'index des
  polices embarquées ;
- la date d'expiration d'accès, si elle existe.

### Chiffrement du Drive d'entreprise

Le Drive applique la même primitive de destinataires à chaque **nœud** (fichier ou
dossier). Détails dans le chapitre « Le Drive d'entreprise » ; en résumé :

- chaque nœud a une clé de 32 octets tirée au hasard, qui chiffre le contenu, le
  nom et les métadonnées en AES-256-GCM (donnée associée `elium-drive/node/1`) ;
- cette clé est emballée pour chaque personne ou lien autorisé avec l'enveloppe
  `elium-recipients/1` ;
- le serveur ne voit que du chiffré et ne détient jamais de clé de contenu.

**Rembourrage PADMÉ.** Avant chiffrement, le contenu est complété jusqu'à une taille
« en palier » (algorithme PADMÉ, article PURBs, 2019). Le serveur ne voit plus la
taille exacte, seulement le palier. Le surcoût est borné à environ 12 %. Le format
est : longueur réelle sur 4 octets (grand-boutiste), contenu, puis des zéros. Un
minimum de 64 octets cache les très petites tailles. Le rembourrage s'applique aux
contenus, noms, métadonnées et mises à jour collaboratives du Drive. Il ne
s'applique **pas** aux fichiers `.elium` locaux.

### Chiffrement des données locales du navigateur

Les brouillons de récupération, l'historique des versions et le coffre local sont
stockés dans IndexedDB. Pour un document protégé, leur contenu est chiffré avec
le **secret du document** (mot de passe et/ou fichier-clé) : Argon2id profil
`local-cache` puis AES-256-GCM, un sel et un nonce aléatoires. Il n'y a pas de mot
de passe maître local de plus.

Pour un document **non protégé**, le brouillon et l'historique sont stockés en
**clair** dans le navigateur, avec un export Word prêt à l'emploi. Les anciennes
données dérivées en PBKDF2-100 000 restent lisibles.

Le **coffre local** est une phrase de passe d'application, facultative. Il protège
l'index local du Drive (titres) et la liste des signataires du Parapheur. Sa
vérification utilise un témoin chiffré, jamais le mot de passe lui-même.

### Mots de passe et secrets

- Elium ne stocke ni ne transmet jamais un mot de passe ou un fichier-clé en
  clair. Les mots de passe ne sont jamais écrits dans le `.elium`.
- Les clés privées ne sont jamais écrites en clair : voir « Elium Keys ».
- Un mot de passe de document ne se récupère pas (voir la section suivante).

### Aucun recouvrement local (zéro-connaissance)

**La perte du mot de passe et/ou du fichier-clé d'un document chiffré est
définitive et sans recours.** Il n'existe pas de clé maîtresse, pas de « mot de
passe oublié », pas de porte dérobée. Conservez ces secrets dans un gestionnaire de
mots de passe.

Les **clés** (identité de signature, clé de réception) disposent en revanche de
plusieurs voies de récupération volontaires : sauvegarde `.eliumkey`, phrase de 24
mots, parts de Shamir. Voir « Elium Keys ». Ces voies doivent être préparées
**avant** la perte.

Le **coffre local** suit la même logique. Si vous l'oubliez, le contenu protégé n'est
pas récupérable : il peut seulement être réinitialisé, ce qui vide l'index local
reconstruit. Les fichiers `.elium` sur le disque ne sont pas touchés.

Côté Drive d'entreprise, le recouvrement d'organisation est la seule voie de
récupération d'accès à un nœud. Voir « Recouvrement d'organisation ».

### Limites de lecture et robustesse (DoS)

Les bornes KDF, les plafonds ZIP (128 Mio par entrée, 384 Mio au total, 10 000
entrées), la décompression plafonnée à 512 Mio et la garde de profondeur JSON sont
identiques en Python et en TypeScript. Voir « Limites de lecture et robustesse » dans
le chapitre « Le format `.elium` ».

### Interopérabilité Python et TypeScript

Les deux implémentations produisent les **mêmes octets** pour les mêmes entrées. La
garantie repose sur trois mécanismes :

- un **JSON canonique** unique (voir « Journal de suivi et JSON canonique ») ;
- des constantes de format identiques : informations HKDF, sels, données associées,
  noms de champs ;
- des **tests croisés** : les tests Vitest appellent l'implémentation Python
  (`tests/python/interop_helper.py`) pour écrire un fichier lu par le Web, puis
  l'inverse. Ils couvrent les paquets v4, le sceau, le conteneur v3, le fichier-clé,
  la sauvegarde `.eliumkey` v2 et l'enveloppe des destinataires. La CI installe Python pour les exécuter. En
  local, ils sont **ignorés** si aucun interpréteur Python n'est trouvé.

### Limites connues de la cryptographie

- Pas d'audit cryptographique externe du code d'Elium. Les primitives viennent de
  bibliothèques courantes, mais l'assemblage (conteneur, enveloppes, Shamir, CMS
  PAdES) est propre au projet.
- Pas de résistance post-quantique : Ed25519, P-256 et ECDH seraient cassés par un
  ordinateur quantique suffisamment grand. AES-256 et SHA-256 restent solides.
- Les clés restent en mémoire du navigateur tant que le trousseau est déverrouillé
  (voir « Modèle de sécurité et de menace »).
- Un mot de passe faible reste attaquable hors ligne, Argon2id ou non.
- La compatibilité d'un fichier avec les futures versions repose sur les champs
  `version` du conteneur et `formatVersion` du manifeste. Les lecteurs refusent ce
  qu'ils ne connaissent pas.

---
