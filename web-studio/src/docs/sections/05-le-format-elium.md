## Le format `.elium`

Un document Elium est un fichier **`.elium`** : une archive ZIP (style OPC) qui
contient le document, ses signatures, son journal et son manifeste. La version
courante du format est la **v4** (`formatVersion: 4`). Un lecteur refuse un
fichier dont la version est supérieure à la sienne.

L'ancien conteneur binaire **v3** (un seul bloc chiffré) n'est plus un format de
document. Il sert de **primitive de chiffrement** : le corps d'un document chiffré,
une sauvegarde `.eliumkey`, une clé privée au repos et une sauvegarde d'espace de
travail chiffrée sont tous des conteneurs v3.

### Les fichiers d'Elium

| Extension | Contenu | Chiffré ? | Détail |
|---|---|:---:|---|
| `.elium` | Un document (texte, classeur, présentation ou PDF) | selon le profil | Ce chapitre |
| `.eliumkey` v1 | Une identité de signature Ed25519 | oui | Ancien format, lecture conservée |
| `.eliumkey` v2 | Un trousseau complet de clés | oui | Voir « Sauvegarde `.eliumkey` v2 » |
| `.eliumshare` | Une part de Shamir du secret maître | non | Voir « Parts de Shamir » |
| `.elium-workspace` | Tout l'espace de travail local | en option | Ci-dessous |
| `.eliumupdate` | Une mise à jour hors ligne signée | non (signée) | Ci-dessous |

### Structure de l'archive (ZIP style OPC)

```
document.elium (ZIP)
├── mimetype                    "application/x-elium"  (stocké, non compressé, 1ʳᵉ entrée)
├── manifest.json               manifeste (TOUJOURS en clair)
├── content/document.json       corps (profils non chiffrés)      ── ou ──
├── content/document.elium      corps chiffré                     (profils chiffrés)
├── signatures/signatures.json  signatures visuelles + preuves cryptographiques
├── tracking/journal.json       journal d'évènements chaîné par empreinte
├── parapheur/circuit.json      circuit de signature (facultatif)
├── resources/index.json        index des ressources
├── resources/<sha256>          ressources adressées par contenu
└── meta/rgpd.json              métadonnées RGPD
```

Le corps chiffré est soit un conteneur v3 (mot de passe et/ou fichier-clé), soit
une enveloppe `elium-recipients/1` (clés de réception). Les deux sont décrits dans
le chapitre « Cryptographie ». Le contenu chiffré n'est pas recompressé : il est
stocké tel quel dans le ZIP.

### Détection et lecture

- Un `.elium` v4 commence par `PK\x03\x04` (ZIP). Un conteneur v3 commence par
  `ELIUM\x03`.
- Le lecteur exige l'entrée `mimetype` avec la valeur exacte
  `application/x-elium`. Une archive ZIP quelconque renommée en `.elium` est
  refusée.
- Le lecteur refuse une entrée ZIP en double. Deux outils pourraient sinon lire
  deux occurrences différentes, dont une hors du sceau.
- Les ressources dont `sha256(octets)` ne correspond pas à leur nom sont
  ignorées. Elles sont signalées comme altérées dans le verdict d'intégrité.
- Les plafonds anti-bombe sont décrits dans « Limites de lecture et robustesse ».

### Manifeste, intégrité, sceau

Le manifeste est **toujours en clair**, même pour un document chiffré.

| Champ | Contenu |
|---|---|
| `format`, `formatVersion` | `"elium"` et `4` |
| `profile` | Un des sept profils (voir « Les sept profils de protection ») |
| `generator` | Chaîne informative (`elium-web/…` ou `elium-py/…`) |
| `docId` | UUID stable du document |
| `createdAt`, `modifiedAt` | Dates ISO 8601 UTC, à la seconde |
| `title`, `language` | Titre et langue (`fr` par défaut) |
| `protection` | `encrypted`, `locked`, `keyfileRequired`, `contentEntry`, et si présents `metadataEncrypted` et `recipients` (empreintes des destinataires) |
| `integrity` | `algorithm: "sha-256"` et `contentHash` |
| `features` | Indicateurs : signatures, suivi, nombre de ressources |
| `rgpd` | `localOnly`, liste des données personnelles stockées, avis |
| `accessExpiresAt` | Date d'expiration d'accès, facultative |
| `seal` | Le sceau Ed25519, facultatif |

