## Mises à jour automatiques

L'application de bureau se met à jour toute seule, **sans droits administrateur**
et sans rien envoyer de vos documents. La confiance repose sur une seule chose :
la **signature Ed25519** de chaque version. Le réseau et GitHub ne sont jamais
crus sur parole.

> Ce système n'existe que dans l'application de bureau Windows. Dans un navigateur
> ou une PWA, le navigateur renouvelle le cache au rechargement. Le panneau de
> versions affiche alors « Mises à jour gérées par le navigateur ».

### Comment ça marche

1. **Détection** : au lancement, puis toutes les 30 minutes, Elium télécharge le manifeste `latest.json` et sa signature depuis les versions publiées sur GitHub. Il **vérifie la signature** avec la clé publique embarquée, puis compare les versions. Rien d'autre n'est téléchargé.
2. **Carte** : s'il existe une version plus récente, une carte discrète apparaît en bas à droite, avec un seul bouton **Mettre à jour**.
3. **Téléchargement** : barre de progression animée. Chaque fichier est contrôlé par son empreinte sha256, qui figure dans le manifeste signé. Un téléchargement interrompu reprend où il s'était arrêté.
4. **Application** : selon ce qui a changé, la carte propose **Recharger maintenant** (interface seule, cas courant) ou **Redémarrer Elium** (lanceur modifié, cas rare).

Les mises à jour se déposent dans `%LOCALAPPDATA%\Elium` : rien n'est écrit dans
`Program Files`.

La carte annonce **toutes** les nouveautés depuis votre version, pas seulement la
dernière. Si vous sautez trois versions, vous voyez les trois. Le bouton « Voir les
nouveautés » déplie la liste, groupée par version. Ces textes sont dans la charge
signée : un intermédiaire ne peut pas les réécrire.

### Les états de la carte

| État | Ce que vous voyez | Boutons |
|---|---|---|
| Mise à jour disponible | « Mise à jour disponible » avec la version et un résumé (« 3 versions, 12 nouveautés ») | Mettre à jour, Plus tard |
| Téléchargement | « Téléchargement de la mise à jour… » avec le pourcentage | Aucun |
| Prête (interface) | « Mise à jour prête ! Rechargez… » | Recharger maintenant |
| Prête (lanceur) | « Mise à jour prête ! Redémarrez Elium… » | Redémarrer Elium |
| Échec | « Échec de la mise à jour » avec la cause | Réessayer, Plus tard |
| Vérification impossible | « Vérification impossible » avec la cause (tableau suivant) | Réessayer, Plus tard |
| Retour à la version précédente | « Retour à la version précédente » (voir plus bas) | Compris |

Quand tout va bien et qu'il n'y a rien de nouveau, la carte reste cachée. Le pied
de l'accueil affiche alors « à jour ».

#### Quand la vérification est impossible

Elium n'affiche **jamais** « à jour » si la vérification elle-même a échoué.

| Cause | Message du pied de l'accueil | Ce qui se passe | Que faire |
|---|---|---|---|
| Hors ligne | « hors ligne, mise à jour non vérifiée » | La carte reste **cachée** : Elium est conçu pour fonctionner sans réseau | Rien. Revenez en ligne puis cliquez sur **Vérifier maintenant** |
| Quota GitHub atteint | « vérification suspendue (trop de requêtes) » | Nouvel essai différé automatiquement | Attendre quelques minutes |
| Signature invalide | « signature de mise à jour refusée » | La mise à jour est **refusée** par sécurité | Ne pas insister ; voir Dépannage et FAQ |
| Clé de signature inconnue | « mise à jour signée par une clé inconnue » | La mise à jour est refusée | Réinstaller Elium depuis le site officiel |
| Réponse inattendue | « mise à jour non vérifiée » | Le service a répondu autrement que prévu | Réessayer plus tard |

Une signature « invalide » apparaît parfois brièvement juste après une publication,
quand les serveurs ne sont pas encore synchronisés. Elium refait seul jusqu'à trois essais
avant d'abandonner.

### Le pied de l'accueil et « Gérer les versions »

En bas de l'accueil : la version installée, le canal (« bêta » s'il est actif),
l'état, puis deux boutons.

- **Vérifier maintenant** force une vérification.
- **Gérer les versions** ouvre le même panneau que **Réglages, Mises à jour & version**.

Le panneau montre :

| Élément | Rôle |
|---|---|
| Version installée, dernière version publiée, état | Les trois repères |
| Canal | **Stable** (défaut) ou **Bêta** (préversions incluses) |
| Historique des versions | Les versions publiées, la plus récente d'abord, avec **Utiliser cette version** |
| Annuler la dernière mise à jour | Revient à la version livrée avec l'installeur |
| Mettre à jour depuis un fichier… | Applique un paquet `.eliumupdate` |
| Port de lancement | Voir Réglages et palette de commandes |

Le canal est mémorisé dans `%LOCALAPPDATA%\Elium\update-settings.json`. La variable
d'environnement `ELIUM_UPDATE_CHANNEL` (`stable` ou `beta`) l'emporte si elle est définie.

