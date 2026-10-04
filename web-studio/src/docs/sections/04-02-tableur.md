### 4.2 Tableur

Moteur de formules `tokenize → parse (AST) → evaluate`, **~59 fonctions**,
`IFERROR`/`IFNA`, références absolues `$A$1` et **inter-feuilles** `Feuille2!A1`
(renommage propagé, détection de cycle). Poignée de remplissage (séries), tri non
destructif, undo/redo. **Import ET export XLSX + CSV** : l'export
(`sheet/xlsx-export.ts`) produit un paquet OPC valide (valeurs, chaînes, formules
`<f>` avec `fullCalcOnLoad`, formats de nombre et styles), round-trip testé.

Un classeur **neuf** se dimensionne automatiquement à la taille de l'écran
(colonnes/lignes calculées depuis la fenêtre, dans des bornes raisonnables)
plutôt que sur une grille fixe. Comme les autres éditeurs, le ruban se compacte
aussi automatiquement sur petit écran (masque d'abord les libellés de groupe,
puis les groupes optionnels).

Fonctionnalités livrées (chacune sur un module pur testé + vérification navigateur) :

- **Graphiques** (barres/lignes/secteurs).
- **Mise en forme conditionnelle** (seuils, plages, échelles de couleur).
- **AutoFilter réel** (`sheet/filter.ts`) : tri, copie et export CSV ne considèrent
  que les lignes visibles.
- **Validation de données** (`sheet/validation.ts`) : règles par plage (liste
  déroulante, nombre, longueur de texte, date), validation *souple* (cellule
  invalide marquée en rouge, jamais refusée), UI `ValidationModal`.
- **Plages nommées** (`formula.ts` `applyNamedRanges`) : `SALAIRES` →
  `'Feuille 1'!$A$1:$A$3`, employable dans `=SUM(SALAIRES)`.
- **Fusion de cellules** (`sheet/merges.ts`) : `colSpan`/`rowSpan`, bascule
  fusionner/annuler.
- **Tableaux croisés dynamiques** (`sheet/pivot.ts`) : regroupement par champ en
  lignes + champ optionnel en colonnes, agrégation somme/nombre/moyenne/min/max
  avec totaux, écrit dans une nouvelle feuille (`PivotModal`).

**Parité dual-plateforme** : le Tableur **collaboratif** (Drive) est à parité
plein-modèle (`drive-cloud/collab-sheet-model.ts` : pivot, fusions, filtre, mise
en forme conditionnelle, validation, plages nommées, graphiques) et exporte aussi
en XLSX via un pont pur (`drive-cloud/collab-sheet-export.ts` → `Workbook` →
`workbookToXlsx`). Chaque cellule collaborative est un **`Y.Text`**
(`collab-sheet-crdt.ts`) : deux personnes tapant à des endroits différents de la
même cellule fusionnent au caractère près (migration idempotente des anciens
documents à chaînes ; `observeDeep` requis). Hors périmètre : macros.
