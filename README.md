# Elium

**Suite bureautique et Drive d'entreprise chiffrés, _local-first_ et _zéro-connaissance_ — autour d'un format de fichier `.elium` portable, signable et scellé.**

Elium n'est pas un simple conteneur chiffré : c'est un écosystème documentaire complet pour **rédiger, calculer, présenter, annoter des PDF, signer, protéger et vérifier** des documents — puis les enregistrer dans un fichier `.elium` portable et vérifiable. **Par défaut, aucun document n'est envoyé en ligne.** Le Drive d'entreprise optionnel est auto-hébergé et **chiffré de bout en bout** (le serveur ne voit jamais le contenu en clair).

> 📖 **Documentation complète** : [DOCUMENTATION.md](DOCUMENTATION.md) (installation, format, sécurité, modèle de menace, exploitation, feuille de route).
> 📦 **Installation en une commande** : `bash install.sh` (menu interactif).
> Version courante : **4.1.22**.

---

## Deux plateformes, un format

| Plateforme | Ce que c'est | Où ça tourne |
| --- | --- | --- |
| **Suite bureautique locale** | Documents, Tableur, Présentations, PDF, Drive local & Parapheur — 100 % hors-ligne, chiffrés/signés par document. | Le **PC** de l'utilisateur (MSI Windows ou navigateur). |
| **Drive d'entreprise** | Plateforme web multi-utilisateurs, zéro-connaissance : stockage, partage, co-édition temps réel, rôles & permissions. | Un **serveur que vous hébergez** (VPS Linux, ou PC via Docker). |

Les deux surfaces partagent le **format `.elium`**, les primitives de **cryptographie**, le moteur de **signatures** et les éditeurs (règle _dual-plateforme_ : une fonctionnalité livrée existe des **deux** côtés).

---

## 📊 État de l'ensemble des fonctions

> Établi à partir du code réel. **✅ Livré & testé** · **🟡 Présent, à améliorer** · **⬜ Prévu / non implémenté**.

### Suite locale — Documents (éditeur de texte riche)

