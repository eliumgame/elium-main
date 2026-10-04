## Installation et prise en main

### Installer Elium sur Windows

Configuration requise : Windows 10 ou 11, 64 bits, et Microsoft Edge ou Google
Chrome (voir plus bas). Téléchargez les fichiers depuis la page des releases du
dépôt (`github.com/eliumgame/elium-main/releases/latest`).

| Fichier | Pour qui | Droits administrateur | Où il s'installe |
|---|---|---|---|
| `Elium-X.Y.Z-Setup.msi` | Installation pour **tous les utilisateurs** du PC. Recommandé | Oui | `Program Files\Elium` |
| `Elium-User-X.Y.Z.msi` | Installation **pour vous seul**, sans droits administrateur | Non | `%LOCALAPPDATA%\Programs\Elium` |
| `Elium.exe` | Exécutable autonome, sans installation (clé USB, dossier partagé) | Non | Là où vous le placez |
| `Elium-update-X.Y.Z.eliumupdate` | Paquet de mise à jour hors ligne (voir Mises à jour automatiques) | Non | Non applicable |

N'installez **qu'un seul** des deux MSI : ce sont deux produits indépendants.

Les deux MSI :

- ouvrent un assistant en français (Bienvenue, Licence, Dossier, Installation, Fin) ;
- créent un raccourci dans le Menu Démarrer et sur le Bureau ;
- associent les fichiers **`.elium`** (double-clic = ouverture dans Elium) et **`.eliumupdate`** (double-clic = mise à jour hors ligne) ;
- proposent de lancer Elium à la fin ;
- remplacent proprement une version plus ancienne.

L'exe autonome n'a ni raccourci, ni association de fichiers, ni désinstalleur.

> Windows SmartScreen peut afficher un avertissement au premier lancement : les
> exécutables ne sont pas signés par un éditeur reconnu (Authenticode). Cliquez
> sur « Informations complémentaires », puis « Exécuter quand même ». L'intégrité
> des mises à jour, elle, est vérifiée par la signature d'Elium (voir Mises à jour
> automatiques).

### Comment l'application démarre

`Elium.exe` ne contient pas de serveur Drive. Au lancement, il fait trois choses.

1. Il démarre un petit serveur web **sur `127.0.0.1` uniquement**. Il n'est jamais accessible depuis le réseau.
2. Il choisit un port libre entre 3000 et 3100 (ou le port que vous avez épinglé dans les Réglages).
3. Il ouvre une **fenêtre dédiée** : Microsoft Edge ou Google Chrome en mode `--app`, avec un profil séparé de votre navigateur personnel. Pas de barre d'adresse, pas d'onglets.

Si ni Edge ni Chrome n'est trouvé, Elium ouvre un onglet de votre navigateur par
défaut. Dans ce cas, les mêmes fonctions marchent, mais l'application n'a pas de
fenêtre propre.

À la fermeture de la fenêtre, le serveur s'arrête.

### Instance unique et double-clic sur un `.elium`

Elium n'ouvre qu'**une seule fenêtre** à la fois. Si l'application est déjà ouverte
et que vous double-cliquez sur un fichier `.elium` :

1. le second lancement dépose le fichier dans une boîte aux lettres locale (`%LOCALAPPDATA%\Elium\inbox`) ;
2. il ramène la fenêtre existante au premier plan ;
3. il se ferme : la fenêtre ouverte charge le fichier.

Si le fichier dépasse 256 Mo, ou si l'instance ouverte ne le prend pas en
charge en 5 secondes, Elium démarre une seconde fenêtre normalement.

### Où sont vos données

