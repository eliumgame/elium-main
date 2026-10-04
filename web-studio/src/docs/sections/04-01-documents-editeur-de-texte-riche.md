### Documents (éditeur de texte riche)

Le module Documents est un traitement de texte. Il enregistre en `.elium` et
importe `.elium`, `.docx`, `.txt`, `.md`, `.html`.

### Ruban et édition

Le ruban a sept onglets : **Accueil, Insertion, Mise en page, Références,
Publipostage, Révision, Affichage**. Il se compacte seul sur un petit écran.

- Mise en forme des caractères et des paragraphes, styles nommés, listes multiniveaux, tableaux, images, formes, zones de texte, équations, symboles.
- Colonnes et sauts de section, en-têtes et pieds de page, numérotation.
- Table des matières, notes de bas de page et de fin, renvois, index, légendes, signets.
- Recherche et remplacement (Ctrl+F, Ctrl+H), zoom (Ctrl+molette), règle et taquets.
- Pagination réelle à l'écran, formats A3 à Tabloid et format personnalisé.

| Raccourci | Action |
|---|---|
| Ctrl+Maj+M | Activer ou désactiver le suivi des modifications |
| Ctrl+F, Ctrl+H | Rechercher, remplacer |
| Ctrl+= | Indice |
| Ctrl+Maj+= | Exposant |
| Ctrl+Maj+K | Petites majuscules |
| Ctrl+Maj+> et Ctrl+Maj+< | Agrandir, réduire la police |
| Ctrl+Espace | Effacer la mise en forme |
| Tab, Maj+Tab | Retrait, retrait négatif |

### Modèles de documents

L'accueil propose une section **Modèles de documents** : 13 modèles, onglets
Tous, Général, Courrier, Professionnel, Réunion, Finance. Un clic crée un
document. Les modèles sont : Document vierge, Contrat, Attestation, Rapport,
Facture, Courrier, Fiche technique, CV, Lettre de motivation, Compte rendu de
réunion, Mémo, Procès-verbal, Devis. Seuls le Compte rendu et le Procès-verbal
ont une mise en page propre (en-tête ou pied, numéros de page).

### Graphiques dans un document

**Insertion, Éléments** : le bouton « Insérer un graphique ». Un clic sur un
graphique existant le rouvre (« Modifier le graphique »).

- Types : barres, courbes, secteurs, aires, nuage de points, combiné.
- Options communes avec le Tableur : groupées, empilées, 100 %, barres horizontales, légende, étiquettes, titres d'axes, bornes, format, courbe de tendance, axe secondaire, lissage, couleurs.
- Données saisies dans une grille, ou **collées** depuis un tableur (texte séparé par des tabulations : première ligne = séries, première colonne = libellés).
- Export : vrai graphique Word (`c:chart`) dans le DOCX ; image SVG en HTML et PDF ; tableau de valeurs en Markdown et texte.

### Citations et bibliographie

**Insertion** : « Sources, citations et bibliographie ». Styles : APA (7e éd.),
MLA, ISO 690 (auteur-date). Types de source : livre, article de revue, chapitre,
site web, rapport, thèse ou mémoire. Boutons : Nouvelle source, Insérer la
citation (page facultative), Insérer la bibliographie, Mettre à jour tout.

La bibliothèque de sources est stockée dans le navigateur de l'application
(`localStorage`). Elle est locale à cet appareil et non synchronisée. Dans le
DOCX, une citation devient son texte figé, sans champ Word.

### Vérificateur d'accessibilité

**Révision, Correction, Accessibilité.** Le volet **signale** les problèmes ;
il ne corrige rien. Cliquez sur une ligne pour aller à l'élément. Il se met à
jour à chaque modification.

