## Contribution et développement

Ce chapitre s'adresse à qui modifie Elium. La branche principale est `master`. La publication se déclenche à chaque poussée dont la CI est verte : voir la section sur la chaîne de build.

### Structure du dépôt

| Dossier | Contenu |
|---|---|
| `src/elium/` | Cœur Python : CLI, format `.elium`, primitives cryptographiques. **Référence** du format |
| `web-studio/` | Application React, Vite et TypeScript : éditeurs, Drive côté navigateur, format `.elium` en TypeScript |
| `server/` | API du Drive (Fastify, TypeScript) |
| `installer/` | Lanceur, exécutable PyInstaller, MSI (WiX), mise à jour signée |
| `scripts/` | Génération de clés de mise à jour, prochaine version, audit Python |
| `requirements/` | Verrous Python à empreintes |
| `tests/python/` | Tests pytest du cœur, du lanceur et des scripts de publication |
| `security/` | Preuves d'attaque (PoC) du format, rejouées en CI |
| `deploy/`, `docker-compose.yml`, `install.sh` | Déploiement du Drive |
| `docs/architecture.md` | Architecture destinée aux contributeurs |

Dans `web-studio/src/` : `editor` (Documents), `sheet`, `slides`, `pdf`, `detector`, `drive-cloud`, `format`, `crypto`, `workspace` (espace de travail local), `settings`, `i18n`, `docs` (cette documentation), `ui` (composants partagés).

L'ancienne application de bureau PySide6 a été supprimée : l'application livrée est le lanceur (`installer/elium_launcher.py`) qui sert l'interface web dans une fenêtre dédiée.

### Prérequis et installation

- Python 3.9 ou plus, Node.js (la version exacte est dans `.node-version`), Git.
- Docker n'est utile que pour essayer la pile Drive complète.

Une commande par bloc :

```bash
python -m venv .venv
```

```bash
pip install -r requirements/dev.txt
```

```bash
pip install -e .
```

```bash
cd web-studio && npm ci
```

```bash
cd server && npm ci
```

Sous PowerShell, activez l'environnement avec `.venv\Scripts\Activate.ps1`. Le fichier `dev.bat` et l'assistant `Elium.wizard.bat` automatisent ces étapes sous Windows.

### Commandes de développement, de test et de qualité

| Action | Commande |
|---|---|
| Suite web (serveur de développement) | `cd web-studio && npm run dev` |
| Tests unitaires web | `cd web-studio && npx vitest run` |
| Un seul fichier de test | `cd web-studio && npx vitest run tests/<nom>.test.ts` |
| Types web | `cd web-studio && npx tsc --noEmit` |
| ESLint web | `cd web-studio && npm run lint` |
| Prettier web (vérifier) | `cd web-studio && npm run format:check` |
| Prettier web (corriger) | `cd web-studio && npm run format` |
| Build web | `cd web-studio && npm run build` |
| Budget de taille | `cd web-studio && npm run check:bundle-budget` |
| Tests navigateur (axe-core, parcours) | `cd web-studio && npm run test:browser` |
| Tests navigateur PDF | `cd web-studio && npx playwright test -c playwright.pdf.config.ts` |
| E2E Drive multi-utilisateurs | `cd web-studio && npm run test:e2e` |
| E2E Tableur collaboratif | `cd web-studio && npm run test:e2e:sheet` |
| Serveur : tests, types, lint | `cd server && npm test`, `npm run typecheck`, `npm run lint` |
| API en développement | `cd server && npm run dev` |
| Python : tests | `pytest tests/python` |
| Python : lint | `ruff check src/ tests/ installer/ security/ scripts/` |
| Pile Drive locale | `bash install.sh drive --local` |

Les tests unitaires web dépassent **2 800** (octobre 2026). Les tests navigateur de la CI sont `a11y.spec.ts` et `journeys.spec.ts`. Les scénarios `pdf-*.spec.ts` ont leur propre configuration (deux projets : Drive sans CSP, et bureau avec la CSP du lanceur) et **ne sont pas** lancés par la CI : exécutez-les avant de toucher au PDF, après `npx vite build`.

> Les E2E du serveur utilisent un vrai PostgreSQL embarqué, sans Docker.

**Avant chaque commit** : types, ESLint, Prettier et tests concernés doivent passer. Pour la documentation :

```bash
cd web-studio && npx tsc --noEmit && npm run lint && npx vitest run tests/documentation-structure.test.ts
```

### Conventions

- **Pas d'erreur avalée.** Un `catch` vide est interdit. Soit on journalise avec `reportError("source", erreur)` (journal d'incidents local), soit on affiche un message visible. Les fenêtres de saisie ou de confirmation passent par `useDialogs()` (`prompt`, `confirm`, `alert`), jamais par `window.prompt`.
- **Textes de l'interface en français**, via le cadre `i18n` (français et anglais).
- **Aucune cryptographie maison.** Réutiliser `cryptography` et `argon2-cffi` (Python), `@noble/*`, `hash-wasm` et WebCrypto (web).
- **Miroir Python et TypeScript.** Le format `.elium` existe des deux côtés (`canonical`, `journal`, `profiles`, `package`, `proof`, `seal`). Toute modification du format se fait des **deux** côtés, avec un test d'interopérabilité. Le JSON canonique garantit des empreintes identiques.
- **Parité local et Drive.** Une fonction de la suite locale doit aussi marcher dans la version collaborative du Drive, via des magasins interchangeables.
- **Python** : `ruff.toml` (ligne de 120, cible Python 3.9). **TypeScript** : `tsc` strict, Prettier (ligne de 120, guillemets doubles).
- **Commits** conventionnels : `feat`, `fix`, `refactor`, `perf`, `chore`, `docs`, `test`, `style`. Le message `chore(release): bump version to X.Y.Z` est réservé à la publication.
- **CSS** : réutiliser le vocabulaire commun `.elx-*` et `.dcx-*` plutôt que créer des styles isolés.

