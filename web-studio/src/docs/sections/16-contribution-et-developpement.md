## Contribution et développement

### Prérequis

- **Python** ≥ 3.9, **Node.js** ≥ 18, **Git**.

```bash
git clone https://github.com/elium-project/elium.git && cd elium
python -m venv .venv
.venv\Scripts\activate           # Windows  (Linux/macOS : source .venv/bin/activate)
pip install -e .[dev,desktop]
cd web-studio && npm install && cd ..
```

> Le groupe optionnel `desktop` (PySide6) sert uniquement à une **ancienne
> application de bureau Python, non maintenue** (`desktop/src/app.py`) —
> distincte de l'application réellement distribuée aux utilisateurs (MSI/exe,
> §2.1), qui n'en dépend pas. Omettez-le (`pip install -e .[dev]`) sauf travail
> spécifique sur ce code legacy.

Ou l'assistant Windows : `Elium.wizard.bat`.

### Tests et qualité

| Action | Commande |
|---|---|
| Suite web (dev) | `cd web-studio && npm run dev` (port 3100) |
| Tests web (vitest) | `cd web-studio && npx vitest run` (format, crypto, sign, sheet, slides, pdf, journal, interop) |
| Typecheck web | `cd web-studio && npx tsc --noEmit` |
| Lint + build web | `cd web-studio && npm run lint && npm run build` |
| E2E Drive multi-utilisateurs | `cd web-studio && npm run test:e2e` (vrai Postgres embarqué, sans Docker) |
| Tests + typecheck serveur (vitest) | `cd server && npm test && npm run typecheck` (auth, RBAC, TOTP, OIDC…) |
| Tests Python (pytest) | `pytest tests/python -v` (cœur + format + interop) |
| Couverture Python | `pytest tests/python -v --cov=elium --cov-report=term-missing` |
| Lint Python (ruff) | `ruff check src/ tests/` |
| API Drive (dev) | `cd server && npm run dev` |
| Pile Drive complète | `bash install.sh drive --local` |
| Build MSI | `installer/build.bat` puis `installer/build_msi.bat /nopause` |

**Barre qualité** : chaque changement passe tests verts + typecheck + lint avant
commit. La CI gâte `server-checks`, `server-e2e` et le lint (ESLint 9 flat +
Prettier sur web-studio et server ; ruff côté Python). Chaque push sur `master`
publie une **release signée**.

### Conventions

- **JSON canonique** partout où une empreinte doit être reproductible Python↔TS.
  Les miroirs Python/TS doivent rester **byte-for-byte** (sceau, recipients,
  format) — tout changement se valide par les fixtures d'interop.
- **Cryptographie : aucune primitive maison** — réutiliser `cryptography` /
  `argon2-cffi` (Python) et `@noble/*` / `hash-wasm` / WebCrypto (Web).
- **Python** : `ruff.toml` (PEP 8, ligne 120, `from __future__ import annotations`).
  **TypeScript** : `tsc` strict, pas de `any` sauf justifié. Messages utilisateur
  en français.
- **Commits** : Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`, `test:`,
  `refactor:`).
- **Règle critique d'interop** : toute modification du format (manifeste, journal,
  preuve, profils) doit être répliquée des **deux côtés** et accompagnée d'un test
  d'interop. Fichiers miroirs : `canonical`, `journal`, `profiles`, `package`
  (`elium-package`), `proof`.

### CLI

```bash
# Créer un document .elium à partir d'un texte
elium doc-create --input notes.txt --output doc.elium --title "Notes" --profile signed

# Document chiffré (mot de passe demandé si non fourni)
elium doc-create --input notes.txt --output secret.elium --profile encrypted

# Document chiffré pour des destinataires (ECDH-ES P-256)
elium doc-create --input notes.txt --output partage.elium --profile encrypted --recipient <clé_publique>

# Ajouter une preuve Ed25519 à un .elium (journalise signature.added, préserve docId,
# re-scelle en option, préserve le chiffrement des métadonnées / le keyfile)
elium doc-sign doc.elium --key <clé_privée>

# Ouvrir / résumer
elium doc-open doc.elium --text

# Vérifier intégrité + journal + signatures (+ rapport de preuve)
elium doc-verify doc.elium --report preuve.json

# (Hérité) conteneur chiffré v3
elium create --input fichier.pdf --output fichier.elium
elium open fichier.elium --output ./extrait/ --recipient-key <clé_privée>
```

Le multi-destinataires ECDH-ES est câblé au niveau paquet des deux côtés
(`write_elium(recipients=…)` / `read_elium(recipient_private_hex=…)`), interop
testée dans les deux sens.

---
