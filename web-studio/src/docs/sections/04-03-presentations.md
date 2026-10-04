### Présentations

Le module Présentations enregistre en `.elium`, importe et exporte **PPTX**.
Chaque présentation est un élément de la bibliothèque, enregistré automatiquement.

### Masque et dispositions

Bouton **Masque** : fenêtre « Masque des diapositives ».

- **Thème** : polices des titres et du texte, couleurs (titres, texte, accent), arrière-plan, pied de page, numéros de diapositive.
- **Dispositions** : six par défaut (Diapositive de titre, Titre et contenu, En-tête de section, Deux contenus, Titre seul, Vierge). « + Disposition » en ajoute, « Supprimer » en retire.
- Les espaces réservés (titre, corps, pied, numéro) se règlent par **valeurs numériques** (X, Y, largeur, hauteur, taille, alignement), pas à la souris.
- « Rétablir le masque par défaut » et « Appliquer à toutes les diapositives ».
- Chaque diapositive choisit sa disposition.
- Le masque est exporté en vraies dispositions PowerPoint. Il n'y a qu'un seul masque.

### Trieuse et sections

**Trieuse de diapositives** : glisser-déposer des diapositives et des sections.

- « Commencer une section ici », renommer, réduire ou développer.
- « Supprimer la section » garde les diapositives.
- Masquer ou afficher une diapositive, dupliquer, supprimer.

### Audio et vidéo

Bouton **Média**. Vidéo : MP4, M4V, WebM, OGG, MOV. Audio : MP3, M4A, AAC, WAV,
OGG, FLAC. **Taille maximale : 40 Mo.** Le média est incorporé au fichier, donc
disponible hors-ligne. Options : début, fin, lecture automatique, boucle.

### SmartArt

Quatre types : **Processus, Cycle, Hiérarchie, Liste**. Vous saisissez un plan
indenté ; Elium génère le schéma. À l'export PPTX, ce sont des formes et
connecteurs modifiables : le plan n'est pas conservé hors du `.elium`.

### Animations et transitions

- **Animations** : effets d'entrée (fondu, glisser, zoom, voler, rotation). Déclenchement au clic, avec la précédente ou après la précédente.
- **Transitions** : aucune, fondu, glissement, zoom, morph. Une valeur par défaut pour la présentation, ajustable par diapositive.

### Mode présentateur

Bouton « Vue présentateur » : une fenêtre pour le deuxième écran, avec notes,
minuteur et aperçu. Suivant : flèche droite, Espace, Page bas. Précédent : flèche
gauche, Page haut. Échap quitte.

### Documents et notes imprimés

« Imprimer / exporter en PDF » : 1, 2, 3 (avec lignes de notes), 4, 6 ou 9
diapositives par page, ou « Pages de notes ». Options : orientation, diapositives
masquées, cadre, en-tête (`{titre}`, `{date}`), pied (`{page}`, `{pages}`). Format
A4 uniquement.

### Import et export PPTX

| Export PPTX | Import PPTX |
|---|---|
| Formes, texte riche, images, tableaux, notes, diapositives masquées | Disposition et masque hérités, couleurs du thème, groupes, tableaux, notes, diapositives masquées |
| Graphiques natifs : barres, courbe, camembert | Graphiques natifs |
| Masque et dispositions, médias, schémas en formes | Dégradés simplifiés, SmartArt et médias **ignorés** |

### Raccourcis de l'éditeur

| Raccourci | Action |
|---|---|
| Ctrl+Z, Ctrl+Y | Annuler, rétablir |
| Ctrl+C, Ctrl+X, Ctrl+V, Ctrl+D | Copier, couper, coller, dupliquer |
| Ctrl+A | Tout sélectionner |
| Ctrl+G, Ctrl+Maj+G | Grouper, dissocier |
| Suppr, Retour arrière | Supprimer |
| Tab | Élément suivant |
| Flèches | Déplacer de 1 % (Maj : 5 %) |
| Alt+flèches | Redimensionner |
| Entrée, F2 | Modifier le texte |

### Limites connues des Présentations

- Les **animations, transitions et sections** ne sont pas écrites dans le PPTX : elles sont perdues à l'export.
- Les graphiques exportés sont limités à barres, courbe et camembert.
- Les médias sont limités à 40 Mo et ne sont pas relus à l'import PPTX.
- Les SmartArt PowerPoint sont ignorés à l'import.
- Les animations sont des effets d'entrée uniquement.
- Aucun export d'images des diapositives : le PDF passe par l'impression.
- Les documents imprimés sont en A4 uniquement.
- Le masque se règle par champs numériques.