### Budgets de taille du bundle

`npm run check:bundle-budget` échoue si le bundle grossit sans raison. Il fixe un plafond par gros morceau (pdf-lib, pdf.js en deux variantes, Tiptap) et un **plafond total du JavaScript** (6,8 Mo à ce jour), mesuré sur `dist/assets`. Les budgets valent la taille mesurée plus une marge d'environ 20 %. Quand un ajout légitime les dépasse, on relève le plafond dans le script **avec un commentaire qui justifie** la hausse. Charger à la demande (`import()`) est préférable à relever.

### Générer les polices

Les polices sont embarquées pour que l'application reste hors ligne. Le catalogue est `web-studio/src/ui/font-catalog.json`. La commande suivante copie les fichiers des paquets `@fontsource` dans `public/fonts/` et produit `fonts.css` :

```bash
cd web-studio && npm run gen:assets
```

Elle est lancée automatiquement par `npm run dev` et `npm run build`. Les fichiers générés ne sont pas à modifier à la main.

### Ajouter une section de documentation

1. Créer `web-studio/src/docs/sections/NN-nom.md`. L'ordre d'affichage est l'**ordre alphabétique** des noms de fichiers : `NN-MM-nom.md` s'intercale entre deux chapitres.
2. Commencer par un titre `##` (le titre `#` unique est dans la première section) ; utiliser `###` pour les sous-sections. Pas de numéros dans les titres.
3. Le sommaire est généré à partir des titres `##` et `###`. Syntaxe permise : titres, listes, tableaux, blocs de code, gras, italique, `code`, liens, citations.
4. Les titres `##` et `###` doivent être **uniques dans tout le document** et tout lien interne (un lien dont la cible commence par `#`) doit viser un titre existant : le test `documentation-structure.test.ts` le vérifie.
5. Un seul fichier par chapitre ; ne pas recréer de fichiers de documentation séparés.

### Pièges connus

- **Fins de ligne sous Windows.** Avec `core.autocrlf=true`, Git convertit les fichiers en CRLF et Prettier échoue en CI (qui est en LF). Pour tester Prettier fidèlement, travaillez depuis un **clone fait avec `core.autocrlf=false`**. Les scripts `.sh` sont forcés en LF par `.gitattributes`.
- **YAML des workflows.** Un workflow cassé ne se voit qu'une fois poussé. Validez le fichier (par exemple avec un analyseur YAML) avant de pousser, surtout après un `sed` ou un collage de fragment.
- **Chemins Windows et bash.** `$PWD` sous bash est un chemin POSIX, que Python sous Windows ne comprend pas : utiliser `$GITHUB_WORKSPACE` en CI. `bash -n install.sh` passe par WSL, qui ne lit pas les chemins Windows : ce test est ignoré sous Windows.
- **Python 3.9.** La syntaxe `X | Y` hors annotation et d'autres nouveautés de Python récent échouent sur 3.9 (la CI le teste).
- **Verrous Python.** Un paquet ajouté à un `.in` doit être recompilé dans le `.txt` (sinon l'installation à empreintes échoue).

### Ligne de commande

Le programme `elium` sert à créer, inspecter et vérifier des fichiers sans interface. Il utilise le même cœur que la référence du format.

| Commande | Usage |
|---|---|
| `elium doc-create` | Crée un `.elium` à partir d'un texte (`--profile`, `--password`, `--recipient`, `--seal-key`) |
| `elium doc-open` | Ouvre et résume (`--text`, `--password`, `--recipient-kid`) |
| `elium doc-sign` | Ajoute une signature Ed25519 (`--key` est un **fichier** contenant la clé hex, `--name` est obligatoire) |
| `elium doc-verify` | Vérifie intégrité, journal et signatures (`--report` écrit un rapport JSON) |
| `elium keys …` | Trousseau : `list`, `generate`, `public`, `export`, `import`, `rotate` |
| `elium create`, `elium open` | Ancien conteneur v3 |

Les profils valides pour `--profile` sont `standard`, `signed`, `protected`, `encrypted`, `locked`, `tracked` et `secure_max`.

```bash
elium doc-create --input notes.txt --output doc.elium --title "Notes" --profile signed
```

```bash
elium doc-sign doc.elium --key cle-privee.hex --name "Alice Martin"
```

```bash
elium doc-verify doc.elium --report preuve.json
```

Passer une clé privée en argument (`--recipient-key`) est **déprécié** : elle reste dans l'historique du shell. Préférez le trousseau (`elium keys generate`, puis `--recipient-kid`). Le dossier du trousseau est `~/.elium/keys`, ou celui de la variable `ELIUM_KEYS_DIR`.
