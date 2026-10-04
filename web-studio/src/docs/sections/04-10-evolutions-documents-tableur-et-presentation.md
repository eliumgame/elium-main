### 4.9 Évolutions Documents, Tableur et Présentations (phase E2)

Toutes ces fonctions existent **à l'identique dans la suite locale et dans le Drive collaboratif** (mêmes composants, mêmes codecs CRDT).

**Documents**
- **Galerie de modèles** : CV, lettre de motivation, rapport, facture, devis, compte rendu, mémo, procès-verbal… avec catégories, aperçu réel du contenu et mise en page propre au modèle (en-tête, pied de page, numéros). « Nouveau depuis un modèle » depuis l'accueil.
- **Graphiques insérables** (Insertion ▸ graphique) : grille de données modifiable, collage depuis le Tableur, mêmes types et options que le Tableur. Exportés en **vrais graphiques Word** (`c:chart`), en SVG dans l'HTML/PDF, relus à l'import DOCX.
- **Citations et bibliographie** (APA, MLA, ISO 690) : gestionnaire de sources, bibliothèque personnelle hors ligne, mise à jour des citations d'un clic (avec détection des citations périmées).
- **Vérificateur d'accessibilité** : textes alternatifs, ordre des titres, en-têtes de tableaux, contrastes (WCAG), liens peu explicites, paragraphes vides.
- **Apparence de la page** : couleur de fond, bordure de page, numérotation des lignes (continue ou par page) — écrits et relus dans le DOCX.
- **Fidélité DOCX « Word réel »** : styles de titres par nom/`outlineLvl`/héritage, listes définies par le style, fusions de cellules (colspan et rowspan), contrôles de contenu, `mc:AlternateContent`, réglages de page, en-têtes et pieds de page (import **et** export).

**Tableur**
- **Tableaux dynamiques** : débordement (`#SPILL!`), `LET`, `LAMBDA` (appel direct, via `LET`, fermetures), `MAP`, `REDUCE`, `SCAN`, `BYROW`, `BYCOL`, `MAKEARRAY`, `SEQUENCE`, `RANDARRAY`, `FILTER`, `SORT`, `SORTBY`, `UNIQUE`, `TEXTSPLIT`, `XMATCH`, `TAKE`, `DROP`, `VSTACK`, `HSTACK`, `WRAPROWS`, `CHOOSECOLS`… et les opérateurs `&`, `^`, `%`, `A1#`.
- **Graphiques riches** : barres/aires empilées ou 100 %, nuage de points, combiné avec axe secondaire, titres d'axes, bornes, format, légende, étiquettes, courbes de tendance (linéaire, polynomiale, moyenne mobile) ; export/import XLSX en DrawingML réel.
- **Tableaux nommés** et références structurées (`Tableau1[Col]`, `Tableau1[@Col]`, `[#All]`…), lignes alternées, parties `xl/tables` du XLSX.
- **Outils de données** : rechercher/remplacer (regex, toutes feuilles), suppression des doublons, texte en colonnes, listes de validation liées à une plage.
- **Tableau croisé dynamique persistant** : définition conservée sur la feuille de résultat, volet latéral, actualisation, regroupement de dates (année/trimestre/mois/jour), champs calculés.
- **Impression** : papier, orientation, marges, échelle ou ajustement à la largeur, zone d'impression, lignes/colonnes à répéter, sauts de page manuels, aperçu des sauts dans la grille, export PDF ; mise en page relue/écrite dans le XLSX.
- **Grille virtualisée** (100 000 lignes) avec `role="grid"` et navigation clavier ARIA (flèches, Début/Fin, Ctrl+Début/Fin, PageHaut/PageBas).
- **Fidélité XLSX « Excel réel »** : préfixes `_xlfn.`, booléens/erreurs typés, échappements `_xHHHH_`, noms définis locaux, dates 1904.

**Présentations**
- **Masque et dispositions** : polices, couleurs, pied de page, numéro ; espaces réservés positionnables ; choix de la disposition par diapositive, « Réinitialiser », propagation à toutes les diapositives ; exportés comme vrais masques/dispositions PowerPoint.
- **Trieuse** : glisser-déposer, sections repliables, diapositives masquées (sautées en diaporama), duplication.
- **Audio et vidéo** embarqués (lecture hors ligne en diaporama, rognage, lecture automatique, boucle) et exportés en parties média PPTX.
- **Diagrammes** de type SmartArt (processus, cycle, hiérarchie, liste) générés depuis un plan modifiable.
- **Tableaux** : fusion/séparation de cellules, styles (alternées, quadrillage, accentué), collage depuis le Tableur.
- **Documents (handouts)** 1/2/3/4/6/9 par page et **pages de notes** en PDF.
- **Fidélité PPTX « PowerPoint réel »** : placeholders hérités de la disposition et du masque, couleurs de thème, groupes, retrait automatique, puces à niveaux, notes, diapositives masquées.

**Limites connues** : l'export XLSX n'écrit pas encore les métadonnées « tableau dynamique » d'Excel (les formules débordantes s'ouvrent sans débordement natif) ni la définition du TCD persistant (le résultat est exporté en valeurs) ; la ligne de fusion d'une page imprimée coupée perd son étendue ; les diagrammes SmartArt PowerPoint ne sont pas relus (ils sont ignorés à l'import) ; le fond de page n'est pas appliqué dans l'export PDF.
