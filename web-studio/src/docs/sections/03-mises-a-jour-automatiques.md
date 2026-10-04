## 3. Mises à jour automatiques

Elium applique un **modèle « push = publication »** et **une racine de confiance
unique** (la signature Ed25519, jamais le CDN) pour maintenir à jour aussi bien
l'application de bureau que le serveur Drive.

### 3.1 Publication (mainteneur)

`git push origin master` suffit **si `__version__` a été augmenté** (`src/elium/__init__.py`) : une version déjà publiée est signalée par un avertissement, jamais silencieusement ignorée. Le workflow `.github/workflows/release.yml` s'exécute **après une CI verte** sur ce commit, en trois jobs aux privilèges séparés :

1. **gate** : décide (CI verte, branche master) et lit la version exacte, préversion comprise ;
2. **build** (sans aucun secret, droits en lecture) : stampe version + `codeHash`, build le Web Studio, produit `Elium.exe` (PyInstaller) puis le **teste** (`installer/smoke_test.py` : version, CSP stricte, aucune URL externe, contrôle Host), construit les **deux MSI** (bloquants), découpe l'interface en `web-core.zip` + pack d'assets et génère les SBOM CycloneDX ;
3. **publish** (seul job qui voit la clé) : **signe** `latest.json` (Ed25519), crée le paquet hors ligne `.eliumupdate`, publie la GitHub Release avec ses notes (issues de `changelog.py`), l'**attestation de provenance** et revérifie les assets publiés (`installer/verify_release.py`).

**Release à la main** (Actions ▸ Release ▸ Run workflow) : `bump` = `none` (publie le `__version__` du code), `auto` (déduit des commits conventionnels par `scripts/next_version.py` : `feat` = mineur, `fix` = correctif, `!`/BREAKING = majeur ; rien à publier = erreur explicite), ou `patch`/`minor`/`major` ; `prerelease` = `rc`/`beta` produit `X.Y.Z-rc1` publiée comme **préversion** GitHub. Ce déclenchement n'écarte plus la CI : elle doit être verte sur le commit visé.

**Setup unique (deux actions)** :
1. **Repo PUBLIC** — sinon les assets de Release ne sont pas téléchargeables par
   les utilisateurs. Le code d'Elium peut être public sans risque : la sécurité
   est *zéro-connaissance*, elle ne dépend pas du secret du code.
2. **Secret `UPDATE_SIGNING_KEY`** — clé privée Ed25519 (`scripts/gen_update_keypair.py`
   → `update-private-key.hex`) déposée dans *Settings ▸ Secrets ▸ Actions*. La
   clé publique correspondante est embarquée dans `installer/updater.py`. Ne
   jamais committer la clé privée. Tant que ce secret est absent, `release.yml`
   s'exécute mais **ne publie pas** (run vert, sans échec).

### 3.2 Application de bureau (client)

`installer/updater.py`, embarqué dans l'exe : au lancement puis périodiquement,
l'app **détecte** une mise à jour (télécharge `latest.json` + `.sig`, **vérifie
la signature** avec la clé publique embarquée, compare les versions) — **sans
rien télécharger** d'autre. Si une mise à jour existe, une **carte discrète à un
seul bouton** apparaît (« Mettre à jour »), aux couleurs de la marque Elium.

La carte annonce **l'ensemble des nouveautés**, pas seulement la dernière release :
le manifeste signé transporte un **historique par version**
(`history: [{version, date, changes[]}]`), réduit par `updater.release_notes()`
à ce qui est strictement postérieur à la version installée (qui saute trois
versions voit donc les trois). Le sous-titre résume l'ampleur (« 3 versions,
12 nouveautés ») et un bouton « Voir les nouveautés » déroule la liste groupée
par version. Ces champs sont **dans la charge signée** : un intermédiaire ne peut
pas réécrire ce que l'app annonce. Les champs sont additifs (un manifeste sans
`history` retombe sur `changes`). La liste est construite en CI par
`installer/changelog.py` depuis `git log <tag précédent>..HEAD` — d'où le besoin
de `fetch-depth: 0`. `changelog.version_tuple` est la source unique de la
comparaison de versions.

Au clic : téléchargement avec **barre de progression animée** (endpoints
`/__update__`, `POST /__update__/start`), puis :

