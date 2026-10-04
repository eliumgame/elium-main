### Présentations

Modèle **canvas libre** : chaque diapo est une liste d'éléments (texte riche /
forme / image) positionnés en %, avec **rotation, ordre de plan, opacité**.
Éditeur : sélection, déplacement, redimensionnement 8 poignées, rotation à la
poignée, **guides magnétiques**, 13 formes, alignement, dupliquer, undo/redo,
notes de l'orateur, vraies miniatures.

- **Animations par élément + déclencheurs** (`slides/playback.ts`) : au clic /
  avec la précédente / après la précédente (+ délai), rejouées en mode public ET
  présentateur.
- **Transitions** dont **Morph** = interpolation réelle par élément
  (position/taille/rotation/opacité).
- **Vraie vue présentateur** (2ᵉ écran) : popup synchronisée par `BroadcastChannel`
  (notes, minuteur, diapo suivante).
- **Multi-sélection + groupes** (`slides/selection.ts`) : Maj-clic, marquee,
  Ctrl+G/C/V/D/A, redimensionnement proportionnel (Maj sur poignée d'angle).
- **Import/export PPTX** : formes, texte, images, tableaux, groupes ; **graphiques
  natifs `<c:chart>`** (barres/lignes/secteurs) éditables à l'import ET à l'export.
- **Galerie de 12 modèles** (titre, sommaire, comparaison, chiffre clé, deux
  colonnes, étapes, citation, remerciements…).

**Parité collaborative** : l'éditeur unifié `SlidesEditor` est partagé
local/collaboratif — animations, mode présentateur, transitions et morph sont
rejoués comme en local. Les champs texte sont des **`Y.Text`**
(`collab-slides-crdt.ts`, `syncYText` applique un diff minimal) : deux personnes
qui tapent dans le même champ fusionnent au caractère près.
