# Contribuer à Elium

Merci de votre intérêt pour Elium ! Ce guide vous aidera à contribuer efficacement.

## Prérequis

- **Python** ≥ 3.9
- **Node.js** ≥ 18
- **Git**

## Installation de l'environnement de développement

```bash
# Cloner le dépôt
git clone https://github.com/elium-project/elium.git
cd elium

# Python
python -m venv .venv
# Windows :
.venv\Scripts\activate
# Linux/macOS :
source .venv/bin/activate

pip install -e .[dev,desktop]

# Web Studio
cd web-studio
npm install
cd ..
```

Ou utilisez le script automatique : `Elium.wizard.bat` (Windows).

## Lancer les tests

```bash
# Python — tous les tests
pytest tests/python -v

# Python — avec couverture
pytest tests/python -v --cov=elium --cov-report=term-missing

# Python — linting
ruff check src/ tests/

# Web Studio — tests
cd web-studio && npm test

# Web Studio — build (vérification TypeScript)
cd web-studio && npm run build
```

## Structure du projet

```
src/elium/           # Cœur Python (format, crypto, CLI)
web-studio/src/      # Web Studio React/Vite (éditeur, signatures, export)
desktop/src/         # Application Desktop PySide6
tests/python/        # Tests Python (pytest)
web-studio/tests/    # Tests Web (vitest)
installer/           # Scripts de build de l'installeur
docs/                # Documentation
```

## Règles de contribution

### Code

- **Python** : suivre la configuration `ruff.toml` (PEP 8, ligne 120, `from __future__ import annotations`)
- **TypeScript** : `tsc` strict, pas de `any` sauf justifié
- **Messages utilisateur** : en français
- **Code et commentaires** : français ou anglais selon le contexte

### Commits

Utiliser les [Conventional Commits](https://www.conventionalcommits.org/) :

```
feat: ajouter le support des horodatages qualifiés
fix: corriger le déchiffrement cascade avec keyfile
chore: mettre à jour les dépendances npm
docs: documenter l'API de signature
test: ajouter des tests pour le journal de suivi
refactor: extraire la logique de preuve dans un module séparé
```

### Interopérabilité Python ↔ TypeScript

> ⚠️ **Règle critique** : toute modification du format (manifeste, journal, preuve, profils)
> doit être répliquée des **deux côtés** (Python et TypeScript) et accompagnée d'un test d'interop.

Fichiers miroirs :
- `src/elium/format/canonical.py` ↔ `web-studio/src/format/canonical.ts`
- `src/elium/format/journal.py` ↔ `web-studio/src/format/journal.ts`
- `src/elium/format/profiles.py` ↔ `web-studio/src/format/profiles.ts`
- `src/elium/format/package.py` ↔ `web-studio/src/format/elium-package.ts`
- `src/elium/format/proof.py` ↔ `web-studio/src/sign/proof.ts`

### Tests

- Tout nouveau code doit être couvert par des tests
- Les tests d'interopérabilité sont dans `web-studio/tests/interop*.test.ts` et `tests/python/interop_helper.py`
- Utiliser `pytest` pour Python et `vitest` pour TypeScript

## Processus de contribution

1. **Fork** le dépôt
2. **Créer une branche** : `git checkout -b feat/ma-fonctionnalite`
3. **Coder** en respectant les règles ci-dessus
4. **Tester** : tous les tests doivent passer
5. **Commiter** avec un message clair (Conventional Commits)
6. **Pousser** et ouvrir une **Pull Request**

## Signaler un bug

Ouvrez une issue avec :
- La version d'Elium
- Les étapes pour reproduire
- Le comportement attendu vs observé
- L'environnement (OS, Python, Node.js)

## Sécurité

Pour les vulnérabilités de sécurité, **ne pas ouvrir d'issue publique**.
Consultez [SECURITY.md](SECURITY.md) pour la procédure de signalement responsable.
