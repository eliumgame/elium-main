# `installer/` — Packaging Windows d'Elium

Ce dossier contient toute la chaîne qui transforme le code source en distribuables
Windows : l'exécutable autonome `Elium.exe` (PyInstaller), l'installeur `.msi`
(WiX Toolset) et le manifeste de mise à jour signé consommé par l'auto-update.
13 fichiers Python / `.bat` / WiX s'y enchaînent avec des dépendances implicites
(ordre d'exécution, fichiers générés attendus par l'étape suivante) — ce README
sert de carte pour ne pas s'y perdre.

## Vue d'ensemble : le pipeline réel

Il y a deux exécutions possibles de ce pipeline : **en local** (scripts `.bat`,
pour tester une build sur son poste) et **en CI** (`.github/workflows/release.yml`,
qui reproduit les mêmes étapes — pas forcément en appelant les `.bat`
directement — à chaque push réussi sur `master`). Dans les deux cas, l'ordre est
le même :

```
1. stamp_version.py     → bump la version dans TOUS les fichiers concernés
                           (src/elium/__init__.py, package.json/lock,
                           elium.wxs, version_info.txt)
                           + recalcule BUILD_CODE_HASH dans updater.py

2. build.bat             → build web-studio (npm run build)
                           puis PyInstaller (elium.spec + elium_launcher.py)
                           => installer/staging/Elium.exe

3. build_msi.bat          → WiX candle.exe + light.exe sur elium.wxs
                           (+ make_msi_assets.py pour les visuels WixUI,
                           print_version.py pour nommer le fichier)
                           => installer/output/Elium-X.Y.Z-Setup.msi

4. gen_manifest.py        → sha256 de chaque artefact (exe / web.zip / msi)
                           + signature Ed25519
                           => dist/latest.json + latest.json.sig

5. verify_release.py      → APRÈS publication (gh release create) : retélécharge
                           le manifeste et les artefacts publiés, revérifie
                           signature + sha256 + disponibilité
```

Notes importantes sur cet enchaînement :

- **`build_msi.bat` n'est pas appelé par la CI.** `.github/workflows/release.yml`
  reproduit les mêmes commandes WiX (`candle` puis `light`) directement dans le
  workflow plutôt que d'invoquer le script `.bat`. Les deux chemins produisent le
  même résultat à partir du même `elium.wxs` ; `build_msi.bat` est la version à
  utiliser en local.
- En CI, l'étape MSI est **best-effort** (`continue-on-error: true`) : si WiX
  échoue, la release est publiée sans MSI (exe + web seulement), avec un
  avertissement dans le résumé du job. En local, `build_msi.bat` échoue
  franchement si WiX est introuvable.
- `verify_release.py` ne tourne jamais en local — c'est un health-check
  post-publication déclenché uniquement par `release.yml`, sur une version déjà
  publiée sur GitHub Releases.

## Fichier → rôle

