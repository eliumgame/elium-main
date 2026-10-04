## Publication et chaîne de build

Ce que fait le dépôt entre un `git push` et une version installable. Les mises à jour côté utilisateur sont décrites dans le chapitre sur les mises à jour automatiques.

### Intégration continue (ci.yml)

Le workflow **Elium CI** tourne à chaque poussée et à chaque demande de fusion vers `master`. Il n'a que des droits de lecture. Il compte six jobs.

| Job | Contenu |
|---|---|
| `web-studio-build` | Verrou npm (`npm ci`), ESLint, Prettier (vérification), build, budget de taille du bundle, tests Vitest, tests navigateur Playwright (axe-core et parcours réels), audit des dépendances de production |
| `server-checks` | ESLint, Prettier, vérification de types, tests Vitest du serveur, `npm audit` (niveau élevé) |
| `server-e2e` | Test multi-utilisateurs avec un vrai PostgreSQL embarqué et la vraie API, puis test du Tableur collaboratif à deux clients |
| `python-tests` | Python 3.9, 3.11, 3.12 et 3.13 : ruff, pytest avec couverture, audit des dépendances livrées |
| `shellcheck` | `bash -n` et `shellcheck` sur `install.sh` |
| `compose-config` | `docker compose config` doit **échouer** sans secrets et **réussir** avec |

Le job web-studio installe aussi Python 3.12 et le paquet `elium` : les tests d'interopérabilité Python et TypeScript en ont besoin.

### Publication (release.yml)

Le workflow **Elium — Publication** démarre après une CI verte sur `master`. Quatre jobs, aux privilèges séparés.

| Job | Rôle |
|---|---|
| `gate` | Vérifie que la CI est verte sur **ce** commit, lit la version, constate si elle existe déjà |
| `build` | Construit sous Windows, **sans aucun secret** |
| `images` | Construit les images Docker, les pousse sur GHCR et les signe (cosign) |
| `publish` | **Seul** job qui voit la clé de signature : signe, publie, atteste, vérifie |

Le job `build` enchaîne :

1. installation des dépendances Python depuis le **verrou à empreintes** (`requirements/build.txt`) ;
2. marquage de la version et de l'empreinte du code (`installer/stamp_version.py`) ;
3. tests Python, puis build de l'interface (`npm ci`, `npm run build`) ;
4. **SBOM** CycloneDX pour npm et pour Python ;
5. découpage de l'interface : `web-core.zip` (léger), `assets-<empreinte>.zip` (polices, pdf.js, OCR, qui changent rarement) et `web.zip` (archive complète, pour les anciens clients) ;
6. exécutable `Elium.exe` (PyInstaller) ;
7. signature **Authenticode** facultative : étape présente, **inactive** tant que les secrets `SIGN_CERT` et `SIGN_CERT_PASSWORD` n'existent pas (aucun certificat à ce jour) ;
8. **test de fumée** de l'exécutable gelé (version, CSP stricte, aucune URL externe, contrôle d'hôte) ;
9. WiX 3.14 (archive officielle, empreinte vérifiée) : **deux MSI**, pour tous les utilisateurs et sans droits administrateur. Les deux sont bloquants.

Le job `publish` :

1. refuse de publier si le secret `UPDATE_SIGNING_KEY` est absent (run vert, avertissement) ;
2. construit l'historique des nouveautés avec `installer/changelog.py` ;
3. génère et **signe** `latest.json` (Ed25519, avec un `keyId` pour permettre la rotation de clé) ;
4. crée le paquet hors ligne `.eliumupdate` ;
5. publie la GitHub Release avec ses fichiers : exécutable, trois archives, deux MSI, deux SBOM, manifeste et signature, paquet hors ligne ;
6. ajoute une **attestation de provenance** ;
7. relance `installer/verify_release.py`, qui retélécharge le manifeste et chaque fichier pour revérifier signature et empreintes.

Un échec de cette dernière vérification ouvre une issue de suivi mais ne retire rien : pas de retour arrière automatique. La signature et les empreintes rendent une release cassée inoffensive, simplement non installable.

> Les images GHCR portent leur **empreinte** dans le manifeste signé. Le serveur VPS tire exactement ces octets.

### Versionnement

