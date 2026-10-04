### Documents (éditeur de texte riche)

Moteur **TipTap v3 / ProseMirror**. Titres, listes (puces/numérotées/tâches),
citations, blocs de code coloriés (`lowlight`), tableaux, images avec habillage
(`float`) et redimensionnement, alignements, surlignage, interligne, indentation,
table des matières automatique, commentaires, notes de bas de page, signets,
styles de paragraphe nommés, **suivi des modifications** (mode suggestion,
insertions/suppressions attribuées). Recherche/remplacement complet (regex, casse,
tout remplacer). **Import/export DOCX sans dépendance**. Export HTML/Markdown/PDF.
Modèle de page (A4/Letter, marges, en-tête/pied, numérotation) appliqué à l'écran,
à l'impression et au DOCX.

**Pagination écran réelle** : feuilles A4/Letter empilées, sauts de page
automatiques, numéro de page en direct (`editor/Pagination.ts`, moteur pur
`planPages`), portée aussi sur l'éditeur collaboratif Drive.

**Mise en forme complète** — côté caractère : exposant, indice, petites
majuscules, majuscules, soulignements (simple/double/pointillé/tirets/ondulé),
barré double, espacement des caractères, position surélevée/abaissée, casse
(5 modes), effacer la mise en forme, agrandir/réduire — dans un **dialogue Police**
à aperçu vivant. Côté paragraphe : espacement avant/après, retraits de première
ligne et négatif, **enchaînements** (paragraphes solidaires, lignes solidaires,
saut de page avant — réellement honorés par la pagination écran), bordures par
côté et trame de fond — dans un **dialogue Paragraphe**.

**Polices embarquées** : le binaire `.ttf/.otf/.woff/.woff2` voyage dans le
`.elium` (ressource adressée par contenu, donc couverte par le sceau et chiffrée
avec le document) et est réenregistré à l'ouverture ; export en `@font-face`
data-URL (HTML/PDF) et en `fontTable.xml` + parts `.odttf` (DOCX). **Zoom** :
paliers 50–200 %, largeur de page, page entière, curseur en barre d'état,
Ctrl+molette, ajustement automatique sur écran étroit. **Formats de page** : A3,
A4, A5, A6, B5, Letter, Legal, Executive, Tabloid et personnalisé (mm), avec
**géométrie par section à l'écran** (une section paysage ou A5 est dessinée à sa
propre taille, casse à sa propre hauteur, peut recommencer la numérotation).