- **màj web** (cas courant) : `web.zip` vérifié (sha256 du manifeste signé) est
  déposé dans `%LOCALAPPDATA%\Elium\web\<version>\` ; la carte propose
  **« Recharger »** (un clic applique la nouvelle interface). Léger, sans admin.
- **màj exe** (le lanceur/Python a changé, détecté via `codeHash`) : le nouvel
  `Elium.exe` vérifié est déposé dans `%LOCALAPPDATA%\Elium\bin\` ; la carte
  propose **« Redémarrer Elium »** (`POST /__update__/restart` : handoff). Sinon
  appliqué au prochain démarrage. Aucun UAC, rien dans `Program Files`.

#### États de la carte et du pied de l'accueil

- **Mise à jour disponible / téléchargement / prête** : comme ci-dessus.
- **Vérification impossible** : « à jour » n'est plus affiché quand la vérification elle-même a échoué. Cause distincte : *hors ligne* (la carte reste discrète, l'application est conçue pour fonctionner sans réseau ; le pied de l'accueil l'indique), *quota GitHub atteint* (nouvel essai différé automatiquement), *signature invalide* (mise à jour refusée) ou *clé de signature inconnue* (réinstaller depuis le site officiel). Le bouton **Vérifier maintenant** du pied de l'accueil force une vérification.
- **Retour à la version précédente** : si un nouveau lanceur plante au démarrage 3 fois de suite, Elium revient tout seul à la version embarquée, met cette version en quarantaine et l'annonce une fois.
- **Canal** : *Stable* (défaut) ou *Bêta* (préversions incluses), au pied de la carte et dans « Gérer les versions » ; mémorisé dans `%LOCALAPPDATA%\Elium\update-settings.json`.

#### Intégrité vérifiée à chaque lancement

Le manifeste signé est conservé à côté de chaque interface/lanceur téléchargé. Au démarrage, la signature est **revérifiée**, puis le sha256 du lanceur ou l'**empreinte d'arborescence** de l'interface : un fichier modifié dans `%LOCALAPPDATA%\Elium` est ignoré et l'application retombe sur la version embarquée. Seuls le lanceur courant et le précédent sont conservés dans `bin\`. Les téléchargements interrompus **reprennent** (HTTP Range, sha256 de l'ensemble vérifié).

#### Mise à jour légère : pack d'assets séparé

Polices, ressources pdf.js et OCR (~9 Mo+) vivent dans `assets-<empreinte>.zip`, retéléchargé **uniquement si son empreinte change** ; `web-core.zip` reste petit. Les deux sont fusionnés dans un seul dossier servi.

#### Mettre à jour sans connexion

Un paquet `Elium-update-X.Y.Z.eliumupdate` (joint à chaque release) se choisit dans la carte ou dans « Gérer les versions » (**Mettre à jour depuis un fichier…**), ou par double-clic dans l'Explorateur (`Elium.exe fichier.eliumupdate`). Sa signature est vérifiée exactement comme celle d'une mise à jour en ligne.

#### Rotation de la clé de signature

L'application embarque une **liste** de clés publiques avec identifiants ; le manifeste porte `keyId`. Une release signée par l'ancienne clé ajoute la nouvelle, puis les suivantes passent à la nouvelle ; un `keyId` inconnu est refusé.

#### Options d'installation Windows

- `Elium-X.Y.Z-Setup.msi` : tous les utilisateurs (`Program Files`, droits administrateur).
- `Elium-User-X.Y.Z.msi` : **sans droits administrateur** (`%LOCALAPPDATA%\Programs\Elium`) ; la version active est aussi reportée dans « Applications installées ». N'installez qu'un des deux.
- `Elium.exe` portable. La désinstallation du MSI supprime les mises à jour téléchargées, jamais vos données (profil, coffre local, réglages).

Le MSI reste l'installeur canonique pour une **install fraîche** ; l'auto-update
maintient à jour entre deux MSI. Journal : `%LOCALAPPDATA%\Elium\update.log`.
Désactivation : `ELIUM_NO_UPDATE=1`. **Rotation de clé** : publier d'abord une
version transitoire embarquant la **nouvelle** clé publique (signée avec
l'**ancienne**), puis, une fois largement déployée, basculer le secret CI.

### 3.3 Serveur Drive (VPS)

Le Drive se met à jour tout seul selon le même modèle. **Activer (une fois)** :
une invite le propose en fin de `install.sh drive` (activé par défaut en prod).
Sinon :

```bash
bash install.sh auto-update on       # installe un timer systemd (repli cron)
bash install.sh auto-update status   # planification + version déployée + journal
bash install.sh auto-update now      # forcer une passe immédiate
bash install.sh auto-update off      # désactiver
```

Chaque passe (`install.sh self-update`, appelée par défaut toutes les 30 min avec
délai aléatoire) :

1. **Télécharge** `latest.json` + `.sig` de la dernière GitHub Release.
2. **Vérifie la signature Ed25519** avec la clé publique embarquée (via `openssl`,
   miroir de `installer/updater.py`). Signature invalide ⇒ **refus**, aucune
   modification.
3. Compare la version publiée à la version déployée (`src/elium/__init__.py`).
   Rien à faire si ce n'est pas plus récent.
4. **Refuse d'écraser** un arbre git modifié localement (protège les
   personnalisations d'opérateur) ; **sauvegarde la base** avant migration.
5. Bascule sur le **commit EXACT signé** (champ `commit` du manifeste ; repli sur
   le tag `vX.Y.Z`) après avoir vérifié qu'il est **contenu dans `origin/master`**
   (défense en profondeur).
6. Reconstruit la pile (`docker compose up -d --build`), rejoue les **migrations
   idempotentes**, puis **health-check** `/api/health`.
7. **Rollback automatique** en cas d'échec de santé : retour au commit précédent,
   reconstruction, health-check. Tout est journalisé dans `deploy/auto-update.log`.

`/api/health` expose la version réelle (`ELIUM_VERSION`). Le `.env` (secrets)
n'est jamais touché ; la clé **privée** de signature reste hors du VPS.
Pré-requis : déploiement **par `git clone`** + `openssl` + `docker compose`.

---
