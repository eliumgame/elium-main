### Polices

Elium propose les mêmes polices dans tous les modules : Documents, Tableur,
Présentations et PDF. Elles viennent de quatre sources.

| Source | Contenu | Hors-ligne |
|---|---|---|
| **Polices fournies** | 76 familles libres livrées avec l'application | Oui |
| **Familles système courantes** | Arial, Helvetica, Calibri, Verdana, Tahoma, Trebuchet MS, Comic Sans MS, Impact, Times New Roman, Georgia, Garamond, Cambria, Courier New | Oui |
| **Vos polices** | Fichiers `.ttf`, `.otf`, `.woff`, `.woff2` que vous importez, ou polices installées sur l'ordinateur | Oui, une fois importées |
| **Catalogue en ligne** | Familles libres de Fontsource, téléchargées à la demande | Non |

Ouvrez le gestionnaire par **Réglages, Polices, Gérer les polices…**.

### Polices fournies et substituts métriques

Sur un poste qui n'a pas Calibri ou Arial (Linux, macOS sans Office), la mise en
page ne doit pas bouger. Chaque police système est donc couplée à une police
fournie de **même métrique**, c'est-à-dire de mêmes largeurs de caractères.

| Police demandée | Substitut fourni |
|---|---|
| Arial, Helvetica | Arimo |
| Calibri | Carlito |
| Times New Roman | Tinos |
| Cambria | Caladea |
| Courier New | Cousine |
| Georgia | Gelasio |

Les six substituts font partie des 76 familles fournies. Ils ne sont pas listés à
part dans les sélecteurs, pour éviter les doublons. Les autres polices système
(Verdana, Tahoma, Garamond…) ont un équivalent proche, mais **pas de même métrique** :
le texte peut se placer légèrement autrement sans la police d'origine.

### Importer vos polices

1. Dans le gestionnaire, glissez des fichiers de police dans la zone, ou cliquez sur **Choisir des fichiers…**.
2. Elium contrôle la **signature interne** du fichier, pas son extension. Un fichier qui n'est pas une vraie police TTF, OTF, WOFF ou WOFF2 est refusé.
3. Taille maximale : **25 Mo** par fichier.
4. Un nom déjà pris par une police fournie reçoit le suffixe « (importée) ». Un même nom avec un contenu différent reçoit un numéro. Un doublon exact est ignoré.

Vos polices sont **conservées** dans l'application (base IndexedDB `elium-fonts`).
Elles reviennent à chaque lancement et apparaissent dans tous les sélecteurs.
« Mes polices » permet de les supprimer.

#### Polices et documents partagés

Quand un document utilise une de vos polices, ses octets sont **incorporés dans le
fichier `.elium`**, sous le sceau et chiffrés avec lui. Chez le destinataire, la
police est réenregistrée à l'ouverture : le texte s'affiche dans la bonne police
même s'il ne l'a pas.

> Vérifiez la **licence** de la police avant de partager. Elium incorpore la police
> seulement si le document l'utilise, mais ne contrôle pas les droits.

Dans les exports, une police importée est incorporée telle quelle. Pour les
annotations PDF, les polices fournies sont rapprochées de la famille standard la
plus proche (Helvetica, Times ou Courier).

### Polices installées sur l'ordinateur

Le bouton **Polices installées sur l'ordinateur…** n'apparaît que si le navigateur
intégré propose l'API d'accès aux polices locales (Chrome et Edge récents). Le
navigateur demande une autorisation. Cochez les polices voulues puis
**Importer N police(s)** : elles sont **copiées** dans Elium comme des fichiers
importés. Ensuite elles ne dépendent plus de l'ordinateur.

### Catalogue en ligne (optionnel)

**Télécharger en ligne…** ouvre le catalogue de **Fontsource** (polices libres, licences OFL ou
Apache). Elium reste entièrement utilisable sans ce catalogue.

1. Recherchez une famille, filtrez par catégorie.
2. Cliquez sur **Télécharger**. Elium récupère les graisses **normale et gras**, en droit et italique quand elles existent, en WOFF2, jeu de caractères latin.
3. La famille est ajoutée à « Mes polices ». Les familles déjà fournies portent l'étiquette « Déjà disponible ».

Le catalogue est mis en cache sept jours. Hors connexion, le cache reste
consultable (avertissement « Hors connexion »), mais les téléchargements échouent.

#### Comment la connexion est faite

La politique de sécurité de l'application de bureau interdit à l'interface tout
accès externe. Les téléchargements passent donc par le **relais du lanceur**
(`/__fetch_font__`), qui n'accepte qu'une liste d'adresses très stricte.

| Règle du relais | Valeur |
|---|---|
| Hôtes autorisés | `api.fontsource.org` (chemin `/v1/fonts`) et `cdn.jsdelivr.net` (chemin `/fontsource/fonts/`, fichiers de police seulement) |
| Protocole | HTTPS uniquement, sans identifiant, sans port, sans paramètre de requête |
| Redirections | Jamais suivies |
| Adresse visée | Doit être une adresse IP publique, vérifiée avant la connexion |
| Taille | 25 Mo maximum par fichier |
| Cadence | 40 requêtes par fenêtre de 10 secondes |
| Accès au relais | Jeton de session aléatoire, exigé à chaque appel |

**Confidentialité** : Elium n'envoie que les adresses des familles que vous
demandez. Les serveurs de Fontsource et de jsDelivr voient l'adresse IP de votre
connexion et ce que vous téléchargez, comme pour tout téléchargement web. Aucun
document, aucune donnée personnelle n'est transmis. Dans un navigateur ordinaire
(PWA), la connexion est directe vers les mêmes hôtes.

### Limites connues des polices

- Le catalogue en ligne ne propose que la graisse normale et le gras, en droit et italique. Les autres graisses ne sont pas téléchargées.
- Seul le jeu de caractères **latin** est récupéré (ou le jeu par défaut de la famille). Les alphabets non latins peuvent manquer.
- L'accès aux polices locales dépend du navigateur : absent de Firefox et Safari.
- Une police incorporée dans un `.elium` n'est réenregistrée que si le document est ouvert dans Elium.
- Elium ne vérifie pas la licence d'une police importée.
- Les familles système sans substitut de même métrique (Verdana, Tahoma, Garamond…) peuvent légèrement décaler la mise en page sur un autre poste.