| Contrôle | Gravité |
|---|---|
| Texte alternatif manquant (images) | Erreur |
| Titre vide | Erreur |
| Tableau sans ligne d'en-tête | Erreur |
| Ordre des titres (saut de niveau) | Avertissement |
| Aucun titre de niveau 1 | Avertissement |
| Contraste insuffisant (seuil 4,5:1 sur fond blanc) | Avertissement |
| Lien peu explicite (« cliquez ici », adresse très longue) | Avertissement |
| Trois paragraphes vides ou plus à la suite | Avertissement |

### Apparence de la page

**Mise en page, Mise en page, Apparence de la page.**

| Réglage | Options |
|---|---|
| Couleur de fond | Une couleur unie (pas d'image) |
| Bordure de page | Plein, double, tirets, pointillés ; 0,25 à 12 pt ; distance 2 à 30 mm ; quatre côtés identiques |
| Numéros de ligne | Continue ou redémarrée à chaque page ; un numéro toutes les 1 à 100 lignes |
| Filigrane | **Insertion, Ornements, Filigrane** : texte seul, préréglages (BROUILLON, CONFIDENTIEL, NE PAS COPIER, URGENT, ÉCHANTILLON, ORIGINAL), angle, opacité, couleur, taille |

### Révision

- **Suivi des modifications** : mode suggestion, accepter ou refuser tout.
- **Commentaires** : réponses, « Marquer comme résolu », « Rouvrir », « Aller au passage ».
- **Comparer** deux documents : le résultat entre dans le flux de révision.
- **Publipostage** : source CSV ou TSV, champs de fusion, aperçu, fusion.
- **Statistiques**, volet **Plan**, inspecteur.

### Correcteur

**Révision, Correction, Correcteur.** Deux dictionnaires sont embarqués et
marchent hors ligne : **français** et **anglais**. En mode prudent (défaut), un
mot inconnu n'est signalé que si une correction plausible existe.

Signalements : mot répété, espace en double, espace avant ou après la
ponctuation, capitale manquante, mot inconnu, guillemet non fermé. Vous pouvez
importer une liste de mots ou un fichier `.dic`, tenir un dictionnaire personnel
et activer le correcteur du navigateur en plus. Il n'y a **pas** de vraie
grammaire (accords, conjugaison).

### Import et export

Panneau **Exporter** : PDF (impression), HTML, Word (.docx), Markdown, texte
brut, rapport de preuve (JSON), et « Enregistrer le document .elium ».

| DOCX à l'export | Conservé |
|---|---|
| Texte, styles, listes, tableaux, images | Oui |
| Commentaires racine, suivi des modifications | Oui |
| Notes de bas de page et de fin | Oui, en vraies parties Word |
| Polices incorporées | Oui |
| Champs REF, PAGEREF, XE, MERGEFIELD, SEQ, TOC | Oui |
| Graphiques, formes, zones de texte, colonnes, sections, en-têtes, pieds | Oui |
| Filigrane, fond, bordure, numéros de ligne | Oui |
| Réponses aux commentaires, état « résolu » | **Non** |
| Citations | Texte figé |

À l'import d'un `.docx`, les champs REF, PAGEREF, MERGEFIELD et XE sont
reconnus. Les contrôles de contenu Word sont aplatis en texte.

Le **PDF** est produit par l'impression du navigateur : autorisez la fenêtre
d'impression. Il inclut la page « Signatures », le filigrane et les polices.

### Limites connues des Documents

- Le fond de page, la bordure de page et les numéros de ligne ne sont **pas** appliqués dans l'export PDF et HTML. Ils le sont dans le DOCX.
- Le DOCX perd les réponses aux commentaires et leur état « résolu ».
- Les notes de bas de page et les polices incorporées d'un `.docx` ne sont pas relues à l'import (non confirmé : à tester sur vos fichiers).
- Pas de champs CITATION ou BIBLIOGRAPHY de Word.
- Filigrane en texte seulement ; bordure de page identique sur les quatre côtés ; pas de redémarrage des numéros de ligne par section.
- Le vérificateur d'accessibilité ne corrige pas et ne contrôle pas le titre du document.
- Pas de contrôle grammatical.
