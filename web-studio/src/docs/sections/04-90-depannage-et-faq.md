## Dépannage et FAQ

Cette rubrique répond aux problèmes les plus fréquents de l'application de
bureau. En cas de doute, consultez d'abord le journal d'incidents (Réglages,
Confidentialité & données) et le journal des mises à jour
(`%LOCALAPPDATA%\Elium\update.log`).

### La mise à jour ne se propose pas

Vérifiez dans cet ordre.

1. **Hors ligne ?** Dans ce cas la carte reste cachée. Le pied de l'accueil dit « hors ligne, mise à jour non vérifiée ». Revenez en ligne, puis cliquez sur **Vérifier maintenant**.
2. **Quota atteint ?** « vérification suspendue (trop de requêtes) » : GitHub limite les vérifications anonymes à 60 par heure et par adresse IP. Attendez.
3. **Mauvais canal ?** Le canal **Stable** ignore les préversions. Pour les voir, passez en **Bêta** (Gérer les versions).
4. **Version en quarantaine ?** Une version dont le lanceur a planté au démarrage n'est plus proposée.
5. **Mises à jour désactivées ?** La variable `ELIUM_NO_UPDATE=1` coupe tout.
6. **Vous êtes dans un navigateur.** La version web se met à jour au rechargement ; le panneau le dit.
7. **Déjà à jour.** Une version déjà appliquée n'est jamais reproposée.

Elium revérifie toutes les 30 minutes et à chaque rechargement (au plus toutes les
5 minutes, plus espacé après des échecs). Si rien n'y fait : installez le paquet
`.eliumupdate` de la dernière version (**Mettre à jour depuis un fichier…**).

### « Signature invalide » ou « clé inconnue »

- **Invalide** : parfois transitoire juste après une publication. Elium refait jusqu'à trois essais. Si le message persiste, **n'insistez pas** : la mise à jour est refusée par sécurité. Installez la dernière version depuis la page officielle des releases.
- **Clé inconnue** : la version est signée par une clé que votre installation ne connaît pas. Réinstallez Elium depuis le site officiel.

### Le port est occupé

Elium choisit un port libre entre 3000 et 3100. Si votre port épinglé est
occupé au lancement, il en prend un autre pour cette fois et vous le dit dans
Réglages, Mises à jour & version.

Pour choisir vous-même : **Réglages, Mises à jour & version, Port de lancement**,
puis **Redémarrer maintenant**. Le port ne doit pas être utilisé par un autre
programme (un pare-feu d'entreprise peut n'autoriser qu'un port précis).

### Mes documents ont disparu après un redémarrage

Le navigateur de l'application range les données **par adresse**, port compris
(`127.0.0.1:3000` n'est pas `127.0.0.1:3001`). Si Elium a démarré sur un autre
port, il ouvre un espace vide. Relancez-le sur le premier port : fermez ce qui
occupait le port, ou épinglez le bon port dans les Réglages.

> Cette explication vient du fonctionnement standard des navigateurs : elle n'a
> pas été testée avec Elium dans tous les cas.

Autres causes : vous avez effacé les données locales ; vous avez supprimé le dossier
`%LOCALAPPDATA%\Elium\WebProfile`. Cherchez aussi dans la **corbeille** de
l'application (30 jours) et dans l'écran de **récupération** après un arrêt anormal.

### Une police est absente ou change à l'ouverture

- Un `.elium` incorpore les polices **importées** que le document utilise : elles reviennent seules à l'ouverture dans Elium.
- Les familles système (Verdana, Garamond…) ne sont pas incorporées. Sans la police, un équivalent proche s'affiche. Pour Arial, Calibri, Times New Roman, Cambria, Courier New et Georgia, un substitut de même métrique est fourni : la mise en page ne bouge pas.
- Importez la police : Réglages, Polices, Gérer les polices… (fichier, polices installées sur l'ordinateur, ou catalogue en ligne).
- Le bouton « Polices installées sur l'ordinateur… » n'existe pas dans tous les navigateurs.
- Le catalogue en ligne échoue hors connexion. Il demande aussi une version du lanceur qui contient le relais de polices : mettez Elium à jour.

### Clé perdue, mot de passe perdu

- **Identité de signature perdue** : si vous n'avez pas de sauvegarde `.eliumkey` et que le stockage a été effacé, la clé est perdue pour toujours. Générez-en une nouvelle ; les anciennes signatures restent valides mais vous ne pouvez plus signer avec l'ancienne identité. Sauvegardez la nouvelle (Réglages, Sécurité & clés).
- **Mot de passe d'un document** : il n'est pas récupérable. Le chiffrement est conçu ainsi.
- **Mot de passe du coffre local** : irrécupérable. Le réinitialiser supprime les contenus qu'il protège.
- **Mot de passe d'une archive `.elium-workspace`** : irrécupérable.
- **Drive d'entreprise** : le recouvrement par l'organisation est décrit dans les sections consacrées au Drive.

### La fenêtre ne s'ouvre pas comme attendu

- Elium s'ouvre dans un **onglet** du navigateur par défaut : ni Microsoft Edge ni Google Chrome n'a été trouvé. Installez l'un des deux.
- **Rien ne se passe au double-clic** sur un `.elium` : l'exe autonome n'associe pas les fichiers. Utilisez un MSI, ou « Ouvrir… » dans Elium.
- **Deux fenêtres** : le fichier dépassait 256 Mo ou l'instance ouverte n'a pas répondu en 5 secondes.
- **SmartScreen bloque le lancement** : « Informations complémentaires », puis « Exécuter quand même ». Les exécutables ne sont pas signés Authenticode.

### Fonctions qui ne marchent pas hors ligne

| Fonction | Pourquoi |
|---|---|
| Catalogue de polices en ligne | Demande Internet |
| Recherche de plagiat | Demande Internet et une clé API ; **bloquée dans l'application de bureau** par sa politique de sécurité |
| Mises à jour | Demandent Internet ; utilisez un `.eliumupdate` |
| Drive d'entreprise | Demande une connexion à votre serveur |
| Horodatage d'une signature PDF | Demande un serveur d'horodatage |

Tout le reste (édition, chiffrement, signature, OCR, recherche) marche sans réseau.

### « Serveur Drive injoignable »

Aucun serveur n'est configuré ou il ne répond pas. Carte Drive, bouton
**Serveur**, saisissez `https://votre-domaine/api`. L'application de bureau
n'embarque aucun serveur. Pour l'installer et le dépanner, voir « Exploitation du
Drive (VPS) ».

### Questions fréquentes

**Elium envoie-t-il mes documents quelque part ?** Non. Les seules sorties
possibles sont décrites dans la Vue d'ensemble.

**Puis-je utiliser Elium sans droits administrateur ?** Oui : le MSI « utilisateur »
ou l'exe autonome.

**Où est mon travail ?** Dans vos fichiers `.elium` et dans `%LOCALAPPDATA%\Elium\WebProfile`.
Exportez régulièrement avec la sauvegarde `.elium-workspace`.

**Comment signaler un bogue ?** Copiez le journal d'incidents (Réglages,
Confidentialité & données) après l'avoir relu, et le contenu de `update.log` s'il
s'agit d'une mise à jour.