Tout est dans `%LOCALAPPDATA%\Elium` (collez ce chemin dans l'Explorateur).

| Élément | Contenu |
|---|---|
| `WebProfile\` | Le profil du navigateur dédié : **vos documents, l'espace de travail, le coffre local, vos clés et vos réglages** |
| `launcher-config.json` | Le port épinglé |
| `update-settings.json` | Le canal de mise à jour et les versions mises en quarantaine |
| `update.log` | Le journal des mises à jour (utile au support) |
| `web\`, `bin\`, `assets\`, `tmp\` | Les mises à jour téléchargées (interface, lanceur, polices et ressources) |
| `inbox\` | La boîte aux lettres du double-clic, vidée à chaque démarrage |

> **Sauvegardez votre travail dans des fichiers `.elium`**, et utilisez la
> sauvegarde `.elium-workspace` pour la bibliothèque (voir Espace de travail
> local). Effacer `WebProfile\` supprime tout ce qui n'a pas été exporté.

### Désinstaller

- **MSI** : Paramètres Windows, Applications installées, Elium, Désinstaller.
- **Exe autonome** : supprimez `Elium.exe`.

La désinstallation du MSI supprime les mises à jour téléchargées (`web\`, `bin\`,
`assets\`, `tmp\`). Elle **ne touche jamais** à `WebProfile\` ni aux réglages :
vos documents restent. Pour tout effacer, supprimez ensuite le dossier
`%LOCALAPPDATA%\Elium` vous-même. Une mise à niveau du MSI ne nettoie rien.

### Utiliser Elium dans un navigateur (PWA)

L'interface web est la même que celle de l'application de bureau. Vous pouvez
l'héberger vous-même (par exemple avec `bash install.sh suite`, qui sert la suite
sur `http://localhost:3100`) ou l'utiliser sur un Drive.

- **Installable** : Chrome et Edge proposent d'installer Elium comme application (manifeste `Elium Studio`, affichage autonome).
- **Hors-ligne** : un service worker met l'interface en cache. Les fichiers de l'interface (code et feuilles de style) sont mis en cache à l'installation. Les polices, les modèles OCR et le cœur WebAssembly sont mis en cache ensuite, en arrière-plan. Après quelques secondes, l'application marche sans réseau.
- **Navigation** : le réseau est essayé d'abord, puis le cache. Les ressources statiques sortent du cache d'abord. Les requêtes vers d'autres sites ne sont jamais interceptées.
- **Fichiers `.elium`** : l'application installée déclare qu'elle peut ouvrir les fichiers `.elium` (gestionnaire de fichiers de la PWA, pris en charge selon le navigateur).
- **Mises à jour** : c'est le navigateur qui renouvelle le cache à chaque nouvelle version. L'application de bureau, elle, a son propre système.

### Installer un serveur Drive (administrateurs)

Le Drive est un service à part, auto-hébergé. Le point d'entrée est le script
`install.sh` à la racine du dépôt (sous Windows : Git Bash ou WSL).

```bash
bash install.sh                                   # menu interactif
bash install.sh drive --domain drive.exemple.fr --email vous@exemple.fr
bash install.sh drive --local                     # test local (http://localhost)
bash install.sh suite                             # suite dans le navigateur (port 3100)
bash install.sh update | status | backup          # exploitation
```

Pour un VPS :

1. Faites pointer un enregistrement DNS **A/AAAA** du domaine vers le serveur, avant de lancer le script.
2. Installez Docker et Docker Compose, puis clonez le dépôt.
3. Lancez `install.sh drive --domain …`. Le script génère `TOKEN_SECRET` et les mots de passe de la base et de Redis, écrit `.env`, construit la pile, attend `/api/health` et active HTTPS automatiquement (Caddy).
4. Le premier compte créé est le **propriétaire** : il crée l'organisation et reçoit la clé de recouvrement.
5. Dans l'application de bureau, carte Drive, bouton **Serveur**, saisissez `https://votre-domaine/api`.

Relancer le script est sans danger : il conserve les secrets existants. Les
options, les sauvegardes, la mise à jour automatique du serveur et le dépannage
sont décrits dans la section « Exploitation du Drive (VPS) ».

### Première prise en main

1. **Accueil** : choisissez une application (Documents, Tableur, Présentations, PDF) ou glissez un fichier `.elium` ou PDF dans la zone de dépôt. Vous pouvez aussi importer `.docx`, `.txt`, `.md` ou `.html`.
2. **Écrivez**. Les brouillons sont enregistrés automatiquement dans l'application (par défaut toutes les 3 secondes, réglable dans Réglages, Édition).
3. **Enregistrez** avec Ctrl+S. Dans l'application de bureau et dans les navigateurs Chromium, le fichier choisi est réécrit sur place. Ctrl+Maj+S permet de choisir un autre emplacement. Sans cette fonction du navigateur (Firefox, Safari), Elium télécharge le fichier.
4. **Protégez** si besoin : mot de passe, destinataires, signature. Voir les sections sur le format et les signatures.
5. **Retrouvez** vos documents : l'accueil liste les éléments récents. La recherche de l'espace de travail les retrouve par leur contenu.

Ctrl+K ou Ctrl+Maj+P ouvre la palette de commandes : toutes les actions y sont
cherchables.

### Limites connues de l'installation

- L'application de bureau est réservée à Windows 10 et 11 en 64 bits.
- La fenêtre dédiée demande Edge ou Chrome installés. Sans eux, repli sur l'onglet du navigateur par défaut.
- Les exécutables ne sont pas signés Authenticode : SmartScreen avertit au premier lancement.
- Le dossier `WebProfile\` est la seule copie de vos documents tant que vous ne les avez pas exportés. Aucune synchronisation n'existe en mode local.