`integrity.contentHash` est le SHA-256 des octets stockés dans `contentEntry`. Il
détecte une **corruption accidentelle**. Il ne détecte pas une altération
volontaire : il vit dans le manifeste en clair, donc un attaquant le recalcule.
L'anti-altération repose sur le **sceau** (voir « Le sceau de document »).

Le champ `accessExpiresAt` est signé par le sceau quand il existe. C'est un
repère affiché à l'ouverture. Il n'empêche pas techniquement de lire un fichier
non chiffré, ni de déchiffrer un fichier dont on connaît le secret.

### Le docId

Le `docId` est un UUID créé à la première écriture. Il identifie le document dans
les index locaux : historique des versions, Parapheur. Pour un fichier ancien sans
`docId`, l'application retombe sur `createdAt` (fonction `docKeyOf`).

Depuis les versions récentes, le `docId` est **couvert par le sceau** quand il est
présent. Un fichier scellé avant son introduction reste valide (voir « Le sceau
de document »).

> L'épinglage TOFU du sceau est indexé par `createdAt`, pas par `docId`. Les
> deux sont signés par les sceaux récents, mais `createdAt` l'est aussi par les
> sceaux anciens. Voir « Épinglage TOFU du sceau ».

### Modèle de document

`content/document.json` contient :

- `schema` : `"elium-doc/1"` ;
- `page` : format, orientation, marges en millimètres, dimensions personnalisées,
  en-tête et pied de page, numéros, grille, fond, bordure, numérotation de
  lignes ;
- `styles` : les styles nommés propres au document (facultatif) ;
- `watermark` et `theme` (facultatifs) ;
- `doc` : l'arbre ProseMirror/TipTap du texte.

Les classeurs, présentations et PDF enregistrés en `.elium` utilisent le même
conteneur. Leur contenu est porté par un nœud dédié (`eliumSheet`, `eliumSlides`
ou `eliumPdf`) dont l'attribut `data` contient l'objet sérialisé en JSON. Il n'existe
pas d'autre extension pour les PDF : l'enveloppe PDF contient les octets du PDF
source et tout l'état d'édition (annotations, ordre des pages, marques de
caviardage en attente).

### Journal de suivi et JSON canonique

Le journal `tracking/journal.json` est une suite d'évènements **chaînés par
empreinte**. Chaque évènement porte `seq`, `type`, `at`, éventuellement `actor` et
`data`, puis `prevHash` et `hash`.

```
hash = sha256( prevHash + canonicalJSON({ seq, type, at, actor?, data? }) )
```

Le premier `prevHash` est une chaîne de 64 zéros. Si un évènement est modifié, la
chaîne casse à partir de lui. Une chaîne réécrite **en entier** reste cohérente :
seul le sceau détecte alors la réécriture.

Types d'évènements : `document.created`, `document.modified`, `document.opened`,
`signature.added`, `signature.validated`, `protection.enabled`,
`document.locked`, `export`.

Les évènements de consultation (ouverture, export, validation de signature) sont
**mis en file en mémoire** et versés au moment de l'enregistrement, juste avant le
(re)scellement. Consulter un document scellé ne casse donc jamais son sceau.
`document.modified` ajoute une entrée par enregistrement.

**JSON canonique.** Les empreintes doivent être identiques en TypeScript et en
Python. La forme canonique est :

- clés d'objet triées récursivement ;
- aucun espace superflu (séparateurs `,` et `:`) ;
- UTF-8, sans échappement ASCII ;
- valeurs `undefined` ignorées (comme `JSON.stringify`) ;
- nombres non finis (`NaN`, `Infinity`) **refusés** par les deux implémentations.