- La version vit dans `src/elium/__init__.py`. Pour la changer, lancer `python installer/stamp_version.py X.Y.Z` : il met aussi à jour `web-studio/package.json`, `installer/elium.wxs`, `installer/version_info.txt` et l'empreinte de code de `installer/updater.py`.
- **Ne publiez pas de balise à la main.** La publication se déclenche à la poussée. Si la version existe déjà, la publication ne fait **rien** et le signale par un avertissement.
- `scripts/next_version.py` déduit la prochaine version des messages de commit conventionnels : `feat` donne un mineur, `fix` et autres un correctif, `!` ou `BREAKING CHANGE` un majeur. Seulement du bruit (`chore`, `docs`, `ci`, `test`…) : code de sortie 3, rien à publier.
- Lancement manuel (Actions, « Release ») : `bump` = `none` (version du code), `auto`, `patch`, `minor` ou `major` ; `prerelease` = `rc` ou `beta` produit `X.Y.Z-rc1`, publiée comme **préversion**. Un bump automatique crée un commit `chore(release)`.
- Canaux : les installations suivent `stable` (défaut) ou `beta` (préversions comprises). Les préversions ne sont visibles que dans le canal bêta.
- Le numéro de version du **format** `.elium` est indépendant et n'est jamais touché.

### Verrous de dépendances Python

Les listes `requirements/runtime.txt`, `dev.txt` et `build.txt` fixent versions **et empreintes**. Elles sont compilées à partir des fichiers `.in` correspondants, pour toutes les plateformes et en visant Python 3.9. Une commande par fichier :

```bash
uv pip compile requirements/dev.in --universal --python-version 3.9 --generate-hashes -o requirements/dev.txt
```

La CI les installe avec `pip install --require-hashes`.

### Audits de dépendances

- **Python** : `scripts/pip_audit_gate.py`. Les dépendances **livrées** (`runtime.txt`) **bloquent** à la moindre faille connue, sauf exception datée. Les outils de développement (`dev.txt`) sont audités à titre **informatif** (le job continue).
- **npm (interface)** : `web-studio/scripts/audit-gate.mjs` bloque sur toute faille élevée ou critique des dépendances de production, sauf les exceptions **datées et justifiées** de la liste. Aujourd'hui une seule : `node-forge` (aucun correctif publié ; la fonction touchée n'est jamais appelée), à réexaminer avant le 31 décembre 2026. Passé le délai, l'exception échoue d'elle-même.
- **npm (serveur)** : `npm audit --omit=dev --audit-level=high`, sans exception.

**Dependabot** propose chaque semaine des mises à jour pour npm (interface et serveur), pip, les actions GitHub et les images Docker. Les montées de version **majeures** sont ignorées (elles cassent le build, on les fait à la main), avec trois demandes ouvertes au plus par dossier. Les demandes sont relues, jamais fusionnées seules.

### Retour d'expérience de la première publication de la 4.10.0

La première chaîne complète n'a pas réussi du premier coup. Les causes, toutes corrigées :

| Problème | Cause | Correctif |
|---|---|---|
| Échec de l'étape des tests Python | `PYTHONPATH` écrit par bash avec un chemin POSIX (`$PWD`), invalide pour Python sous Windows | Utiliser `$GITHUB_WORKSPACE` |
| Message d'erreur illisible | Les journaux ne sont lisibles qu'une fois connecté | Republier les échecs pytest en **annotation** publique |
| SBOM Python en échec | Le module `cyclonedx-bom` n'était pas dans le verrou de build | L'ajouter à `build.in` et recompiler |
| Workflow invalide | Un fragment YAML cassé par un `sed` mal échappé | Corriger le YAML |
| Test local en échec sous Windows | `bash -n install.sh` passe par WSL, qui ne lit pas les chemins Windows | Test ignoré sous Windows (le job `shellcheck` Linux le couvre) |
| Étape MSI fragile | La régénération des visuels du MSI en CI exige Pillow | Visuels versionnés, plus de régénération en CI |

> **À retenir** : valider les fichiers YAML de workflow avant de pousser, et garder en tête qu'une étape peut réussir sur Linux et échouer sous Windows.

### Limites connues de la chaîne

- Pas de signature de code Windows : SmartScreen peut avertir à la première exécution.
- Le retour arrière d'une release publiée est manuel.
- `pyproject.toml` garde une version figée (`4.0.0`), sans effet : la version réelle est celle de `src/elium/__init__.py`.
- La chaîne serveur (images signées jusqu'au VPS) n'a pas été exercée sur un vrai serveur, voir le chapitre sur l'exploitation.