| Fichier | Rôle |
|---|---|
| `stamp_version.py` | Bump la version applicative partout où elle doit apparaître (source unique : `src/elium/__init__.py`) et recalcule `BUILD_CODE_HASH` dans `updater.py`. Appelé par la CI juste avant le build, utilisable en local (`python installer/stamp_version.py 4.6.0`). |
| `build_common.py` | Utilitaires partagés entre `stamp_version.py` et `gen_manifest.py` : `repo_root()` et surtout `compute_code_hash()`, l'empreinte sha256 déterministe des sources Python figées dans l'exe (sert à décider côté client si une mise à jour peut rester web-only ou exige un nouvel exe). |
| `build.bat` | Script de build local tout-en-un : crée/vérifie le venv Python, installe les dépendances (+ PyInstaller épinglé), build le Web Studio (`npm run build`), lance PyInstaller sur `elium.spec` → `staging/Elium.exe`. |
| `elium.spec` | Spec PyInstaller (one-file). Point d'entrée : `elium_launcher.py`. Embarque `web-studio/dist` (Web Studio pré-buildé), les modules `elium.*` nécessaires (crypto, format, cli), `updater.py`, et la ressource `version_info.txt` (VERSIONINFO Windows, stampée par `stamp_version.py`). |
| `elium_launcher.py` | **Point d'entrée réel de l'application installée.** Lance un serveur HTTP local qui sert le Web Studio pré-buildé, puis ouvre une fenêtre navigateur dédiée (mode `--app`). Voir « Architecture » ci-dessous — ce n'est **pas** la même chose que l'app PySide6 legacy de `desktop/src/app.py`. |
| `build_msi.bat` | Script de build local du MSI via WiX Toolset (localise `candle.exe`/`light.exe`, appelle `make_msi_assets.py` et `print_version.py`, compile `elium.wxs`). Nécessite que `build.bat` ait déjà produit `staging/Elium.exe`. |
| `elium.wxs` | Source WiX (XML) de l'installeur MSI **officiel** : arborescence d'installation (Program Files), raccourcis Menu Démarrer/Bureau, association de fichiers `.elium`, `UpgradeCode` (identité produit, ne jamais changer), assistant graphique en français. |
| `make_msi_assets.py` | Génère les ressources exigées par WixUI : `assets/license.rtf` (LICENSE convertie en RTF), `assets/msi-banner.bmp` et `assets/msi-dialog.bmp` (visuels réutilisant le dessin vectoriel de `brand/make_icons.py`). Appelé automatiquement par `build_msi.bat`. |
| `print_version.py` | Utilitaire d'une ligne : affiche la version applicative courante lue dans `src/elium/__init__.py`. Sert à `build_msi.bat` pour nommer dynamiquement `Elium-X.Y.Z-Setup.msi` sans version codée en dur. |
| `gen_manifest.py` | Génère et **signe (Ed25519)** le manifeste de mise à jour `latest.json` (+ `.sig`) : liste `codeHash`, et pour chaque artefact fourni (exe/web/msi) son URL de release GitHub, sa taille et son sha256. Consomme aussi le changelog produit par `changelog.py`. |
| `changelog.py` | Construit l'historique des nouveautés (à partir de `git log`) intégré au manifeste signé — filtre le bruit (`chore`, `ci`, `merge`, etc.) et humanise les messages de commit conventionnels pour la carte de mise à jour affichée dans l'app. |
| `updater.py` | Module client d'auto-update, embarqué dans l'exe. Vérifie GitHub Releases, télécharge et vérifie (signature Ed25519 avec la clé publique embarquée, puis sha256 par artefact) avant d'appliquer une mise à jour (overlay web léger dans `%LOCALAPPDATA%`, ou nouvel exe complet via handoff). Tout échec de vérification jette l'artefact sans jamais crasher l'app. |
| `verify_release.py` | Health-check post-publication, lancé uniquement par `.github/workflows/release.yml` juste après `gh release create`. Réutilise `updater.fetch_manifest_for()` pour retélécharger le manifeste + chaque artefact publié et revérifier signature/sha256/disponibilité, avec reprises pour absorber la propagation CDN. Ne modifie et ne supprime jamais rien. |

## Architecture : `elium_launcher.py` n'est pas l'app desktop legacy

`installer/elium_launcher.py` est le vrai point d'entrée shippé dans `Elium.exe` :
il sert localement le Web Studio (React) pré-buildé dans `web-studio/dist` et
ouvre une fenêtre navigateur dédiée. C'est ce code, et lui seul, qui tourne chez
un utilisateur qui installe Elium via le MSI.

Il existe par ailleurs, ailleurs dans le dépôt, une application desktop PySide6
plus ancienne (`desktop/src/app.py`). Elle n'a **aucun rapport** avec ce dossier :
elle n'est ni buildée, ni packagée, ni référencée par `elium.spec`,
`build.bat` ou `elium.wxs`. Ne pas la confondre avec `elium_launcher.py` en
lisant ce dossier.

## Chemin Inno Setup supprimé

Le fichier `installer/elium_setup.iss` (installeur Inno Setup alternatif,
jamais utilisé par la CI) a été supprimé le 2026-09-08 : il était mort depuis
le début et source de confusion sur le chemin d'installeur officiel. Le seul
installeur distribué est le `.msi` produit à partir de `elium.wxs` / WiX
Toolset (`build_msi.bat` en local, étapes WiX inline en CI) — voir la section
suivante.

## Prérequis pour builder en local

- **Python 3.9+** dans le `PATH` (`py` ou `python`) — un venv isolé
  (`.venv/` à la racine du dépôt) est créé automatiquement par `build.bat` s'il
  n'existe pas déjà.
- **Node.js** dans le `PATH` (pour `npm install` / `npm run build` du Web Studio ;
  voir la CI pour la version de référence : Node 26).
