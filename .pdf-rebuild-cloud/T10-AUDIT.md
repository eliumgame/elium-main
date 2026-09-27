# T10 — audit de l'interface PDF face à Acrobat Pro (agent, 26/09/2026)

Captures et notes : scratchpad/a10/ (cloud, éphémère). Spec jetable : web-studio/tests/zz-audit10-pdf-ui.spec.ts.

## Constats principaux
- Pas de « Tous les outils », pas de recherche de commandes, pas d'outils rapides, aucun menu contextuel
  (clic droit = menu du navigateur dans Edge --app).
- Regroupements : « Comparer et alléger » mélange Accessibilité/PDF/A/Optimiser ; Caviarder dans Protéger ;
  bascule JavaScript dans Protéger (préférence) ; Assainir/Inspecter mal rangés ; doublons (Combiner, Diviser,
  Surligner, Note, Calques, Machine à écrire).
- Collisions de libellés : « Signer » (manuscrite vs PAdES), « Rechercher » (caviardage), « Remplacer »,
  « Texte » (export vs champ), « Exporter »/« FDF »/« Exporter FDF ».
- Morts / cachés : grille-magnétisme (showGrid sans bouton), page de couverture (spreadCover),
  historique de vue sans bouton, F3 sans indice, raccourcis à une touche absents des infobulles.
- BUG : l'Inspecteur ne peut plus être rouvert une fois fermé (PdfWorkspace setInspector(false) seul setter).
- Ruban : débordement sans chevrons ni menu « Plus » (Formulaires à 1366 px, Commenter/Formulaires à 1024) ;
  libellés sur deux lignes qui chevauchent le titre de groupe ; titres de groupes à deux hauteurs.
- ≤ 900 px : panneau latéral et Inspecteur couvrent la barre supérieure et les onglets.
- Écran d'accueil : boutons sans padding (eb sans eb--md), boutons contour blancs en thème clair,
  pas de PDF récents, pas de PDF vierge, nom de brouillon tronqué.
- Clavier : manquent Ctrl+3, Ctrl+D, Ctrl+K, Ctrl+E, Ctrl+H, Ctrl+L, Ctrl+N, Ctrl+W (ferme la fenêtre en --app !),
  F5 (recharge), Ctrl+Shift+R, Ctrl+Shift+I/D/T/E, F4, F6, Shift+F10, Espace maintenu = main.
  Ctrl+Shift+− ne fait rien (la touche arrive en « _ »). Flèches/Espace ne défilent pas tant que
  .pdfx-canvas n'a pas le focus. Raccourcis à une touche toujours actifs (Acrobat : désactivés par défaut).
- Accessibilité : 36 boutons icône nommés par title seul ; états bascule sans aria-pressed ;
  tablist sans tabpanel ni flèches ; ruban role=region pas toolbar ; document atteint au 58e Tab ;
  vignettes non focusables ; pas de lien d'évitement ; anneau de focus rgb(29,78,216) ≈ 2,4:1 sur fond sombre ;
  toasts sans role=status/aria-live, X sans nom, erreurs qui disparaissent en 5,2 s.
- Vue : zoom en <select> (pas de valeur saisie), pas de mode lecture, pas de 1re/dernière page,
  vignettes qui ne suivent pas la page courante, Organiser qui s'ouvre page 1.
- Barre d'état : manquent page courante, format de page, sélection, zoom cliquable, progression de recherche.
- Inspecteur : valeurs coupées à 1366, boutons de disposition sous le pied collant à 768 px de haut.
- Divers : récupération de brouillon en modale bloquante ; libellés d'erreur incohérents ;
  surlignages de recherche qui restent après Échap.
- Perf (500 pages) : bonne (1re page 1,55 s, défilement p95 33 ms) SAUF panneau Recherche non virtualisé :
  15 000 résultats → ouvrir Organiser prend 13,1 s (Sidebar.tsx ~1009-1022, findIndex par résultat).
  Recherche d'un terme rare : 2,26 s sans progression.

## Plan
P0 (correctifs rapides) : Inspecteur réouvrable (Ctrl+E, double-clic, bouton) ; chevrons + menu « Plus »
du ruban ; panneaux sous la barre à ≤ 900 px ; écran d'accueil (eb--md, surfaces, nom complet) ;
virtualiser les résultats de recherche ; toasts accessibles ; revendiquer Ctrl+W/D/H/L/F5, corriger
Ctrl+Shift+−, focus sur le document à l'ouverture.

P1 (nouvelle disposition, en gardant les id de commande et command(id)) :
- src/pdf/ui/commands.ts : registre unique {id, libellé Acrobat FR, famille, icône, raccourci, when, droit,
  kind, mots-clés} → ruban, « Tous les outils », palette, menus contextuels, table des raccourcis.
- AllTools.tsx « Tous les outils » : Modifier le PDF, Exporter un PDF, Créer un PDF, Combiner des fichiers,
  Organiser les pages, Commenter, Remplir et signer, Protéger, Caviarder, Préparer un formulaire,
  Numériser et OCR, Comparer des fichiers, Accessibilité, Normes PDF, Mesurer, Imprimer.
- Outils rapides épinglables (prefs) ; CommandPalette (Ctrl+Shift+P ou /) ; ContextMenu (page, sélection de
  texte, annotation, vignette, signet ; Shift+F10) ; barre d'état enrichie ; zoom en combobox ;
  mode lecture (Ctrl+H) ; plein écran page seule (Ctrl+L) ; grille/magnétisme et couverture ;
  vignettes qui suivent ; roving tabindex ; vignettes focusables ; lien « Aller au document » ;
  anneau de focus ≥ 3:1 ; préférence « Raccourcis à une touche ».

## Risques pour les specs existantes
Noms d'onglets (Organiser, Commenter, Formulaires, Convertir, Modifier, Protéger, Affichage) et de boutons
utilisés par tests/pdf-*.spec.ts : garder des alias ou migrer les specs dans le même changement.
La touche « r » (Rectangle) est utilisée par les specs : si les raccourcis à une touche deviennent optionnels,
les activer dans les specs.