Les empreintes sont des SHA-256 sur l'UTF-8 de ce JSON.

### Ressources adressées par contenu

Les ressources (aujourd'hui : les polices embarquées) vivent dans `resources/`,
nommées par leur `sha256` et décrites par `resources/index.json` (`id`, `name`,
`mime`, `size`, `kind`). À la lecture, une ressource dont l'empreinte ne
correspond pas à son nom est rejetée.

**Attention : ressources et confidentialité.** Dans l'implémentation actuelle, les
entrées `resources/` sont écrites **telles quelles dans le ZIP, y compris pour un
profil chiffré**. Elles ne sont ni chiffrées, ni couvertes par `contentHash`, ni
par le sceau. Les images d'un document ne sont pas concernées : elles sont
intégrées au corps du document, donc chiffrées avec lui. Voir « Limites connues du
format ».

### Le circuit de signature (parapheur)

`parapheur/circuit.json` contient la liste ordonnée des parties : nom, rôle,
statut (`pending`, `signed`, `rejected`), et pour une partie signée le lien vers
sa vraie signature Ed25519. Un champ `requestedAt` marque une demande de signature
exportée.

Le circuit est une **métadonnée de flux de travail modifiable**. Il n'est **pas**
couvert par le sceau : la preuve reste dans les signatures Ed25519. Avec
l'option « Chiffrer aussi les métadonnées », il est chiffré avec elles, car les
noms des parties sont des données personnelles.

### Conteneur v3 (primitive de chiffrement)

```
Magic(6) "ELIUM\x03" | HeaderLen(4, BE) | En-tête JSON | CiphertextLen(8, BE) |
Texte chiffré | Signature Ed25519 (64, facultative) | HMAC-SHA256 (32)
```

L'en-tête JSON (en clair, authentifié) déclare :

| Champ | Contenu |
|---|---|
| `version` | `3` |
| `kdf` | `alg: "argon2id"`, `t`, `m` (Kio), `p`, `salt` (16 octets, hex) |
| `crypto` | `cipher: "aes-256-gcm"`, `cascade` (`null` ou `"chacha20-poly1305"`), `nonce_aes`, `nonce_cha` |
| `flags` | `compressed` (zlib), `signed`, `keyfile_required` |
| `signatures` | Empreinte du signataire et date, si le conteneur est signé |

Le texte chiffré contient : longueur du manifeste interne (4 octets), manifeste
interne JSON, puis le contenu, le tout compressé en zlib puis chiffré. L'en-tête
sert de donnée associée (AAD) à AES-GCM et à ChaCha20-Poly1305. Le HMAC couvre tout
ce qui précède, signature comprise. Les paramètres KDF sont **lus dans l'en-tête** :
un fichier garde les paramètres avec lesquels il a été écrit.

### Parité Python et TypeScript

Le format, le sceau, les signatures, le chiffrement et les sauvegardes de clés sont
implémentés deux fois, en Python (`src/elium/`) et en TypeScript
(`web-studio/src/`). Les sorties sont **identiques octet pour octet**. Elles sont
vérifiées par des fixtures d'interopérabilité croisées, dans les deux sens, au
sein des tests Vitest et pytest.

Les fichiers miroirs critiques :

| Python | TypeScript |
|---|---|
| `format/canonical.py` | `format/canonical.ts` |
| `format/journal.py` | `format/journal.ts` |
| `format/profiles.py` | `format/profiles.ts` |
| `format/package.py` | `format/elium-package.ts` |
| `format/seal.py` | `sign/seal.ts` |
| `format/proof.py` | `sign/proof.ts` |
| `core/container.py` | `crypto/elium-crypto.ts` |
| `crypto/recipients.py` | `crypto/recipients.ts` |
| `crypto/keybundle.py` | `crypto/keyfile-v2.ts` |

Ce miroir porte sur le **format et la cryptographie**. L'interface, le trousseau
IndexedDB, les passkeys, la phrase de récupération et le partage de Shamir n'existent
que côté Web Studio. La ligne de commande Python gère son propre trousseau (voir
« Ligne de commande : `elium keys` »).

### Limites de lecture et robustesse

| Garde | Valeur |
|---|---|
| Entrées ZIP | 10 000 au maximum |
| Taille d'une entrée décompressée | 128 Mio |
| Taille totale décompressée | 384 Mio |
| Décompression d'un conteneur v3 | 512 Mio |
| Profondeur JSON | 200 niveaux |
| Bornes KDF acceptées en lecture | `t` de 1 à 6, `m` de 8 192 à 262 144 Kio, `p` de 1 à 16 |

Les tailles sont contrôlées deux fois : sur les tailles **déclarées** dans le ZIP,
puis sur les tailles **réelles** après décompression. Les erreurs sont typées
(`EliumPackageError` côté Web, `EliumError` côté Python). Ces gardes sont
exercées par les scripts de sécurité exécutés en CI (voir « Preuves de sécurité en
intégration continue »).

### Sauvegarde d'espace de travail (`.elium-workspace`)

C'est une archive ZIP qui contient tout l'espace de travail local :

| Entrée | Contenu |
|---|---|
| `manifest.json` | `format: "elium-workspace"`, `version: 1`, date, version de l'application, `includesSecrets`, compteurs |
| `catalog.json` | Dossiers et éléments (titre, type, étiquettes, corbeille) |
| `settings.json` | Préférences de l'interface (aucun secret) |
| `content/…` | Le contenu brut de chaque élément |
| `secrets.json` | **Seulement sur demande** : les clés stockées dans `localStorage` (`elium_identity`, `elium_recipient_key`, `elium_trust_book`, `elium_seal_pins`) |

Le fichier peut être **chiffré par mot de passe** : l'archive entière est alors
enveloppée dans un conteneur v3. Un fichier qui ne commence pas par `PK` est lu
comme un conteneur chiffré. Plafonds à la lecture : 50 000 entrées, 256 Mio par
entrée.

Cette sauvegarde ne remplace pas la sauvegarde des clés. Elle ne contient pas le
trousseau IndexedDB `elium-keys` : ni le secret maître, ni les clés dérivées.
Utilisez la sauvegarde `.eliumkey` ou la phrase de récupération (voir « Elium Keys »).

### Mise à jour hors ligne (`.eliumupdate`)

Un `.eliumupdate` est une archive ZIP produite par la CI de publication. Elle
contient le manifeste signé de la version (`latest.json` et `latest.json.sig`) et
les artefacts qu'un poste installé peut appliquer (exécutable, interface légère,
pack d'assets). Le client la vérifie **exactement comme une mise à jour en
ligne** : signature Ed25519 du manifeste, puis SHA-256 de chaque artefact extrait.
On peut donc la transporter par clé USB ou messagerie sans élargir la confiance.
Le chapitre « Mises à jour automatiques » décrit le circuit complet.

### Limites connues du format

- Le **manifeste, les signatures, le journal et l'index des ressources sont en
  clair** par défaut, même dans un profil chiffré. L'option « Chiffrer aussi les
  métadonnées » déplace le titre, les signatures, le journal et le circuit dans le
  corps chiffré, mais pas tout : voir « Chiffrement optionnel des métadonnées ».
- `integrity.contentHash` n'est pas une protection contre une modification
  volontaire. Seul un sceau (ou une signature vérifiée) l'est.
- Les **ressources** (polices embarquées) restent **en clair** et **hors sceau**,
  même dans un profil chiffré. Leur nom (sha256) est vérifié à la lecture, ce qui
  détecte une substitution naïve mais ne l'authentifie pas. Les noms des polices
  de l'index révèlent les typographies utilisées.
- Le **circuit de signature** n'est pas scellé.
- L'ouverture d'un fichier au sceau rompu **n'est pas bloquée** par le lecteur
  (voir « Le sceau de document »).
- Le champ `generator` est une indication, pas une preuve de provenance.

---