- **WiX Toolset v3.11 ou v3.14** (`candle.exe` + `light.exe`), uniquement pour
  `build_msi.bat` — installeur officiel ([wixtoolset.org](https://wixtoolset.org/))
  ou binaires portables `wix314-binaries.zip` extraits dans
  `%LocalAppData%\WiX314`. **Attention à la version** : ce sont les outils WiX
  v3 (`candle`/`light`) qui sont utilisés ici, pas la CLI `wix build` de WiX v4/5
  — un WiX v4/v5 seul (sans le SDK/toolset v3 legacy) ne fournit pas ces
  exécutables et `build_msi.bat` ne le trouvera pas.
- **Pillow**, requis par `make_msi_assets.py` (appelé automatiquement par
  `build_msi.bat`) pour régénérer les visuels WixUI. Il n'est déclaré dans
  aucune dépendance du projet (`pyproject.toml` ne liste que
  `cryptography`/`argon2-cffi`, plus `PySide6` pour l'extra `desktop`) : à
  installer manuellement dans le venv si l'étape échoue avec
  `ModuleNotFoundError: PIL` (`.venv\Scripts\pip install Pillow`).

## Tester une build MSI en local

1. `installer\build.bat` — produit `installer\staging\Elium.exe` (build complet :
   venv, Web Studio, PyInstaller). Le script s'arrête avec un message clair si
   Python/Node manquent.
2. `installer\build_msi.bat` — nécessite l'étape 1 déjà faite et WiX installé
   (voir prérequis). Régénère les assets WixUI, lit la version courante, compile
   `elium.wxs` (`candle` puis `light`) et produit
   `installer\output\Elium-X.Y.Z-Setup.msi`.
3. Installer le MSI généré (double-clic, ou `msiexec /i "installer\output\Elium-X.Y.Z-Setup.msi" /l*v install.log`
   pour un journal détaillé en cas d'échec — l'installation est *perMachine*,
   donc une élévation UAC est demandée). Idéalement dans une VM ou un
   environnement jetable plutôt que sur le poste principal, pour vérifier
   proprement raccourcis Menu Démarrer/Bureau, association `.elium` et
   désinstallation via « Applications installées ».
4. Une mise à jour majeure remplace proprement l'ancienne installation
   (`MajorUpgrade` dans `elium.wxs`) : relancer `build_msi.bat` après un bump de
   version (`stamp_version.py`) et réinstaller par-dessus est un bon test de ce
   chemin.
5. Pour un test complet incluant le manifeste de mise à jour, `gen_manifest.py`
   nécessite une clé privée Ed25519 (`--key`/`--key-file`/env
   `UPDATE_SIGNING_KEY`) — en local, sans cette clé, on peut s'arrêter après
   l'étape 2 (le MSI seul se teste indépendamment de l'auto-update).

## Onboarding mainteneur : la clé de mise à jour Ed25519

Étape **unique, à faire une seule fois par dépôt** (pas à chaque release, pas à
chaque build) : générer la paire de clés Ed25519 qui signe le manifeste de
mise à jour `latest.json`. Ne la relancer que si on décide délibérément de
faire une rotation de clé — voir le risque plus bas.

1. Lancer `python scripts/gen_update_keypair.py` depuis la racine du dépôt.
   Le script écrit la clé privée dans `update-private-key.hex` (déjà couvert
   par `.gitignore`) et affiche la clé publique correspondante à l'écran.
   `--print` affiche les deux clés sans rien écrire sur disque, si on préfère
   les copier directement depuis le terminal.
2. Coller la clé **privée** (64 caractères hex) dans le secret GitHub Actions
   `UPDATE_SIGNING_KEY` (Settings ▸ Secrets and variables ▸ Actions ▸ New
   repository secret). C'est ce secret que `.github/workflows/release.yml`
   lit (`secrets.UPDATE_SIGNING_KEY`) pour signer le manifeste au moment de
   publier une release ; tant qu'il est absent, le workflow tourne au vert
   mais ne publie pas de release signée.
3. Coller la clé **publique** (64 caractères hex) dans les deux fichiers de
   code qui l'embarquent en dur, à l'identique dans les deux :
   - `installer/updater.py`, constante `UPDATE_PUBLIC_KEY_HEX` (updater
     Windows/exe).
   - `install.sh`, variable `UPDATE_PUBLIC_KEY_HEX` (updater Linux, vérifie
     via `openssl` en reconstruisant une clé publique DER/SPKI à partir de ce
     même hex).
4. Supprimer le fichier local `update-private-key.hex` une fois le secret
   GitHub renseigné — il ne doit jamais être commité.

**Risque si on oublie l'un des deux endroits (ou si les deux ne sont pas
identiques) :** la clé publique de `updater.py`/`install.sh` est celle qui est
*embarquée dans le binaire déjà installé chez les utilisateurs* — elle ne se
met pas à jour toute seule après coup, contrairement au secret GitHub qui
prend effet immédiatement sur la prochaine release. Si on régénère la paire
(rotation) et qu'on met à jour le secret `UPDATE_SIGNING_KEY` sans republier
une build dont `updater.py`/`install.sh` embarquent la nouvelle clé
publique : toutes les releases suivantes seront signées avec la nouvelle clé
privée, mais les clients déjà installés vérifient toujours avec l'ancienne
clé publique figée dans leur exe — `_verify_signature` échoue silencieusement
pour chaque màj (« Le moindre échec => artefact jeté, l'app continue sur la
version courante. Jamais de crash. ») : l'auto-update s'arrête net et sans
message d'erreur visible, indéfiniment, jusqu'à ce que l'utilisateur
réinstalle manuellement une build à jour. Si en plus on oublie de
synchroniser `installer/updater.py` et `install.sh` *entre eux* (une seule
des deux constantes mise à jour), c'est l'updater de la plate-forme oubliée
(Windows ou Linux) qui se retrouve seul désynchronisé du secret CI, avec le
même symptôme silencieux sur cette seule plate-forme.