**Parité Word** — ruban à 7 onglets (Accueil, Insertion, Mise en page, Références,
Publipostage, Révision, Affichage), qui se compacte automatiquement sur petit
écran (masque d'abord les libellés de groupe, puis les groupes optionnels).
Chaque chantier s'appuie sur un module pur
testé et exporte des constructions Word *natives* (des champs que Word met à jour
lui-même) :

- **Listes multiniveaux** (`editor/listSchemes.ts`) : 7 schémas de numérotation
  (`1./1.1/1.1.1`, `1./a./i.`, `I./A./1.`, juridique `Article I. / Section 1.01 /
  (a)`, `Chapitre 1/1.1/a)`, deux jeux de puces). Une seule table de données
  pilote l'écran (compteurs CSS), l'export Markdown/texte et le DOCX (vrais
  niveaux `numbering.xml`, `w:isLgl` pour le juridique). Le `w:ilvl` suit
  l'imbrication ; l'import reconstruit l'arbre imbriqué depuis les paragraphes
  plats de Word (`ListBuilder`, `matchSchemeId`).
- **Colonnes et sauts de section** (`editor/sections.ts`) : colonnes réelles (CSS
  multi-colonnes à l'écran/impression et `w:cols` DOCX) et `sectionBreak` portant
  orientation, en-tête/pied et reprise de numérotation. Modèle OOXML respecté
  (`w:sectPr` décrit la section qu'il *termine* ; la section après un bloc de
  colonnes reste `continuous` pour éviter un saut de page fantôme).
- **Renvois** (`editor/crossref.ts`) : nœud `crossReference` qui recalcule son
  texte à chaque rendu (jamais périmé). Cinq modes (texte, numéro, page,
  ci-dessus/ci-dessous, texte + page). Export en champs `REF`/`PAGEREF` +
  `bookmarkStart`/`bookmarkEnd`, réimport des commutateurs `\p`/`\n`.
- **Index** (`editor/indexing.ts`) : marques d'entrée (terme + sous-entrée) et
  bloc `indexBlock` reconstruit en direct (regroupement par initiale, tri
  français, pages dédoublonnées). Export en champs `XE` réels.
- **Comparaison de documents** (`editor/compare.ts`) : diff bloc (LCS) puis
  affinage au mot préservant les marques ; le résultat atterrit dans le flux de
  révision (accepter/refuser). Compare `.elium`, `.docx`, `.md`, `.txt`, `.html`.
- **Publipostage** (`editor/mailmerge.ts`) : analyse CSV/TSV conforme RFC 4180,
  nœud `mergeField`, aperçu enregistrement par enregistrement, fusion vers un
  document unique. Export en champs `MERGEFIELD`.
- **Légendes** (`editor/captions.ts`) : nœud `caption` (préfixe « Figure 3 — »
  recalculé, jamais périmé), numérotation par étiquette, `tableOfFigures`
  reconstruit à chaque édition. Export en champs `SEQ` et `TOC \c`.
- **Notes** (`editor/notes.ts`, `format/docx-notes.ts`) : notes de bas de page
  (chiffres arabes) et notes de fin (romains minuscules, comme Word), issues d'une
  seule fabrique, conversion d'une famille à l'autre. Export en **vraies** parties
  `footnotes.xml`/`endnotes.xml` avec leurs références et styles.
- **Taquets et règle** (`editor/tabs.ts`, `editor/Ruler.tsx`) : la tabulation est
  un nœud en ligne mesurant sa propre position (les 5 alignements Word, points de
  conduite). Positions quantifiées au dixième de mm (les taquets OOXML sont en
  twips, pour éviter la dérive aller-retour). Règle interactive hors de la zone de
  défilement (clic = pose, glisser = déplace, double-clic = retire).
- **Ornements** (`editor/ornaments.ts`) : catalogue de **symboles** (7 groupes),
  **lettrine** (attribut de paragraphe via `::first-letter`), **filigrane** (fond
  de feuille + forme VML dans une partie d'en-tête pour Word).
- **Styles de tableau** (`editor/tableStyles.ts`) : règles (première ligne
  accentuée, tramage alterné) recalculées depuis la position (décorations, non
  stockées par cellule) ; tri de colonne numérique/stable (formats français
  « 1 234,50 », « 12,5 % » lus).
- **Correcteur** (`editor/proofing.ts`) : l'orthographe est confiée au correcteur
  **natif** du navigateur (`spellcheck` + `lang="fr"`) ; Elium prend la typographie
  française (fine insécable avant `; : ! ?`), les répétitions, la capitale de début
  de phrase, les guillemets, un dictionnaire personnel et une liste à ignorer.
  Détection de mots inconnus désactivée sans dictionnaire (import d'une liste ou
  d'un `.dic` Hunspell, suggestions par distance de Levenshtein bornée à 2).
- **Zones de texte / formes** (`editor/textBoxExtension.ts`, `shapeExtension.ts`)
  et **quadrillage** (`gridBackground` + `GridModal`) : livrés.

**Fidélité d'import DOCX** : au-delà du `rPr` en ligne, le lecteur résout la mise
en forme portée par `styles.xml` (`docDefaults`, styles de paragraphe et de
caractère, héritage `w:basedOn`) — couleur, police, taille et surlignage sont
restitués et **persistés dans le `.elium`**.

Toutes ces extensions étant partagées (`buildExtensions`), elles existent aussi
dans l'éditeur **collaboratif** Drive (listes multiniveaux, colonnes, sauts de
section, renvois, index, légendes, notes de fin, conversion des notes). Comparaison
et publipostage restent sur la surface locale (ils produisent un nouveau document
à partir de fichiers, ce qui n'a pas de sens dans un document partagé en direct).
