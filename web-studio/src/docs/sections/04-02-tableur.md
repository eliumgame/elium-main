### Tableur

Le Tableur enregistre en `.elium`. Il importe et exporte **XLSX**, importe et
exporte **CSV**. Chaque classeur est un élément de la bibliothèque, enregistré
automatiquement.

### Formules

107 fonctions sont reconnues : maths, statistiques, recherche, logique, texte,
dates, finance (PMT, NPV, IRR) et tableaux. Les références vers d'autres feuilles
et les opérateurs `&`, `^`, `%` sont pris en charge.

#### Tableaux dynamiques

Une formule peut **déborder** sur les cellules voisines. Si une cellule voisine
est occupée, le résultat est `#SPILL!`. L'opérateur `A1#` désigne tout le
résultat débordé.

| Famille | Fonctions |
|---|---|
| Génération | SEQUENCE, RANDARRAY |
| Tri et filtre | UNIQUE, SORT, SORTBY, FILTER |
| Forme | TRANSPOSE, TAKE, DROP, CHOOSECOLS, CHOOSEROWS, EXPAND, TOCOL, TOROW, WRAPROWS, WRAPCOLS |
| Assemblage | VSTACK, HSTACK, TEXTSPLIT, MMULT |
| Calcul par tableau | LET, LAMBDA, MAP, REDUCE, SCAN, BYROW, BYCOL, MAKEARRAY |

Une fonction ordinaire appliquée à une plage se propage sur le résultat. Un
tableau est limité à 1 000 000 de cellules, sinon `#NUM`.

### Graphiques du classeur

Ruban : « Insérer un graphique (depuis la sélection) ».

| Réglage | Options |
|---|---|
| Types | Barres, Lignes, Aires, Nuage de points, Secteurs, Combiné (barres et courbes) |
| Groupement | Groupé, Empilé, Empilé 100 % |
| Axes | Barres horizontales, titres des axes, minimum et maximum de Y, format (standard, entier, 2 décimales, pourcentage, monétaire €) |
| Éléments | Titre, légende (automatique, aucune, haut, bas, droite), étiquettes de données, courbes lissées |
| Tendance | Linéaire, polynomiale (ordre 2 à 6), moyenne mobile |
| Combiné | Axe secondaire et son titre |

### Tables nommées et plages nommées

- **Tableaux nommés** : « Outils de données », onglet « Tableaux nommés », « Créer un tableau depuis la sélection ». La première ligne devient l'en-tête. Références `Tableau1[Col]`, `[@Col]`, `[#All]`. Ils sont exportés et importés en XLSX.
- **Plages nommées** : fenêtre « Plages nommées », dans le groupe « Règles avancées » du ruban.

### Tableau croisé dynamique persistant

Le bouton « Tableau croisé dynamique » crée une feuille « TCD » qui **garde sa
définition**. Un volet permet de la modifier : lignes, regroupement des dates
(année, trimestre, mois, jour), colonnes, valeurs, agrégation (somme, nombre,
moyenne, minimum, maximum), tri, champs calculés comme `[Ventes]-[Coûts]`.

L'actualisation est **manuelle** : si la source change, le volet indique « La
source a changé depuis le dernier calcul. » ; cliquez sur **Actualiser**. Un seul
champ de valeurs, un champ en lignes, un en colonnes.

### Mise en forme conditionnelle et validation

- **Règles** : supérieur, inférieur, égal, différent, compris entre, texte contenant, vide, non vide, échelle de couleurs (2 ou 3 couleurs), 10 premières valeurs, doublons. Styles : remplissage, texte, gras. Pas de barres de données ni de jeux d'icônes.
- **Validation** : liste déroulante (valeurs saisies ou plage), nombre, longueur du texte, date. La validation est **souple** : elle signale une valeur invalide mais ne l'interdit pas.

### Outils de données

« Outils de données » regroupe : Rechercher et remplacer (expressions
régulières, casse, cellule entière, formules, toutes les feuilles), Supprimer les
doublons, Texte en colonnes, Tableaux nommés.

### Impression

« Mise en page et impression » : papier (A4, A3, A5, Letter, Legal), orientation,
mise à l'échelle (largeur d'une page ou 10 à 400 %), marges, en-tête et pied de
page (`{feuille}`, `{date}`, `{page}`, `{pages}`), quadrillage, numéros de ligne
et lettres de colonne, ordre des pages. Aussi : zone d'impression, lignes et
colonnes à répéter, sauts de page, aperçu des sauts. « Exporter en PDF » produit
un PDF page par page, avec une couche de texte. La mise en page est lue et
écrite dans le XLSX.

### XLSX et CSV

| Format | Conservé | Perdu |
|---|---|---|
| XLSX, export | Valeurs, formules, styles, fusions, mises en forme conditionnelles, validations, tailles, volets figés, filtre simple, notes, graphiques, tableaux nommés, noms définis, mise en page | La définition du tableau croisé (exporté en valeurs), les débordements natifs |
| XLSX, import | Idem, plus formules partagées, dates 1904 | Tableaux croisés Excel, images, formules matricielles `t="array"` |
| CSV, import | Séparateur virgule, point-virgule ou tabulation détecté ; feuille « Importé » ; tout reste en texte | Types |
| CSV, export | Valeurs **affichées** de la feuille active, lignes visibles | Formules, autres feuilles |

### Taille et fluidité

La grille est **virtualisée par lignes** : seules les lignes visibles sont
dessinées. Il n'y a pas de plafond de lignes dans Elium. Les colonnes ne sont pas
virtualisées. Un classeur neuf est dimensionné selon l'écran ; les boutons
« Ajouter des lignes » (+10) et « Ajouter des colonnes » (+4) l'agrandissent. Pour
le XLSX, une cellule de texte est limitée à 32 767 caractères et une formule à
8 192.

### Raccourcis

| Raccourci | Action |
|---|---|
| Flèches, Tab, Entrée | Se déplacer (Maj étend la sélection) |
| F2 | Modifier la cellule |
| Suppr, Retour arrière | Effacer |
| Début, Ctrl+Début, Fin, Ctrl+Fin | Début de ligne, A1, fin de ligne, dernière cellule |
| Page haut, Page bas | Défilement |
| Ctrl+C, Ctrl+X | Copier, couper |
| Ctrl+Z, Ctrl+Y | Annuler, rétablir |
| Échap | Annuler la saisie |

Le gras et l'italique passent par le ruban.

### Limites connues du Tableur

- Pas de macros.
- Pas de barres de données ni de jeux d'icônes.
- Un seul critère « contient » par filtre de colonne.
- Tableau croisé : un champ de valeurs, actualisation manuelle, exporté en valeurs.
- Les tableaux croisés Excel, les images et les formules matricielles ne sont pas lus à l'import XLSX.
- L'export CSV ne garde que les valeurs affichées de la feuille active.
- Les colonnes ne sont pas virtualisées.
- La fonction SWITCH est reconnue à l'import XLSX mais n'est pas calculée.
