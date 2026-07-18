# Elium — format `.elium`, éditeur local & signature électronique

> **📖 Toute la documentation est dans un seul fichier :
> [DOCUMENTATION.md](DOCUMENTATION.md).**
> **📦 Installation** — un seul fichier configure et installe tout :
> `bash install.sh` (menu) · `bash install.sh drive --domain drive.exemple.fr`
> (Drive entreprise) · `bash install.sh suite` (suite bureautique).
> Guide complet VPS + PC local : [DOCUMENTATION.md §2](DOCUMENTATION.md#2-installation).

Elium est un **écosystème documentaire local-first** en trois modules complémentaires :

| Module | Rôle |
| --- | --- |
| **Format `.elium`** | Format de fichier portable qui stocke contenu, styles, ressources, signatures, suivi et protections **optionnelles**. |
| **Éditeur Elium** | Éditeur de texte riche (style traitement de texte) qui fonctionne **localement** dans le navigateur. |
| **Elium Sign** | Signatures **visuelles** personnalisables placées librement, avec **preuve cryptographique** optionnelle. |

> L'objectif n'est pas un simple conteneur chiffré : c'est un outil documentaire complet permettant de rédiger, mettre en forme, signer, protéger et vérifier un document, puis de l'enregistrer dans un fichier `.elium` portable et vérifiable. **Par défaut, aucun document n'est envoyé à un serveur.**

## ✨ Fonctionnalités

- **Éditeur riche** (TipTap/ProseMirror) : titres, gras/italique/souligné, couleurs, surlignage, polices/tailles, alignements, listes (puces, numéros, tâches), citations, **tableaux**, **images**, **blocs de code** colorisés, liens, mise en page A4/Letter.
- **Elium Sign** : signatures **dessinées, tapées, image, tampon, initiales, QR code**, placées et redimensionnées librement, avec **preuve Ed25519** optionnelle + empreinte du document.
- **Profils de protection optionnels** : `standard`, `signed`, `protected`, `encrypted`, `locked`, `tracked`, `secure_max`.
- **Journal de suivi chaîné par hash** : toute altération du journal est détectée.
- **Visualiseur** avec badges : `Non protégé`, `Chiffré`, `Signé`, `Signature valide`, `Document modifié`, `Verrouillé`, `Suivi valide`, etc.
- **Export** PDF (impression), HTML, Markdown, **rapport de preuve** JSON.
- **Crypto éprouvée** réutilisée pour le chiffrement : Argon2id + AES-256-GCM (± ChaCha20-Poly1305) + HMAC, interopérable Python ↔ Web.
- **RGPD par conception** : traitement local, minimisation des données, transparence.

## 🏗️ Architecture

```
elium-main/
├── src/elium/              # Cœur Python
│   ├── core/               # Conteneur chiffré v3 (réutilisé pour le chiffrement)
│   ├── crypto/             # Primitives (Argon2id, AES-GCM, ChaCha20, Ed25519, HMAC)
│   ├── format/             # Format documentaire v4 : package, manifest, journal, profils, preuve
│   └── cli/                # CLI (create/open legacy + doc-create/doc-open/doc-verify)
├── web-studio/             # Application web React/TypeScript (éditeur + Sign + visualiseur)
│   └── src/
│       ├── format/         # Lecture/écriture .elium, hachage canonique, journal, profils
│       ├── sign/           # Elium Sign : signatures visuelles + preuve Ed25519
│       ├── editor/         # Éditeur TipTap, barre d'outils, modèles
│       ├── export/         # Export HTML / Markdown / PDF / rapport de preuve
│       ├── panels/ views/  # Inspecteur (Signatures, Sécurité, Suivi, Export, Infos) + écrans
│       └── ui/             # Design system
├── desktop/                # Lanceur/tableau de bord PySide6 (hérité)
└── tests/                  # Tests Python + interop
```

Détails du format et guide développeur : voir [DOCUMENTATION.md](DOCUMENTATION.md) (§5 et §13).

## 🚀 Démarrage rapide (Windows)

Double-cliquez sur **`Elium.bat`** : il installe les dépendances (Node + Python) au premier lancement et ouvre le Web Studio dans le navigateur.

### Installation manuelle

```bash
# 1. Cœur Python + CLI
python -m venv .venv
.venv\Scripts\activate
pip install -e .[dev,desktop]

# 2. Web Studio
cd web-studio
npm install
npm run dev          # http://localhost:3000
```

## 💻 CLI

```bash
# Créer un document .elium à partir d'un texte
elium doc-create --input notes.txt --output doc.elium --title "Notes" --profile signed

# Créer un document chiffré (mot de passe demandé si non fourni)
elium doc-create --input notes.txt --output secret.elium --profile encrypted

# Ouvrir / résumer un document
elium doc-open doc.elium --text

# Vérifier intégrité, journal et signatures (+ rapport de preuve)
elium doc-verify doc.elium --report preuve.json

# (Hérité) conteneur chiffré v3
elium create --input fichier.pdf --output fichier.elium
elium open fichier.elium --output ./extrait/
```

## 🧪 Tests

```bash
pytest tests/python -v          # cœur Python + format + interop
cd web-studio && npm test       # format, signatures, interop Python↔Web
cd web-studio && npm run build  # build de production
```

## 📚 Documentation

**Toute la documentation est consolidée dans un seul fichier :
[DOCUMENTATION.md](DOCUMENTATION.md)** — installation (VPS + PC local),
fonctionnalités des deux plateformes, format `.elium`, sécurité & cryptographie,
modèle de menace, signatures, exploitation, état d'avancement et feuille de route.

Fichiers conservés à part (conventions) : [SECURITY.md](SECURITY.md) (signalement
de vulnérabilité) · [PRIVACY_RGPD.md](PRIVACY_RGPD.md) (RGPD) ·
[CONTRIBUTING.md](CONTRIBUTING.md) · [deploy/README.md](deploy/README.md).

## ⚠️ À retenir

La sécurité **dépend des protections activées**. Un `.elium` non chiffré **n'est pas confidentiel**. Une signature visuelle seule **n'est pas** une preuve cryptographique forte, et une preuve cryptographique Elium **n'est pas** une signature électronique *qualifiée* (qui nécessite un prestataire qualifié). Voir [DOCUMENTATION.md §7](DOCUMENTATION.md#7-signatures--elium-sign).

## 📄 Licence

MIT — voir [LICENSE](LICENSE).
