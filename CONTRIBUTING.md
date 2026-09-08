# Contribuer à Elium

## Proposer une contribution

1. Fork du dépôt, puis clone de ton fork.
2. Crée une branche depuis `master` (c'est la branche principale du dépôt, pas `main`).
3. Fais tes changements, avec des commits atomiques (voir convention ci-dessous).
4. Vérifie que les tests et le lint du/des sous-projet(s) concernés passent (voir
   « Tests avant une PR »).
5. Ouvre une pull request vers `master`. Décris le changement et son motif ;
   lie l'issue concernée si applicable.

## Convention de commit

Format observé dans l'historique : `<type>(<scope>): <description>`, description
courte à l'impératif, en français. Le `<scope>` est en général le nom du
sous-système touché (`sheet`, `pdf`, `drive`, `editor`, `installer`, `server`,
`ci`, …).

Types utilisés dans ce dépôt : `fix`, `feat`, `refactor`, `chore`, `test`,
`style`, ainsi que `merge:` pour les commits de fusion (sans scope).

Exemples réels tirés du log :

```
fix(parapheur): fiabilise le pont circuit local <-> demande de signature cloud
feat(installer): port du serveur local visible et selectionnable + rate-limit
refactor(drive): migre RolesPanel/GroupsPanel vers le vocabulaire dcx-/elx-
chore(release): bump version to 4.5.9
```

Le préfixe `chore(release): bump version to X.Y.Z` est réservé à la publication
(bump de version) — ne pas l'utiliser pour autre chose.

## Tests avant une PR

Le dépôt a trois sous-projets, chacun avec sa propre suite de tests :

- Cœur Python (`src/`, `tests/python`) : tests via pytest.
- `web-studio/` : tests via vitest, plus des tests navigateur/E2E via
  Playwright.
- `server/` : tests via vitest.

Les commandes exactes (installation, lancement des tests, lint, typecheck)
sont documentées dans la section « Tests et lint » du [README](README.md) à la
racine, et dans [installer/README.md](installer/README.md) pour ce qui touche
à l'installeur. Tout doit passer localement avant d'ouvrir une PR.

## CI

Deux workflows GitHub Actions :

- **`ci.yml`** (« Elium CI ») tourne sur chaque push et chaque PR vers
  `master`. Il doit être vert (pytest + ruff, build/lint/tests web-studio,
  lint/typecheck/tests server, E2E serveur).
- **`release.yml`** se déclenche automatiquement après un `ci.yml` vert sur
  `master` (pas manuellement, sauf cas d'urgence) : il construit et publie une
  nouvelle release si la version dans `src/elium/__init__.py` a été
  incrémentée.

Une PR qui casse `ci.yml` ne sera pas mergée.

## Style de code

- Pas de commentaires superflus : un commentaire doit expliquer un *pourquoi*
  non évident, pas reformuler le code.
- Reste cohérent avec les conventions déjà en place dans le fichier/module que
  tu modifies (nommage, structure, style CSS/TS existant) plutôt que d'en
  introduire de nouvelles.
- Le lint et le format check (ESLint/Prettier côté web-studio et server, ruff
  côté Python) font partie de la CI — vérifie-les avant de pousser.
