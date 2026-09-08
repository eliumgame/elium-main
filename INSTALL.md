# Installer Elium

Il existe **deux installations totalement distinctes**, à ne pas confondre :

1. **La suite bureautique** (Documents, Tableur, Présentations, PDF) — une
   application Windows qui s'installe en quelques secondes sur votre PC,
   sans rien construire ni configurer.
2. **Le Drive d'entreprise** — un service que l'on déploie une seule fois sur
   un serveur (VPS) pour que toute une équipe partage, co-édite et signe des
   documents en ligne. Cette partie utilise le script `install.sh`.

Vous n'avez besoin que de l'une des deux (ou des deux, si vous voulez à la
fois utiliser la suite sur votre poste **et** administrer un Drive d'équipe).

Pour la documentation complète (format, cryptographie, sécurité, RGPD,
chaque module…), ouvrez Elium puis le bouton **Documentation** en haut de
l'accueil : elle vit désormais dans l'application elle-même. Ce fichier ne
couvre que l'installation.

---

## 1. Suite bureautique locale (Windows)

C'est le cas le plus courant : vous voulez utiliser Elium sur votre PC,
comme n'importe quel logiciel de bureau.

### Téléchargement

1. Rendez-vous sur la page des releases GitHub du projet :
   `https://github.com/eliumgame/elium-main/releases/latest`
2. Dans la section « Assets », téléchargez l'un des deux fichiers suivants
   (les deux installent la même application ; le MSI est recommandé) :

   | Fichier | Ce que c'est |
   |---|---|
   | `Elium-<version>-Setup.msi` | Installateur classique Windows : copie l'application dans `Program Files`, crée les raccourcis Bureau/Menu Démarrer, associe les fichiers `.elium`, et ajoute une entrée de désinstallation propre dans « Applications ». **Recommandé pour un usage courant.** |
   | `Elium.exe` | Exécutable autonome (« portable ») : aucune installation, aucun droit administrateur requis — on double-clique et l'application démarre directement depuis le dossier où il se trouve (clé USB, dossier partagé…). Pas de raccourcis, pas d'association de fichiers, pas de désinstalleur : à supprimer soi-même pour « désinstaller ». |

Aucune compilation n'est nécessaire : ce sont des binaires déjà construits,
prêts à l'emploi. (Si vous cherchez à *construire* Elium vous-même à partir
des sources, consultez le `README.md`, destiné aux développeurs.)

### Installation

- **MSI** : double-cliquez sur le fichier `.msi` et suivez l'assistant
  (langue française disponible). Windows SmartScreen peut afficher un
  avertissement la première fois car l'exécutable n'est pas encore signé par
  un éditeur reconnu de Microsoft — cliquez sur « Informations
  complémentaires » puis « Exécuter quand même » pour poursuivre.
- **EXE portable** : double-cliquez simplement sur `Elium.exe`. Même
  avertissement SmartScreen possible, à valider de la même façon.

Configuration requise : Windows 10 ou 11, 64 bits.

### Mise à jour

Elium intègre une **mise à jour automatique** : au démarrage, l'application
vérifie s'il existe une version plus récente sur GitHub Releases, télécharge
la mise à jour, vérifie sa signature cryptographique (Ed25519) avant de
l'appliquer, puis vous propose de l'installer — aucune action manuelle n'est
nécessaire au quotidien. Vous pouvez toujours forcer une vérification ou
retélécharger une version depuis la page des releases si besoin.

### Désinstallation

- **MSI** : « Applications installées » (Paramètres Windows) → Elium →
  Désinstaller.
- **EXE portable** : supprimez simplement le fichier `Elium.exe` (et le
  dossier de données utilisateur si vous souhaitez tout effacer).

---

## 2. Drive d'entreprise (serveur / VPS)

Cette partie s'adresse à qui doit **héberger** le Drive Elium pour une
équipe ou une organisation (partage, RBAC, SSO/SCIM, co-édition temps réel,
signature de documents). Elle se déploie sur un serveur Linux (VPS) via
Docker, avec le script `install.sh` fourni à la racine du dépôt.

`install.sh` ne s'occupe **que** de ce côté serveur : il ne construit pas et
ne fournit pas la suite Windows du point 1 (celle-ci se télécharge en MSI,
voir plus haut).

### Prérequis sur le serveur