| Fonction | État | Détail |
| --- | :---: | --- |
| Éditeur riche TipTap/ProseMirror | ✅ | Titres, gras/italique/souligné, couleurs, surlignage, polices & tailles, alignements, listes (puces/numéros/tâches), citations, liens |
| Tableaux, images, blocs de code colorisés | ✅ | `lowlight` pour la coloration syntaxique |
| Pagination écran réelle | ✅ | Feuilles A4/Letter empilées, sauts de page auto, n° de page en direct (`editor/Pagination.ts`, moteur pur `planPages`) |
| Suivi des modifications | ✅ | Insertions/suppressions attribuées ; **exporté en DOCX** (`<w:ins>`/`<w:del>`), round-trip testé |
| Import / export DOCX | ✅ | 🟡 l'import ne relit pas toujours couleur/police/taille |
| Sceau & signatures | ✅ | Voir _Elium Sign_ et _Sécurité_ |
| Journal de suivi entièrement câblé | ✅ | `created`/`opened`/`modified`/`export`/`protection.enabled`/`locked`/`signature.added`/`signature.validated` ; événements de consultation mis en file puis **versés & scellés au save** (ne casse jamais le sceau d'un document consulté) |
| Polices importées persistées dans le `.elium` | 🟡 | Non persistées pour l'instant |

### Suite locale — Tableur

| Fonction | État | Détail |
| --- | :---: | --- |
| Formules (~59) + références inter-feuilles | ✅ | Moteur pur `sheet/formula.ts` |
| Graphiques (barres/lignes/secteurs) | ✅ | |
| Mise en forme conditionnelle | ✅ | Seuils, plages, échelles de couleur |
| Tri, filtre (AutoFilter réel) | ✅ | Tri/copie/export CSV ne prennent que les lignes visibles |
| Import **et** export XLSX + CSV | ✅ | Export = paquet OPC valide (valeurs, chaînes, formules `<f>` `fullCalcOnLoad`, formats & styles), round-trip testé |
| Export XLSX en collaboratif (Drive) | ✅ | Parité dual-plateforme : pont pur CRDT→`Workbook`→`workbookToXlsx` |
| Fusion de cellules, validation de données, plages nommées, TCD | ⬜ | Non implémenté |

### Suite locale — Présentations

| Fonction | État | Détail |
| --- | :---: | --- |
| Canvas libre à objets | ✅ | Rotation, z-order, opacité, 8 poignées, guides magnétiques |
| Multi-sélection, groupes, copier/coller/dupliquer | ✅ | Maj-clic, marquee, Ctrl+G/C/V/D/A ; redimensionnement proportionnel (`slides/selection.ts`, logique pure testée) |
| Animations par élément + déclencheurs | ✅ | Au clic / avec / après la précédente (+délai), rejouées en public ET présentateur (`slides/playback.ts`) |
| Transitions dont **Morph** | ✅ | Interpolation réelle par élément (position/taille/rotation/opacité) |
| Vraie vue présentateur (2ᵉ écran) | ✅ | Popup synchronisée par `BroadcastChannel` : notes, minuteur, diapo suivante |
| Import / export PPTX | ✅ | Formes, texte, images, tableaux, groupes ; **graphiques natifs `<c:chart>`** éditables (import ET export) |
| Galerie de modèles | ✅ | 12 mises en page |
| Parité collaborative (Drive) | ✅ | Éditeur unifié `SlidesEditor` partagé local/collaboratif |

### Suite locale — PDF

| Fonction | État | Détail |
| --- | :---: | --- |
| Lecteur (pdf.js) + miniatures | ✅ | Rendu canvas, navigation, zoom, ajuster à la largeur |
| Couche texte sélectionnable + recherche Ctrl+F | ✅ | `TextLayer` pdf.js par-dessus le canvas, surlignage + navigation (matcher pur `pdf/search.ts`) |
| Annotation & édition | ✅ | Texte, surlignage, dessin libre, formes, image, effacer (blanc), édition du texte existant |
| Réorganisation des pages | ✅ | Réordonner, dupliquer, supprimer, insérer page blanche, rotation |
| **Formulaires AcroForm** | ✅ | Détection (`pdf/forms.ts`), remplissage (texte/cases/radios/listes), export via pdf-lib avec **aplatissement optionnel** ; round-trip réel pdf.js→`fillForm` testé |
| **Fusion / division** multi-fichiers | ✅ | « Fusionner » ajoute des PDF à la suite ; « Extraire » sort une plage (`parsePageRange`) — `pdf/merge-split.ts`, testé |
| Persistance & re-édition en `.elium` | ✅ | Ordre des pages + annotations + valeurs de formulaire scellés |

### Suite locale — Drive local & Parapheur

| Fonction | État | Détail |
| --- | :---: | --- |
| Bibliothèque locale de `.elium` | ✅ | Chiffrée au repos ; coffre local optionnel (mot de passe) |
| Parapheur (dossier de signature) | ✅ | File de documents à signer, index par `docId` |
| Brouillons chiffrés | ✅ | Récupération/reprise |
| Versions locales | ✅ | Historique chiffré indexé par `docId` |

### Elium Sign — signatures

| Fonction | État | Détail |
| --- | :---: | --- |
| Signatures visuelles | ✅ | Dessinée, tapée, image, tampon, initiales, **QR code**, placées & redimensionnées librement |
| Preuve cryptographique Ed25519 | ✅ | Signature du modèle + empreinte du document (niveau « avancé ») |
| Vérification & badges | ✅ | `Signature valide/invalide`, `Document modifié`, épinglage TOFU de la clé |
| Signature électronique **qualifiée** (eIDAS) | ⬜ | Hors périmètre (nécessite un prestataire qualifié) |

### Drive d'entreprise (serveur auto-hébergé)

| Fonction | État | Détail |
| --- | :---: | --- |
| Authentification zéro-connaissance, sans oracle | ✅ | Aucune fuite d'existence de compte / anti-lockout |
| RBAC granulaire | ✅ | Rôles & permissions par nœud |
| Partage profond (membre / équipe / lien) | ✅ | Liens publics chiffrés |
| Co-édition temps réel chiffrée (CRDT Yjs) | ✅ | Le relais ne voit que des mises à jour chiffrées ; Documents, Tableur, Présentations |
| Versions, corbeille, journal d'audit | ✅ | |
| Recouvrement d'organisation | ✅ | |
| Durcissement Phase 2 | ✅ | Rotation de clés, MFA (TOTP), quotas, rate-limiting, padding (Padmé) |
| SSO (OIDC) + SCIM | ✅ | Provisioning/déprovisioning en restant zéro-connaissance |
| Fusion texte caractère-par-caractère (collaboratif) | 🟡 | Actuellement LWW par champ |

### Format `.elium`, cœur & interopérabilité

| Fonction | État | Détail |
| --- | :---: | --- |
| Format documentaire v4 (OPC/ZIP) | ✅ | Manifeste, contenu, signatures, journal, ressources, RGPD |
| Profils de protection | ✅ | `standard`, `signed`, `protected`, `encrypted`, `locked`, `tracked`, `secure_max` |
| Sceau Ed25519 (anti-altération) | ✅ | Signe manifeste + hash(signatures) + hash(journal) ; épinglage TOFU |
| Journal chaîné par hash | ✅ | Toute altération d'un événement passé est détectée |
| Chiffrement optionnel des métadonnées | ✅ | Titre/signatures/journal dans l'enveloppe chiffrée |
| Multi-destinataires ECDH-ES | ✅ | `--recipient`/`--recipient-key`, interop paquet testée dans les deux sens |
| `docId` (UUID) identifiant stable | ✅ | Index versions/Parapheur/pinning, repli `createdAt` pour l'hérité |
| Parité **Python ↔ TypeScript** | ✅ | Format/sceau/signatures/chiffrement byte-for-byte, interop par fixtures croisées |

### Outillage, qualité & distribution

| Fonction | État | Détail |
| --- | :---: | --- |
| ESLint 9 (flat) + Prettier, gâtés en CI | ✅ | web-studio + server |
| **Code-splitting** des vues lourdes | ✅ | Bundle principal **1,28 Mo → 242 ko**, chunk PDF **1,47 Mo → 40 ko** ; vendors (pdf-lib/pdfjs/tiptap/yjs) en chunks à la demande ; lazy-load vérifié au navigateur |
| Publication auto signée (GitHub Releases) | ✅ | Bump `__version__` → release signée (exe/MSI + signature) |
| Add-in Office / Microsoft 365 | ⬜ | **Abandonné** (prototype supprimé du dépôt) |

---

## 🏗️ Architecture du dépôt

```
elium-main/
├── src/elium/            Cœur Python (core, crypto, format, cli)
│   ├── core/             Conteneur chiffré v3 (primitive de chiffrement héritée)
│   ├── crypto/           Argon2id · AES-256-GCM · ChaCha20-Poly1305 · Ed25519 · HMAC
│   ├── format/           Format documentaire v4 : package, manifeste, journal, profils, preuve
│   └── cli/              CLI (create/open hérités + doc-create/doc-open/doc-verify)
├── web-studio/           App web React/TypeScript — suite bureautique + client Drive
│   └── src/
│       ├── format/       Lecture/écriture .elium, JSON canonique, journal, profils
│       ├── crypto/       Moteur crypto (WebCrypto + @noble/*), coffre local
│       ├── sign/         Elium Sign : signatures visuelles, preuve & sceau Ed25519
│       ├── editor/       Éditeur riche TipTap (barre d'outils, pagination, suivi)
│       ├── sheet/        Tableur (formules, XLSX/CSV, mise en forme conditionnelle)
│       ├── slides/       Présentations (canvas, animations, PPTX, présentateur)
│       ├── pdf/          PDF (lecteur, annotation, formulaires AcroForm, fusion/division)
│       ├── drive-cloud/  Client Drive entreprise (SDK, provider CRDT chiffré, UI)
│       ├── panels/ views/ Inspecteur + écrans (Home, Studio, Sheet, Slides, PDF, Drive)
│       └── ui/           Design system
├── server/               Drive entreprise (Fastify + PostgreSQL)
│   └── src/              routes, rbac, db, collab (relais Yjs), storage, middleware
├── deploy/               Caddyfile + guide opérateur
├── docker-compose.yml    Pile Drive : db · api · minio · web · caddy
├── install.sh            Installateur/configurateur unique (suite & Drive)
└── tests/                Tests Python + interop
```

Détails du format et guide développeur : [DOCUMENTATION.md §5](DOCUMENTATION.md#5-le-format-elium) et [§13](DOCUMENTATION.md#13-guide-développeur).

---

## 🚀 Installation

### Suite bureautique (PC)

**Windows** — double-cliquez sur **`Elium.wizard.bat`** : il installe Node + Python au premier lancement et ouvre le Web Studio. La suite est aussi distribuée en **MSI** (voir GitHub Releases).

**Manuel / autres OS**

```bash
# 1. Cœur Python + CLI
python -m venv .venv
. .venv/bin/activate            # Windows : .venv\Scripts\activate
pip install -e .[dev]

# 2. Web Studio
cd web-studio
npm install
npm run dev                     # http://localhost:3000
```

### Drive d'entreprise (serveur)

Un seul script configure et déploie toute la pile Docker (Postgres + API + stockage + Caddy TLS) :

```bash
bash install.sh drive --domain drive.exemple.fr --email vous@exemple.fr   # VPS, HTTPS auto
bash install.sh drive --local                                             # local, sans TLS
bash install.sh                                                           # menu interactif
bash install.sh update | status | backup | restore <timestamp>
```

Guide VPS complet : [DOCUMENTATION.md §2](DOCUMENTATION.md#2-installation) · exploitation : [§10](DOCUMENTATION.md#10-exploitation-vps).

---

## 💻 CLI

```bash
# Créer un document .elium à partir d'un texte
elium doc-create --input notes.txt --output doc.elium --title "Notes" --profile signed

# Document chiffré (mot de passe demandé si non fourni)
elium doc-create --input notes.txt --output secret.elium --profile encrypted

# Document chiffré pour des destinataires (ECDH-ES)
elium doc-create --input notes.txt --output partage.elium --profile encrypted --recipient <clé_publique>

# Ouvrir / résumer
elium doc-open doc.elium --text

# Vérifier intégrité + journal + signatures (+ rapport de preuve)
elium doc-verify doc.elium --report preuve.json

# (Hérité) conteneur chiffré v3
elium create --input fichier.pdf --output fichier.elium
elium open fichier.elium --output ./extrait/ --recipient-key <clé_privée>
```

---

## 🧪 Tests & qualité

```bash
pytest tests/python -v                     # cœur Python + format + interop
cd web-studio && npm test                  # 41 suites vitest (format, crypto, sign, sheet, slides, pdf, journal, interop)
cd web-studio && npx tsc --noEmit          # typecheck
cd web-studio && npm run lint && npm run build
cd web-studio && npm run test:e2e          # E2E Drive multi-utilisateurs (87/87, vrai Postgres embarqué)
cd server && npm test && npm run typecheck # 93 tests unitaires serveur (auth, RBAC, TOTP, OIDC…)
```

**Barre qualité** : chaque changement passe tests verts + typecheck + lint avant commit ; CI gâte `server-checks`, `server-e2e` et le lint. Chaque bump de `__version__` publie une **release signée**.

---

## 🔐 Sécurité — à retenir

La sécurité **dépend des protections activées** : un `.elium` non chiffré **n'est pas confidentiel**. Une signature **visuelle** seule n'est **pas** une preuve cryptographique forte, et une preuve Elium n'est **pas** une signature électronique **qualifiée** (eIDAS). Le **sceau** garantit la détection d'altération, pas la confidentialité. Détails : [DOCUMENTATION.md §6](DOCUMENTATION.md#6-sécurité--cryptographie) à [§8](DOCUMENTATION.md#8-modèle-de-menace).

Principe cryptographique : **aucune primitive maison** — `cryptography`/`argon2-cffi` (Python) et `@noble/*`/`hash-wasm`/WebCrypto (Web). Signalement de vulnérabilité : [SECURITY.md](SECURITY.md).

---

## 📚 Documentation

| Fichier | Contenu |
| --- | --- |
| [DOCUMENTATION.md](DOCUMENTATION.md) | Référence unique : installation, suite, Drive, format, sécurité, menace, signatures, exploitation, **état & feuille de route** |
| [SECURITY.md](SECURITY.md) | Signalement de vulnérabilité, modèle de sécurité |
| [PRIVACY_RGPD.md](PRIVACY_RGPD.md) | Confidentialité & RGPD |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Contribution |
| [deploy/README.md](deploy/README.md) | Guide opérateur (Caddy, VPS) |

---

## 📄 Licence

MIT — voir [LICENSE](LICENSE).
