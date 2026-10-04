## Le format `.elium`

**Statut : v4** — format documentaire. La v3 (conteneur binaire chiffré
mono-fichier) reste lisible en mode *hérité* et sert de **primitive de
chiffrement** à la v4.

### Structure de l'archive (ZIP style OPC)

```
document.elium (ZIP)
├── mimetype                    "application/x-elium"  (stocké, non compressé, 1ʳᵉ entrée)
├── manifest.json               manifeste (TOUJOURS en clair)
├── content/document.json       corps (profils non chiffrés)      ── ou ──
├── content/document.elium      corps chiffré (conteneur v3)      (profils chiffrés)
├── signatures/signatures.json  signatures visuelles + preuves cryptographiques
├── tracking/journal.json       journal d'évènements chaîné par hash
├── resources/index.json + resources/<sha256>   ressources adressées par contenu
└── meta/rgpd.json              métadonnées RGPD
```

Détection : v4 commence par `PK\x03\x04` (ZIP) ; v3 hérité par `ELIUM\x03`. Pour
les profils chiffrés, **seul le corps** est chiffré ; le manifeste, le journal et
la liste des signatures restent lisibles par conception (sauf option de
chiffrement des métadonnées, §6.4).

### Manifeste, intégrité, sceau

Le manifeste (`format`, `formatVersion:4`, `profile`, `title`, dates,
`protection{…}`, `integrity{algorithm, contentHash}`, `features`, `rgpd`, `seal?`)
est **toujours en clair**. `integrity.contentHash` est le SHA-256 des octets
stockés : il détecte une **corruption accidentelle**, pas une altération délibérée
(il vit dans le manifeste en clair, donc recalculable par un attaquant). La
détection anti-altération est assurée par le **sceau** (§6.3).

### Modèle de document

`content/document.json` : `{ schema:"elium-doc/1", page{format, orientation,
margins(mm), showPageNumbers}, doc{arbre ProseMirror/TipTap} }`. Nœuds :
paragraph, heading, listes/tâches, blockquote, codeBlock(language),
horizontalRule, image, table/row/header/cell. Marques : bold, italic, underline,
strike, code, link, highlight, textStyle(color/fontFamily/fontSize).

### Journal de suivi & JSON canonique

Le journal `tracking/journal.json` est une suite d'évènements **chaînés par hash**
(`hash = sha256(prevHash + canonicalJSON(payload))`) — toute rupture indique une
altération. Types : `document.created/modified/opened`,
`signature.added/validated`, `protection.enabled`, `document.locked`, `export`.

Les événements de consultation (ouverture, export, validation de signature) sont
**mis en file en mémoire et versés au moment du save**, juste avant le
(re)scellement : consulter un document scellé ne casse jamais son sceau.
`document.modified` = une entrée par sauvegarde.

**JSON canonique** (empreintes reproductibles TS↔Python) : clés triées
récursivement, séparateurs `","`/`":"`, UTF-8, clés vides omises ; les empreintes
sont des SHA-256 sur l'UTF-8 du JSON canonique.

### Ressources adressées par contenu et `docId`

Les ressources (polices embarquées, images) vivent dans `resources/` nommées par
leur `sha256`, référencées par `resources/index.json` — donc couvertes par le
sceau et chiffrées avec le document. Le **`docId` (UUID)** est l'identifiant stable
du document (index local versions/Parapheur/pinning), avec repli sur `createdAt`
pour les fichiers hérités (`docKeyOf`) ; il est hors du sous-ensemble signé du
sceau.

### Conteneur hérité v3 (primitive de chiffrement)

```
Magic(6) ELIUM\x03 | HeaderLen(4 BE) | Header JSON | CiphertextLen(8 BE) |
Ciphertext (AES-GCM ± ChaCha20) | Signature(64 Ed25519, opt.) | HMAC(32)
```

### Parité Python ↔ TypeScript

Le format, le sceau, les signatures et le chiffrement sont **byte-for-byte
identiques** entre l'implémentation Python et TypeScript, prouvés par des fixtures
d'interop croisées (dans les deux sens). Cela couvre `sealMessage`, la preuve de
signature, le JSON canonique et l'enveloppe `elium-secure/1`. Les fichiers miroirs
critiques : `canonical.py↔canonical.ts`, `journal.py↔journal.ts`,
`profiles.py↔profiles.ts`, `package.py↔elium-package.ts`, `proof.py↔proof.ts`.

---