### Revenir en arrière

Trois mécanismes existent.

| Cas | Mécanisme |
|---|---|
| Vous voulez une version précise | **Utiliser cette version** dans l'historique : Elium télécharge cette version (signature vérifiée) et la sert. Rechargez ou redémarrez ensuite |
| Vous voulez annuler toutes les mises à jour | **Annuler la dernière mise à jour** : purement local, efface les mises à jour téléchargées et revient à la version de l'installeur. Aucun téléchargement |
| Le nouveau lanceur plante | **Garde anti boucle de plantage** (ci-dessous), automatique |

Limite : on ne peut pas descendre **sous la version de l'installeur**. Les versions
plus anciennes affichent « via réinstallation » : il faut alors réinstaller un
ancien MSI. De même, une version dont le lanceur diffère et qui n'est pas plus
récente que le vôtre demande une réinstallation par MSI.

#### Garde anti boucle de plantage

Quand un nouveau lanceur (`Elium.exe` téléchargé) est mis en service, Elium compte
les démarrages **sans « démarrage réussi »**. Le démarrage est réussi dès que la
première page est servie. Au quatrième essai raté (trois échecs déjà comptés),
Elium :

1. abandonne ce lanceur et le supprime ;
2. met cette version en **quarantaine** (elle ne sera plus proposée) ;
3. revient à la version livrée avec l'installeur ;
4. vous l'annonce une seule fois : « Retour à la version précédente ».

Cette garde concerne les lanceurs. Une mise à jour d'interface seule n'en a pas
besoin : si son contrôle échoue, Elium sert simplement la version d'origine.

### Vérification à chaque lancement

La signature n'est pas contrôlée qu'au téléchargement. Elium conserve le manifeste
signé à côté de chaque mise à jour, et le **revérifie à chaque démarrage** :

- la signature du manifeste ;
- puis l'empreinte sha256 du lanceur, ou l'empreinte de toute l'arborescence de l'interface.

Un fichier modifié dans `%LOCALAPPDATA%\Elium` (par un autre logiciel, ou à la main)
est donc **ignoré** : Elium retombe sur la version d'origine. Seuls le lanceur
courant et le précédent sont conservés dans `bin\`.

### Mise à jour légère : pack d'assets séparé

Les polices, les ressources du lecteur PDF et les modèles OCR pèsent plusieurs
mégaoctets. Ils vivent dans un pack à part, `assets-<empreinte>.zip`, qui n'est
retéléchargé **que si son empreinte change**. L'archive `web-core.zip` de
l'interface reste petite. Les deux sont fusionnées dans un seul dossier servi.

### Mettre à jour sans connexion

Chaque version publiée a un paquet `Elium-update-X.Y.Z.eliumupdate`. Il se
transporte sur une clé USB.

- Dans la carte ou dans **Gérer les versions** : **Mettre à jour depuis un fichier…**
- Ou par double-clic sur le fichier dans l'Explorateur (le MSI associe l'extension).
- Ou en ligne de commande : `Elium.exe --apply-update fichier.eliumupdate`.

Sa signature est vérifiée **exactement** comme celle d'une mise à jour en ligne.
Taille maximale acceptée depuis la carte : 420 Mo.

### Rotation des clés de signature

L'application embarque une **liste** de clés publiques, chacune avec un
identifiant. Le manifeste signé indique avec quelle clé il l'a été (`keyId`).
Pour changer de clé sans casser les installations existantes :

1. une version signée avec l'ancienne clé ajoute la nouvelle à la liste ;
2. une fois cette version déployée, les suivantes sont signées avec la nouvelle clé ;
3. l'ancienne clé est retirée plus tard.

Un `keyId` absent de la liste est refusé : c'est l'état « clé inconnue ». À ce
jour, la liste ne contient que la clé `k1`.

### Désactiver les mises à jour

Variable d'environnement `ELIUM_NO_UPDATE=1` : plus aucune vérification, plus
aucun téléchargement. Le journal est dans `%LOCALAPPDATA%\Elium\update.log`.

### Pour les mainteneurs

Le modèle est « push = publication » : un push sur `master` publie une release si
la version a été augmentée et que la CI est verte. Le job qui possède la clé
privée est le seul à signer. Les détails (workflow, SBOM, attestation de
provenance) sont dans la section « Contribution et développement ». La mise à jour
automatique du **serveur Drive** (`install.sh auto-update`) est décrite dans
« Exploitation du Drive (VPS) ».

### Limites connues des mises à jour

- Les vérifications utilisent l'API publique GitHub sans authentification : elle est limitée à 60 requêtes par heure et par adresse IP. Elium s'espace tout seul.
- Le dépôt doit être public : sinon les fichiers des releases ne sont pas téléchargeables.
- Les exécutables ne sont pas signés Authenticode. Seul le contrôle Ed25519 d'Elium garantit leur intégrité.
- Impossible de redescendre sous la version de l'installeur sans réinstaller.
- Aucun détecteur de mise à jour n'existe dans la version web : le navigateur décide.