- Un serveur Linux (VPS) avec accès `bash`.
- **Docker** + **Docker Compose v2** (`docker compose ...`) — ou à défaut
  l'ancien binaire `docker-compose`, également accepté.
- `openssl` (génération des secrets et vérification des signatures de mise
  à jour), `curl` (vérifications de santé, téléchargement des mises à jour).
- `git` — le dépôt doit être **cloné** (pas téléchargé en archive `.zip`),
  car la mise à jour automatique du serveur s'appuie sur l'historique git
  pour basculer sur le commit exact signé par chaque release.
- Si vous visez un accès public en HTTPS : un nom de domaine pointant déjà
  vers l'adresse IP du serveur (le certificat TLS est ensuite obtenu et
  renouvelé automatiquement par Caddy/Let's Encrypt).

### Installation rapide

```bash
git clone https://github.com/eliumgame/elium-main.git
cd elium-main

# Menu interactif (recommandé pour une première installation) :
bash install.sh

# Ou directement en ligne de commande :
bash install.sh drive --domain drive.exemple.fr --email vous@exemple.fr   # production, HTTPS auto
bash install.sh drive --local                                             # test local, http://localhost, sans TLS
```

### Ce que fait `install.sh drive`

1. Vous demande (ou reçoit en option) le domaine public, ou bascule en mode
   local sans TLS si aucun domaine n'est fourni.
2. Génère un fichier `.env` à la racine du dépôt avec les secrets requis
   (jeton de session, mot de passe PostgreSQL, origines CORS…) — générés
   aléatoirement et **conservés** si vous relancez le script plus tard (les
   perdre invaliderait les sessions et la 2FA, mais jamais les données,
   chiffrées côté client).
3. Lance la pile Docker (`docker compose up -d --build`) : API, base de
   données PostgreSQL, reverse-proxy Caddy (TLS automatique), et
   éventuellement MinIO si vous choisissez le stockage S3 plutôt que le
   volume de fichiers par défaut.
4. Attend que l'API réponde à son point de contrôle de santé et vous
   indique si tout est opérationnel.
5. Vous propose d'activer les **mises à jour automatiques signées** du
   serveur (recommandé en production) : le serveur vérifiera alors
   régulièrement (toutes les 30 minutes par défaut, via `systemd` ou
   `cron`) s'il existe une nouvelle version signée sur GitHub Releases, et
   l'appliquera automatiquement avec sauvegarde préalable de la base et
   retour en arrière automatique en cas d'échec du contrôle de santé.

Une fois le déploiement terminé, ouvrez l'adresse affichée dans un
navigateur, créez le premier compte (propriétaire) puis votre organisation,
et activez la double authentification dans l'onglet Sécurité.

### Autres commandes utiles

```bash
bash install.sh status                    # état de la pile Docker
bash install.sh backup                    # sauvegarde base + fichiers (chiffrés)
bash install.sh restore <horodatage>      # restaure une sauvegarde
bash install.sh update                    # met à jour manuellement (git pull + reconstruction)
bash install.sh auto-update on|off|status|now   # gère la mise à jour automatique
bash install.sh help                      # rappel de toutes les options
```

### Configuration avancée

Le script génère un `.env` minimal pour démarrer rapidement. Pour les
options avancées (bascule vers le stockage S3/MinIO, quotas par
organisation, relais Redis pour un déploiement multi-serveurs, etc.),
consultez :

- [`docker-compose.yml`](docker-compose.yml) — la définition des services
  (API, base de données, proxy Caddy, MinIO optionnel, Redis optionnel) ;
- [`deploy/.env.example`](deploy/.env.example) — la liste commentée de
  toutes les variables de configuration disponibles.

### Lancer la suite dans le navigateur sans Docker (sans installer le Drive)

`install.sh` propose aussi une troisième commande, indépendante du Drive
d'entreprise, utile sur un poste Linux/Mac (ou tout poste avec Node.js) qui
ne souhaite pas installer l'application Windows : elle construit et lance
la suite bureautique dans un navigateur, en local, sans Docker ni serveur.

```bash
bash install.sh suite   # nécessite Node.js 20+ — construit puis ouvre http://localhost:3100
```

Cette suite fonctionne alors entièrement en local sur ce poste (aucune
donnée envoyée nulle part) ; elle ne remplace pas le Drive d'entreprise, qui
nécessite `bash install.sh drive`.
