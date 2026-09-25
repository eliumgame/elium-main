# FINDINGS — domaine navigation (navigation, recherche, sélection de texte)
Dossier : HARNESS/diag/navigation. Serveurs : 3210 (CSP bureau), 3211 (sans CSP). lib.mjs = aides Playwright (openPdf avec réessais).

## navigation-01 — P1 — Tous les sauts (signets, n° de page, recherche, PgUp/PgDn, liens) atterrissent ~161 px trop bas : le titre visé est masqué
- repro : `node 07-navigation.mjs csp` (word-contrat.pdf, panneau Signets, clic sur chacun des 9 signets)
- preuve : offsetParent de [data-page="1"] = `.pdfx` (pas le conteneur `.pdfx-canvas`, position static) ; p1.offsetTop=183 alors que sa position réelle dans le défileur = 22. Pour les 9 signets : destination à -145 px du haut de la zone visible (visible:false x9).
- cause : PdfWorkspace.tsx:508-511 `goTo` calcule `el.offsetTop - 16 + y*scale` ; `.pdfx-canvas` (pdf.css:431) n'est pas positionné, donc offsetTop inclut la barre + le ruban (161 px). Même erreur dans onScroll (PdfWorkspace.tsx:521-526, milieu faux de 161 px -> page courante décalée).
- correction : `position: relative` sur `.pdfx-canvas` OU calculer `el.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop`.

## navigation-02 — P1 — PgDn/PgUp répétés rapidement perdent des pages (5 x PgDn depuis p2 -> p3 au lieu de p7)
- repro : `node 07-navigation.mjs csp` (word-250pages.pdf, 5 x PageDown à 60 ms)
- preuve : `PageDown x5 rapides depuis p2 -> champPage 3 (attendu 7)` ; `PageUp x3 rapides depuis p3 -> 2`.
- cause : PdfWorkspace.tsx:1706-1712 `goTo(view.current + 1)` ; goTo lance un scrollTo `smooth` (et pdf.css:436 `scroll-behavior: smooth`) puis onScroll (PdfWorkspace.tsx:519-531) réécrit view.current avec la page intermédiaire pendant l'animation -> l'appui suivant repart d'une page périmée.
- correction : garder une « page cible » (ref) pendant l'animation, ignorer onScroll tant qu'un saut programmatique est en cours ; saut instantané (behavior:auto) pour les touches ; en mode continu PgDn = un écran (comme Acrobat), flèche droite/Ctrl+PgDn = page suivante.

## navigation-03 — P1 — Champ « numéro de page » : impossible de taper un numéro à plusieurs chiffres ni de vider le champ
- repro : `node 07-navigation.mjs csp` (word-250pages.pdf : clic champ, Ctrl+A, taper 1-2-5 ; puis Retour arrière x3)
- preuve : valeurs successives du champ ["1","1","1"], page atteinte = 15 (attendu 125) ; après 3 x Retour arrière la valeur vaut "11" (champ non vidable).
- cause : PdfWorkspace.tsx:1950-1956 input contrôlé `value={view.current}` + `goTo(n)` à CHAQUE frappe ; onScroll réécrit view.current pendant le défilement animé, la frappe suivante s'ajoute à une valeur écrasée ; une valeur vide (n=0) est ignorée donc la valeur contrôlée revient.
- correction : état local de saisie (brouillon), navigation seulement sur Entrée/blur, accepter aussi les étiquettes de page (« iii », « A-1 ») comme Acrobat.

## navigation-04 — P2 — Pas d'historique de navigation (Alt+← / Alt+→ « Vue précédente/suivante »)
- repro : `node 07-navigation.mjs csp` (signet p1 puis signet Article 8, puis Alt+ArrowLeft)
- preuve : avant=6, après=6 (Acrobat revient à la p1).
- cause : aucune pile de vues dans PdfWorkspace.tsx (gestionnaire clavier 1618-1759 : pas d'Alt+flèches) ; aucun bouton Précédent/Suivant.
- correction : pile de vues {page, y, zoom} alimentée par goTo depuis signets/liens/recherche/champ page ; Alt+←/Alt+→ + boutons.

## navigation-05 — P2 — Pas de raccourci « Aller à la page » (Ctrl+Maj+N Acrobat, Ctrl+G) ; flèches sans effet tant qu'on n'a pas cliqué dans la page
- repro : `node 07-navigation.mjs csp`
- preuve : Ctrl+Maj+N et Ctrl+G : aucun dialogue, focus reste BODY ; ArrowDown x5 après ouverture : scrollDelta=0 (activeElement BODY).
- cause : PdfWorkspace.tsx:1618-1759 ne gère ni Ctrl+Maj+N/Ctrl+G ni les flèches ; le défileur `.pdfx-canvas` (tabIndex 0) n'est pas focalisé à l'ouverture.
- correction : focus du défileur à l'ouverture, flèches = défilement, Ctrl+Maj+N/Ctrl+G = focus + sélection du champ page.

## navigation-06 — P3 — Début/Fin : défilement animé de ~2 s sur 251 pages
- repro : `node 07-navigation.mjs csp` ; preuve : Fin 1992 ms, Début 2101 ms (Acrobat : instantané).
- cause : scrollTo({behavior:"smooth"}) PdfWorkspace.tsx:511 + `scroll-behavior: smooth` pdf.css:436.
- correction : behavior "auto" au-delà de ~2 écrans.

## navigation-07 — P0 — Sélection de texte à la souris inutilisable : le calque texte n'a pas la géométrie du texte affiché (0/8 cas réussis sous CSP)
- repro : `node 04-selection-copy.mjs csp` (word-contrat, edge-web) ; géométrie : `node 03-textlayer-geometry.mjs csp` ; sonde de pointage : `node 09-hittest.mjs csp`
- preuve (CSP 3210/3240, zoom par défaut 175 %) : glisser sur UNE ligne -> 1560 caractères copiés (tout le reste de la page) ; double-clic sur « capital » -> sélection vide ; 2 lignes -> 1739 car. ; ligne de tableau « Audit … 4 500,00 € » -> 1073 car. (tout le bas de page). Chaque <span> a `font-size: 13px; transform: none` alors que pdf.js a posé `--font-height: 12.00px; --scale-x: 0.9449` : largeur médiane span/texte réel = 0,642 (min 0,41) sur word-contrat p1. Preuve de cause : avec les règles CSS de pdf.js 6 injectées (`node 04-selection-copy.mjs nocsp fixbr`) 6/9 cas passent (ligne, Ctrl+C, double-clic, 2 lignes, colonnes edge-web, page tournée).
- cause : PageView.tsx:142-148 crée un `TextLayer` pdf.js 6 mais pdf.css:541-564 ne reprend PAS les règles de `pdf_viewer.css` : ni `--total-scale-factor`/`--text-scale-factor`/`--min-font-size`, ni `font-size: calc(var(--text-scale-factor) * var(--font-height))`, ni `transform: rotate(var(--rotate)) scaleX(var(--scale-x)) scale(var(--min-font-size-inv))`, ni `.markedContent {display:contents}`. PageView pose seulement `--scale-factor` (PageView.tsx:142), variable que pdf.js 6 n'utilise plus.
- correction : importer `pdfjs-dist/web/pdf_viewer.css` (partie .textLayer) ou recopier ses règles sur `.pdfx-textlayer`, poser `--total-scale-factor` = scale ; test de non-régression Playwright qui compare les boîtes des spans à `getTextContent()`.

## navigation-08 — P0 — Sur toute page contenant un lien, un calque transparent pleine page intercepte la souris : aucune sélection possible
- repro : `node 09-hittest.mjs csp` puis `node 04-selection-copy.mjs csp` (cas G, edge-web p1 qui contient 1 lien)
- preuve : edge-web p1 : 34/40 points visés sur du texte tombent sur `.pdfx-linklayer` (boîte 1042x1475 = page entière, pointer-events:auto, z-index 4, 1 seul lien) ; glisser sur 3 lignes de la colonne 1 -> sélection vide (len 0). Même effet pour les outils Surligner/Souligner qui partent d'une sélection.
- cause : PageView.tsx:233-263 rend `.pdfx-linklayer` et pdf.css:579-583 lui donne `position:absolute; inset:0; z-index:4` sans `pointer-events:none` (seuls les boutons `.pdfx-link` devraient capter la souris).
- correction : `.pdfx-linklayer{pointer-events:none}` `.pdfx-link{pointer-events:auto}` (vérifié dans fix-textlayer.css : cas G passe).

## navigation-09 — P1 — Texte copié : les lignes sont collées sans espace ni retour (« lePrestataire », « décritesà »)
- repro : `node 04-selection-copy.mjs nocsp fix` (règles pdf.js seules) vs `node 04-selection-copy.mjs nocsp fixbr` (+ `br{user-select:text}`)
- preuve : sous CSP, cas C : « …10 000 €, et lePrestataire. Les parties… », « décritesà l'annexe » ; cas E : « 4 500,00 €Développement 12 » ; avec `br{user-select:text}` : « et le\nPrestataire », « 4 500,00 €\nDéveloppement ».
- cause : pdf.css:562-564 `.pdfx-textlayer br { user-select: none; }` exclut les <br> (fins de ligne pdf.js, hasEOL) de la sélection et donc du presse-papiers.
- correction : supprimer cette règle (pdf.js garde les <br> sélectionnables) ; à terme gestionnaire `copy` qui reconstruit le texte depuis getTextContent (espaces, césures, ordre de lecture) comme Acrobat.

## navigation-10 — P1 — Glisser au-delà de la fin d'une ligne (marge) sélectionne jusqu'à la fin de la page, même avec la géométrie corrigée
- repro : `node 04-selection-copy.mjs nocsp fixbr` (cas I : début de ligne -> marge droite à x=565 pt)
- preuve : 1577 caractères sélectionnés au lieu de la ligne (89 car.) ; même cause pour le cas E (ligne de tableau -> 1087 car.).
- cause : PageView.tsx:132-159 n'implémente pas le mécanisme `endOfContent` + classe `.selecting` de TextLayerBuilder (pdf.js web/text_layer_builder.js) qui empêche le navigateur d'ancrer la fin de sélection sur le dernier nœud du calque quand le pointeur quitte les spans.
- correction : reprendre `TextLayerBuilder` de pdfjs-dist/web (ou son code : div.endOfContent déplacé au pointerdown, classe `selecting`, reset au pointerup).

## navigation-11 — P1 — Pages tournées (/Rotate 90/180/270) : le calque texte n'est pas tourné, la sélection et le texte visible ne coïncident pas
- repro : `node 03-textlayer-geometry.mjs csp` (captures out/03-mixed-p3|p4|p6-textlayer.png, spans rendus en rouge) ; `node 04-selection-copy.mjs nocsp fixbr` cas H (passe seulement avec les règles de rotation)
- preuve : mixed-geometry p4 (/Rotate 180) : le texte est peint à l'envers en bas à droite, le calque texte est en haut à gauche (capture) ; p3 (/Rotate 90) ratio largeur 0,048, p6 (/Rotate 270) 0,043 : les spans sont horizontaux alors que le texte affiché est vertical.
- cause : pdf.js pose `data-main-rotation` sur le conteneur (setLayerDimensions) et compte sur les règles `[data-main-rotation="90"]{transform:rotate(90deg) translateY(-100%)}` etc. absentes de pdf.css.
- correction : mêmes règles que navigation-07 (fix-textlayer.css lignes rotation) ; tester 0/90/180/270 + rotation utilisateur.

## navigation-12 — P1 — Ctrl+A ne sélectionne pas le texte (détourné vers « sélectionner les annotations de la page »)
- repro : `node 04-selection-copy.mjs csp` (cas D : clic dans le texte puis Ctrl+A)
- preuve : longueur de la sélection = 0 (Acrobat : tout le texte, copiable par Ctrl+C).
- cause : PdfWorkspace.tsx:1651-1655 `if (!inField && k === "a") { e.preventDefault(); setSelectedIds(annots de la page) }` quel que soit l'outil actif.
- correction : avec l'outil Sélection de texte, Ctrl+A = sélectionner le texte (range sur tous les calques texte montés, ou copie du texte complet via allText) ; garder « toutes les annotations » pour l'outil Sélection d'objets.

## navigation-13 — P1 — Recherche : 1 000 pages -> 31,6 s avant le premier résultat, gel de l'interface 5,9 s ; une lettre seule gèle 12 s et injecte 320 000 polygones
- repro : `node 10-search-perf.mjs csp Lorem` ; `node 10b-search-perf-cached.mjs csp e`
- preuve : edge-1000pages : saisie de « Lorem » (1,3 s de frappe) -> compteur stable « 1/8000 » après 31 623 ms ; 10 longues tâches = 7 044 ms, max 5 876 ms ; 8 000 <polygon> ; 37 401 nœuds DOM, tas 265 Mo. Texte déjà extrait, requête « e » : 21 226 ms, longues tâches 19 920 ms (max 12 038 ms), 320 000 polygones, 350 510 nœuds DOM. En Node, extraction seule 32,4 s (06-search-expected.mts) et search() « e » 3,8 s.
- cause : PdfWorkspace.tsx:1867-1873 relance `doSearch` à CHAQUE frappe sans anti-rebond ni annulation ; ensureText (663-671) extrait les 1 000 pages séquentiellement avant tout résultat (engine.allText, engine.ts:303-311) et chaque frappe relance allText tant que pageTextsRef est null ; search() (search.ts:174-200) tourne sur le thread principal sans limite ; l'effet 712-735 calcule les quads de TOUTES les pages touchées et PageView.tsx:214-231 dessine tous les polygones de toutes les pages montées (les 1 000 le sont, cf. viewer).
- correction : anti-rebond 200-300 ms + AbortController ; recherche incrémentale page par page (résultats affichés dès la 1re page, depuis la page courante) dans un Worker ; index texte construit en tâche de fond après ouverture ; plafonner/paginer les résultats ; ne calculer les quads que pour les pages visibles.

## navigation-14 — P1 — « Occurrence suivante » ne fait pas défiler jusqu'à l'occurrence : 5 fois sur 12 elle reste hors écran
- repro : `node 08-search-ui.mjs csp` (word-contrat, « contrat », Entrée x12)
- preuve : occurrences 8/65 à 12/65 actives à dy = 700, 789, 938, 1027, 1131 px pour une zone visible de 713 px (« HORS ») ; seul le changement de page provoque un défilement (13/65 -> p2 dy=11).
- cause : stepHit (PdfWorkspace.tsx:738-745) et onSearchSelect (2112-2116) appellent `goTo(page)` = haut de page ; la position du hit (quads) n'est jamais utilisée ; goTo n'est même pas rappelé si la page ne change pas.
- correction : défiler pour centrer le quad actif (scrollIntoView du polygone `.is-active` ou calcul depuis quadsForCharRange), comme Acrobat/pdf.js (`scrollMatchIntoView`).

## navigation-15 — P1 — Les boutons « Respecter la casse » et « Expression régulière » ne relancent pas la recherche (résultats faux jusqu'à la frappe suivante)
- repro : `node 08-search-ui.mjs csp`
- preuve : « Contrat » 1/65 ; clic Aa (classe is-on) -> compteur toujours 1/65 (attendu 1/1) ; il faut retaper un caractère pour obtenir 1/1.
- cause : PdfWorkspace.tsx:1897-1913 : les onClick ne font que `setSearchState` ; doSearch n'est déclenché que par onChange de l'input (1870-1873).
- correction : effet `useEffect(() => doSearch(query), [caseSensitive, regex, wholeWord, ignoreDiacritics])`.

## navigation-16 — P2 — Options « Mot entier » et « Ignorer les accents » inexistantes dans l'interface ; pas de vraie recherche avancée
- repro : `node 08-search-ui.mjs csp` (inventaire des boutons de la barre)
- preuve : boutons = [précédent, suivant, « Respecter la casse », « Expression régulière », « Tous les résultats », fermer]. `wholeWord` reste false et `ignoreDiacritics` true en permanence ; `highlightAll` (state.ts:113,125) n'est lu nulle part.
- cause : search.ts gère wholeWord/ignoreDiacritics mais PdfWorkspace.tsx:1861-1938 ne les expose pas ; le panneau « Recherche » (Sidebar.tsx:582-629) n'est qu'une liste de résultats.
- correction : cases Mot entier / Accents / Surligner tout ; panneau Recherche avancée façon Acrobat (mots entiers, casse, signets, commentaires, pièces jointes, plusieurs PDF d'un dossier, « tous les mots / n'importe lequel / expression exacte »).

## navigation-17 — P2 — Échap ferme la barre mais laisse les 96 surlignages affichés
- repro : `node 08-search-ui.mjs csp` (« le Prestataire » puis Échap)
- preuve : barreOuverte=0, surlignagesRestants=96 (Acrobat/pdf.js effacent les surlignages à la fermeture).
- cause : Échap (PdfWorkspace.tsx:1879 et 1693-1694) ne fait que `open:false` ; hits/hitQuads non vidés ; le bouton X (1925) vide la requête mais pas `hits` non plus.
- correction : vider hits + hitQuads à la fermeture (ou conserver mais masquer tant que la barre est fermée).

## navigation-18 — P2 — Arabe introuvable (formes de présentation, ordre visuel inversé) ; « Aero » ne trouve pas « Ærø »
- repro : `npx tsx --import ./register.mjs 06-search-expected.mts` ; `node 08-search-ui.mjs csp`
- preuve : « عربي » -> 0 résultat (texte extrait : « رﺎﺴﻴﻟا ﻰﻟإ … ﻲﺑﺮﻋ » = formes U+FExx, ordre inversé) ; « Aero » -> 0 (ø n'a pas de décomposition NFD). CJK OK (中文测试 1/1, 日本語 1/1), ligature « ffi » et « oeuvre » OK.
- cause : search.ts:73-88 foldChar = NFD + table FOLD, pas de NFKC (formes de présentation arabes/ligatures FBxx génériques) ni de repli ø/ł/đ ; pas de réordonnancement bidi du texte extrait.
- correction : normaliser NFKC avant pliage, table de repli latine étendue (ø->o, ł->l, ß->ss…), réordonner les runs RTL (pdf.js fournit `dir:"rtl"` par item).

## navigation-19 — P1 — Panneau « Pièces jointes » toujours vide (API pdf.js 6 mal lue) ; pièces jointes d'annotation ignorées
- repro : `npx tsx gen-navrich.mts` (nav-rich.pdf : 2 fichiers dans /EmbeddedFiles + 1 annotation FileAttachment p2) ; `npx tsx --import ./register.mjs 11b-attachments.mts` ; UI : `node 12-navrich-ui.mjs csp`
- preuve : UI -> compteur « 0 », « Ce document ne contient aucune pièce jointe. » ; engine.attachments() = [] alors que le catalogue contient `/EmbeddedFiles << /Names [ (notes.txt) 30 0 R (data.csv) 31 0 R ] >>`. Le worker pdf.js 6.2 renvoie désormais une `Map` sans contenu (pdf.worker.mjs:41096-41105, contenu via `getAttachmentContent(id)` pdf.mjs:15484).
- cause : engine.ts:366-378 fait `Object.values(raw)` (vide pour une Map) et lit `a.content` (n'existe plus) ; les annotations FileAttachment (p2 : `annexe-page2.txt`, bien vue par getAnnotations) ne sont listées nulle part.
- correction : `for (const [id, a] of raw)` + `await doc.getAttachmentContent(id)` à l'ouverture de la PJ ; ajouter les FileAttachment des pages (page, icône) comme dans le volet Acrobat ; test unitaire avec un PDF à EmbeddedFiles (aucun dans le corpus ni les tests).

## navigation-20 — P1 — Calques : un calque masqué par défaut est affiché « coché » et ne peut JAMAIS être rendu visible
- repro : `node 12-navrich-ui.mjs csp` (nav-rich.pdf, OCG « Brouillon » dans /D /OFF)
- preuve : à l'ouverture « Brouillon (masqué)=coché » mais 0 pixel rouge à l'emplacement de son texte ; clic -> « décoché », 0 pixel ; 2e clic -> « coché », 0 pixel. Console : « Warning: Unknown group type undefined. ». Décocher « Filigrane » fonctionne (1356 -> 0 pixels verts).
- cause : engine.ts:398 `cfg.isVisible(entry)` reçoit un id (chaîne) alors que pdf.js 6 attend un objet `{type:"OCG", id}` (pdf.mjs:14359-14371) -> renvoie toujours true ; engine.ts:418-429 `optionalContentConfig(hidden)` ne fait que `setVisibility(id, false)`, jamais `true`, donc un calque OFF par défaut reste OFF.
- correction : lire l'état via `cfg.getGroup(id).visible` (ou `isVisible({type:"OCG", id})`) ; stocker l'état voulu de CHAQUE calque et appeler `setVisibility(id, visible)` ; gérer RBGroups/verrouillés/arborescence (Order imbriqué) comme Acrobat.

## navigation-21 — P1 — Signet vers une URL : navigue silencieusement vers la page 1 au lieu d'ouvrir le lien
- repro : `node 12-navrich-ui.mjs csp` (signet « Site web (URI) » -> https://example.com/)
- preuve : la colonne page du signet affiche « 1 » ; clic -> page 1, aucun dialogue, aucune fenêtre ouverte. engine.outline() renvoie pourtant `{page:null, url:"https://example.com/"}` (11-navrich-dump.mts).
- cause : PdfWorkspace.tsx:2781-2801 `outlineToBookmarks` : `page: n.page ?? 1` et `url` n'est pas recopié ; onBookmarkGoTo (2097) = `goTo(b.page, b.y)`. Les actions nommées (NextPage, Print…), Launch, GoToR (autre PDF) sont de même perdues.
- correction : conserver `url`/action dans le modèle Bookmark ; au clic, même confirmation que les liens (PdfWorkspace.tsx:2207-2210) ; signets d'action non résolue affichés sans numéro de page.

## navigation-22 — P2 — L'état replié des signets (/Count négatif) est ignoré : tout le plan est déplié à l'ouverture
- repro : `node 12-navrich-ui.mjs csp` ; preuve : « Partie fermée » (/Count -2) affiche immédiatement « Sous 1 (p4) » et « Sous 2 (p5 y300) » ; pdf.js fournit `count:-2` (11-navrich-dump.mts, ligne « raw pdf.js »).
- cause : engine.ts:316-337 `outline()` ne lit pas `it.count` ; outlineToBookmarks (PdfWorkspace.tsx:2792-2801) ne pose pas `closed`. Sur un long rapport à 200 signets, le volet est illisible (Acrobat respecte l'état enregistré).
- correction : `closed: typeof it.count === "number" && it.count < 0`.

## navigation-23 — P1 — Les étiquettes de page du PDF (/PageLabels : i, ii, iii, A-1…) ne sont jamais lues
- repro : `node 12-navrich-ui.mjs csp` (nav-rich.pdf) ; `npx tsx --import ./register.mjs 11-navrich-dump.mts`
- preuve : pdf.js `getPageLabels()` = ["i","ii","iii","A-1","A-2","A-3","A-4","A-5"] ; l'UI affiche « 1 » … « 8 » sur les pages, le champ page affiche « 1 » et « / 8 » ; aucun appel à getPageLabels dans src/pdf (grep).
- cause : engine.ts (pas de lecture des étiquettes) ; D.pagesFromSource ne remplit pas `label` ; seules les étiquettes créées dans Elium (model/doc.ts:184 labelPages) existent.
- correction : lire `getPageLabels()` à l'ouverture et initialiser `Page.label` ; champ page qui affiche/accepte l'étiquette « iii (3 sur 8) » comme Acrobat.

## navigation-24 — P1 — Liens internes : la position cible (/XYZ top) est ignorée — la cible reste hors écran
- repro : `node 12-navrich-ui.mjs csp` (lien p1 -> [p7 /XYZ 0 300])
- preuve : page 7 atteinte mais le point cible est à 804 px sous le haut de la zone visible (hauteur 713) : invisible.
- cause : PageView.tsx:257-258 ne transmet que `{page}` (resolveDest renvoie pourtant `y`) ; PdfWorkspace.tsx:2205-2206 `goTo(target.page)` ; cumul avec l'erreur de 161 px de navigation-01 pour les signets.
- correction : transmettre `y` (et le zoom /XYZ, /FitH, /FitR) et l'appliquer ; pousser la vue dans l'historique (navigation-04).

## navigation-25 — P1 — Vignettes : sous la CSP de bureau, 7/7 vignettes cassées ET cadres écrasés à 2 px de haut (volet inutilisable)
- repro : `node 13-thumbs.mjs csp` vs `node 13-thumbs.mjs nocsp`
- preuve : CSP : 7 <img>, 0 décodée, 7 cassées (0x0), cadre `.pdfx-thumb__img` 156x2 px ; sans CSP : images 264x373, cadre 156x220. (Blocage data: déjà connu ; conséquence ici : le cadre n'a pas de hauteur propre, donc même la silhouette de page disparaît.)
- cause : Sidebar.tsx:116-117 `canvas.toDataURL("image/png")` -> <img src="data:"> bloqué par `default-src 'self'` ; la boîte n'a pas d'aspect-ratio fixé depuis la taille de page.
- correction : dessiner la vignette dans un <canvas> (ou blob: URL avec img-src blob: dans la CSP), réserver la hauteur via `aspect-ratio` = taille de page ; passer par le RenderScheduler (Sidebar.tsx:116 rend hors file, en concurrence avec les pages).

## navigation-26 — P2 — La vignette de la page courante n'est jamais ramenée dans le volet
- repro : `node 13-thumbs.mjs csp` (word-250pages, touche Fin)
- preuve : page 251 affichée, vignette « 251 » marquée is-current mais à 63 865 px sous le haut du volet (scrollTop du volet = 0).
- cause : Sidebar.tsx:163-168 ne fait que poser la classe `is-current` ; aucun scrollIntoView.
- correction : `scrollIntoView({block:"nearest"})` de la vignette courante quand `current` change (sauf pendant un défilement manuel du volet).

## navigation-27 — P2 — Pivoter une page depuis sa vignette : la vignette ne tourne pas, et le zoom « Largeur » passe à ~570 %
- repro : `node 13-thumbs.mjs nocsp` ; `node 13b-rotate-zoom.mjs`
- preuve : après « Pivoter 90° » de la vignette 2 : page affichée 8419x5953 px (paysage) mais vignette toujours 264x373 (portrait) ; largeur de la page 1 : 1042 -> 5953 px en mode « Largeur » (bug de zoom Largeur déjà connu, déclenché ici par une simple rotation).
- cause : Thumb (Sidebar.tsx:101-126) ne reçoit ni la rotation utilisateur ni de clé de rafraîchissement (effet dépendant de engine/from/width seulement) et renderToCanvas utilise `page.rotate` (render.ts:154) ; zoom : calcul fitWidth (viewer).
- correction : passer `rotation` (et un compteur de révision : annotations, contenu modifié) à Thumb.

## navigation-28 — P1 — Après suppression/réorganisation de pages, la recherche renvoie des occurrences de pages supprimées et affiche de faux numéros de page
- repro : `node 14-search-after-organize.mjs csp` (word-contrat : supprimer la page 1 via sa vignette, puis rechercher)
- preuve : « Article 3 » (ancienne p2, désormais p1) -> panneau « Page 2 » ; « Article 1 » (texte présent uniquement sur la page supprimée) -> « 1/1 », groupe « Page 1 », et la vue saute à la page 1 (qui est l'ancienne p2).
- cause : search() travaille sur les index SOURCE (pageTextsRef, PdfWorkspace.tsx:663-671) ; Sidebar.tsx:611 affiche `Page {page + 1}` (index source) ; stepHit/doSearch (694-695, 742-744) font `findIndex(from===hit.page)` et retombent sur `hit.page` quand la page n'existe plus (-1) au lieu d'écarter le résultat.
- correction : filtrer les hits dont la page source n'est plus dans `state.pages` (et dupliquer pour les pages dupliquées), afficher le numéro/étiquette de sortie ; recalculer à chaque changement de `pages`.

## navigation-29 — P2 — Mode « Expression régulière » : toute lettre accentuée dans le motif ne trouve plus rien (« présent » -> 0 au lieu de 64)
- repro : `npx tsx --import ./register.mjs 15-search-edge.mts` (sortie out/15.txt)
- preuve : word-contrat, options de l'UI (ignoreDiacritics=true, non désactivable) : « présent » texte simple = 64 ; « présent » regex = 0 ; « délais? » regex = 0 ; « pr.sent » regex = 64 (la page est donc bien cherchée sans accents).
- cause : search.ts:174-200 plie TOUJOURS le texte de la page (foldText avec ignoreDiacritics -> « present ») alors que compileQuery (search.ts:131-134) garde le motif regex tel quel (« présent ») ; l'UI ne propose aucun bouton « Ignorer les accents » (PdfWorkspace.tsx:1897-1913) pour sortir de ce piège.
- correction : en mode regex, chercher sur le texte d'origine (ou plier aussi les littéraux du motif) ; exposer l'option accents.

## navigation-30 — P2 — Mot coupé par une césure en fin de ligne introuvable (« Presta-/taire », « confiden-/tialité »)
- repro : `npx tsx --import ./register.mjs 15-search-edge.mts` (génère out/hyphen.pdf)
- preuve : texte de page extrait = "Les obligations du Presta-\ntaire … La confiden-\ntialité …" ; « Prestataire » -> 0, « confidentialité » -> 0 (le fragment « Presta » est trouvé : 1). pdf.js (Firefox) retire « -\n » entre deux lettres avant de chercher ; Acrobat retrouve aussi les mots coupés.
- cause : search.ts:41-65 (FOLD) ne traite que le trait d'union conditionnel U+00AD ; compileQuery (search.ts:136-137) ne tolère que des blancs entre les mots, jamais « -\n » à l'intérieur d'un mot.
- correction : dans foldText, supprimer « -\n » (et « ‐\n ») entre deux lettres en conservant la table d'offsets (comme pdf_find_controller normalize()).

## navigation-31 — P3 — « Mot entier » + CJK : 0 résultat (le chinois n'a pas d'espaces)
- repro : `npx tsx --import ./register.mjs 15-search-edge.mts`
- preuve : edge-web « 中文 » = 1 résultat ; même requête avec wholeWord = 0. (Latent : l'option n'est pas exposée dans l'UI, cf. navigation-16.)
- cause : search.ts:118-122 isWordChar = \p{L} -> tous les idéogrammes sont des « lettres » voisines.
- correction : ignorer la contrainte de mot entier pour les écritures sans séparateurs (Han, Hiragana, Katakana, Thaï) ou utiliser Intl.Segmenter(granularity:"word").

## navigation-32 — P0 — « Rechercher et caviarder » laisse des lettres lisibles dans le PDF final et efface des lettres voisines innocentes
- repro : `npx tsx --import ./register.mjs 19-redact-search.mts` (reproduit exactement le dialogue redactSearch : search -> buildRuns/quadsForCharRange -> rectOfQuads -> buildPdf({applyRedactions:true})) puis `npx tsx --import ./register.mjs 19b-redact-diff.mts` (diff LCS du texte p1 avant/après) ; rendu : `node 19c-redact-view.mjs` -> out/19c-capital-crop.png
- preuve : word-contrat « capital » : 16 des 77 caractères des occurrences de la p1 restent dans le PDF « caviardé » (« capita«l» de », « c«a»pital ») et 11 caractères voisins sont supprimés (« a«u» capital ») ; la capture montre « a ████ l de 10 000 € » et « a████al de ». « Exemple SAS » : 11 lettres restantes (« Exemple «S»AS ») ; edge-web « consectetur » : « consectetu«r» » reste ; « confidentialité » : 5 points finaux supprimés à tort. Le mot recherché n'est plus trouvé en entier, donc un contrôle naïf « le mot a disparu » passe alors que des lettres fuient.
- cause : core/text.ts:337-339 `quadsForCharRange` répartit la largeur de l'item uniformément (`per = run.width / run.str.length`) ; sur du texte proportionnel l'erreur cumulée atteint ~1 caractère en milieu de ligne ; le rectangle décalé est ensuite passé tel quel à applyRedactions (PdfWorkspace.tsx:2728-2750) dont le seuil GLYPH_HIT=0.22 (ops/redact.ts:22) garde la dernière lettre et prend la lettre précédente.
- correction : calculer les rectangles de caviardage à partir des vraies boîtes de glyphes (ops/redact.ts glyphBoxes/fontmetrics sait déjà les produire depuis les largeurs de police) ou à défaut depuis le calque texte corrigé ; élargir d'une marge de sécurité ; après application, revérifier par extraction que plus aucun caractère d'occurrence ne subsiste (sinon avertir) ; test de non-régression sur texte proportionnel (le test actuel caviarde une ligne entière).

## navigation-33 — P2 — Surlignages de recherche décalés d'environ un caractère (« capital » surligné « u capita »)
- repro : `node 18-hit-accuracy.mjs csp word-contrat.pdf capital` -> out/18-capital-crop.png ; `... "confidentialité"` -> out/18-conf-crop.png
- preuve : capture : le surlignage de « capital » (ligne 1, p1) commence sur le « u » de « au » et s'arrête avant le « l » ; l'erreur varie selon la position dans la ligne (même cause que navigation-32). (La mesure automatique en « caractères » du script n'est pas fiable — seule la capture fait foi.)
- cause : core/text.ts:337-339 (interpolation uniforme) ; le commentaire core/text.ts:316-320 affirme que c'est « visuellement indiscernable », ce qui est faux.
- correction : positions de glyphes réelles (largeurs de police via fontmetrics, ou Range.getClientRects sur le calque texte une fois navigation-07 corrigé, comme pdf.js).

## navigation-34 — P2 — Chaque recherche ramène à la 1re occurrence du document (page 1), pas à la suivante depuis la page courante
- repro : `node 16-search-ui-more.mjs csp A` (word-250pages : touche Fin -> p251, Ctrl+F « contrat »)
- preuve : avant = page 251 ; après = compteur « 1/2250 », champ page « 1 », page visible 1. Acrobat (et pdf.js) cherchent à partir de la page courante ; ici l'utilisateur perd sa position (et il n'y a pas d'historique pour y revenir, navigation-04).
- cause : PdfWorkspace.tsx:690-695 `index: 0` + `goTo(found[0].page)` ; `firstHitFromPage` (search.ts:209-213) existe mais n'est appelée nulle part (grep).
- correction : `index = firstHitFromPage(hits, pageSourceCourante)` et ne pas déplacer la vue si une occurrence est déjà visible.

## navigation-35 — P2 — Ctrl+F avec la barre déjà ouverte ne remet pas le focus dans le champ : la frappe suivante change d'outil au lieu de chercher
- repro : `node 17-ctrlf-refocus.mjs csp` (annotated.pdf : Ctrl+F « capital », clic dans la page, outil Sélection + clic sur une annotation, Ctrl+F, taper « dessin », Retour arrière) ; capture out/17-after.png
- preuve : focusApresCtrlF = `pdfx-canvas` ; champ de recherche toujours « capital » ; les lettres ont été interprétées comme raccourcis d'outils (d=Encre, e=Ellipse, n=Note) : outil final « Note » activé (capture). Même constat sur word-250pages (`16-search-ui-more.mjs csp A`, étape B).
- cause : PdfWorkspace.tsx:1632-1635 Ctrl+F ne fait que `open:true` ; le champ n'a que `autoFocus` (PdfWorkspace.tsx:1865), qui ne joue qu'au montage ; les raccourcis mono-lettre (PdfWorkspace.tsx:1731-1752) s'appliquent dès que le focus n'est pas dans un champ.
- correction : ref sur l'input, `focus()` + `select()` à chaque Ctrl+F (comme Acrobat/navigateurs) ; pré-remplir avec la sélection courante (navigation-36).

## navigation-36 — P3 — Ctrl+F ne reprend pas le texte sélectionné
- repro : `node 16-search-ui-more.mjs csp D` (sélection programmatique de « capital » dans le calque texte, puis Ctrl+F)
- preuve : sélection = « capital », champ de recherche = "" (Acrobat pré-remplit la recherche avec la sélection).
- cause : PdfWorkspace.tsx:1632-1635.
- correction : `query = window.getSelection().toString().trim()` si non vide (≤ 200 car.) puis doSearch.

## navigation-37 — P2 — La recherche ignore le texte des commentaires (notes, surlignages commentés, zones de texte libre)
- repro : `node 16-search-ui-more.mjs csp E` (annotated.pdf ; contenus lus par `npx tsx --import ./register.mjs 16a-annot-dump.mts`)
- preuve : « service juridique », « capital social », « Texte libre ajouté », « Zone importante » -> « 0 » pour les 4, alors que ce sont les /Contents des annotations Highlight, Text (réponse), FreeText et Square de la p1. Acrobat : option « Inclure les commentaires » dans Rechercher / Recherche avancée.
- cause : doSearch (PdfWorkspace.tsx:674-697) ne cherche que dans `engine.allText()` (flux de contenu) ; ni state.annots ni les réponses ne sont indexés.
- correction : ajouter une source « commentaires » (texte + réponses + auteur) aux résultats, groupée à part dans le panneau Recherche, avec saut vers l'annotation.

## navigation-38 — P3 — Recherche dans un scan sans couche texte : « 0 » sans explication
- repro : `node 16-search-ui-more.mjs csp F` (scan-jpeg.pdf, « contrat »)
- preuve : compteur « 0 », aucun message. Acrobat Pro signale que le document est une image et propose « Reconnaître le texte » (OCR, qui existe pourtant dans Elium : ops/ocr.ts).
- cause : doSearch (PdfWorkspace.tsx:674-697) ne distingue pas « aucun texte dans le document » de « aucune occurrence ».
- correction : si toutes les pages ont un texte vide, afficher « Ce document ne contient pas de texte reconnu — Lancer l'OCR ».

## navigation-39 — P3 — Boutons précédent/suivant/fermer de la barre de recherche sans nom accessible
- repro : `node 08-search-ui.mjs csp` (inventaire `title || textContent` des boutons de .pdfx-find)
- preuve : boutons = ["", "", "Respecter la casse", "Expression régulière", "Tous les résultats", ""] : lecteur d'écran muet sur 3 boutons, pas d'infobulle.
- cause : PdfWorkspace.tsx:1889-1894 et 1925 (icônes ChevronLeft/ChevronRight/X sans title ni aria-label).
- correction : `title`/`aria-label` « Occurrence précédente (Maj+Entrée) », « Occurrence suivante (Entrée) », « Fermer (Échap) ».

## navigation-40 — P2 — Les restrictions de copie du PDF sont ignorées (texte d'un document « copie interdite » copiable)
- repro : `node 21-copy-perm.mjs csp` (encrypted-owner-only.pdf) ; permissions : `npx tsx --import ./register.mjs 21b-perms.mts`
- preuve : pdf.js : permissions accordées = [MODIFY_ANNOTATIONS, FILL_INTERACTIVE_FORMS, COPY_FOR_ACCESSIBILITY, ASSEMBLE, PRINT_HIGH_QUALITY] (pas COPY) ; dans l'appli : sélection de la page 1 + Ctrl+C -> 3 241 caractères dans le presse-papiers, `user-select: auto`, aucune mention de restriction à l'écran. Acrobat grise Copier et la sélection de texte (sauf mot de passe propriétaire).
- cause : aucun appel à `getPermissions()` dans src/pdf (grep) ; inspectProtection (ops/security.ts:841-856) n'est utilisé que pour la boîte Propriétés (PdfWorkspace.tsx:1361-1368).
- correction : lire les permissions à l'ouverture, désactiver copie/Ctrl+A/Copier comme texte (et impression/modif selon les bits) avec un bandeau « Document protégé — saisir le mot de passe propriétaire » ; garder l'accès lecteur d'écran (COPY_FOR_ACCESSIBILITY).

## navigation-41 — P2 — Panneau « Tous les résultats » : 8 000 lignes montées d'un coup (gel 1,1 s) et la ligne active n'est jamais ramenée à l'écran
- repro : `node 22-results-panel.mjs csp` (edge-1000pages, « Lorem », puis bouton « Tous les résultats », puis Entrée x40)
- preuve : compteur « 1/8000 » après 23,2 s ; ouverture du panneau 1 291 ms, 1 longue tâche de 1 087 ms, 8 000 `.pdfx-hitrow` + 1 000 groupes montés (35 396 nœuds DOM, tas 132 Mo) ; après Entrée x40 (41/8000) la ligne active est à 2 764 px sous le haut d'un panneau de 675 px (invisible). Le bouton relance aussi toute la recherche (PdfWorkspace.tsx:1915-1918).
- cause : Sidebar.tsx:582-625 SearchResults rend tous les résultats sans virtualisation ni plafond ; aucun scrollIntoView sur `.is-active`.
- correction : liste virtualisée (ou pagination « 200 premiers résultats, afficher plus »), `scrollIntoView({block:"nearest"})` de la ligne active, ne pas relancer doSearch si la requête n'a pas changé.

## navigation-42 — P1 — Ouvrir puis enregistrer sans rien toucher réécrit le plan : signet URL transformé en saut vers la page 1, état replié perdu, /Fit remplacé
- repro : `npx tsx --import ./register.mjs 23-outline-roundtrip.mts` (chaîne de prod : engine.outline -> outlineToBookmarks -> state.bookmarks -> buildPdf -> relecture pdf.js ; sortie out/23.txt)
- preuve : nav-rich.pdf AVANT « Site web (URI) -> URL https://example.com/ », « Partie fermée -> p4 Fit [replié] », « Préface -> p1 Fit » ; APRÈS « Site web (URI) -> p1 XYZ top=842 », « Partie fermée -> p4 XYZ top=842 » (déplié), « Préface -> p1 XYZ ». word-contrat (Word) : le nœud racine « Contrat de prestation de services » perd son état [replié]. (Le décalage des pages après suppression/réorganisation est déjà couvert par organize-01.)
- cause : à l'ouverture PdfWorkspace.tsx:309 copie le plan dans state.bookmarks via outlineToBookmarks (PdfWorkspace.tsx:2780-2801 : `page: n.page ?? 1`, ni url, ni action, ni closed, ni type de destination) ; save.ts:301-303 réécrit TOUJOURS /Outlines depuis ce modèle appauvri.
- correction : ne réécrire le plan que s'il a été modifié (state.bookmarks === null tant que l'utilisateur n'a pas édité) ; enrichir Bookmark (url, action nommée, destination /Fit /FitH /XYZ + zoom, closed) et les réécrire fidèlement.

## navigation-43 — P1 — Après suppression/réorganisation de pages, les liens internes mènent à la mauvaise page
- repro : `node 24-link-after-delete.mjs csp` (nav-rich.pdf : supprimer la page 3 via sa vignette, puis cliquer le lien de la p1 qui vise « CIBLE-LIEN » sur la page physique 7)
- preuve : après suppression (« / 7 »), le clic mène au champ page « 7 », page visible 7 dont le texte est « Page physique 8 » ; la cible « CIBLE-LIEN » est sur la page 6 de la vue.
- cause : PageView.tsx:252-258 `resolveDest` renvoie un numéro de page SOURCE (engine.ts:340-...) ; PdfWorkspace.tsx:2205-2206 `goTo(target.page)` l'interprète comme un numéro de page de la VUE ; même confusion que navigation-28 (recherche) et organize-01 (signets).
- correction : convertir source -> vue via `pages.findIndex(p => p.from === src-1)` (et ignorer/signaler une cible supprimée), idem pour signets et résultats de recherche : un seul utilitaire `viewPageOfSource()`.

## navigation-44 — P2 (lecture de code) — La recherche ignore le texte modifié dans Elium (paragraphes édités, texte ajouté)
- repro : lecture de code (PdfWorkspace.tsx:665-697) ; scénario : Modifier le texte « Dupont » -> « Martin », puis Ctrl+F « Martin » -> 0, « Dupont » -> trouvé et surligné sous le nouveau paragraphe ; « Rechercher et caviarder » ne peut donc pas atteindre le texte saisi dans Elium.
- preuve : doSearch/ensureText n'utilisent que `engine.allText()` (octets d'origine) mis en cache dans pageTextsRef, remis à null seulement à l'ouverture (PdfWorkspace.tsx:302) ; `state.contentEdits` (model/types.ts:247-263, champ `text`) n'est jamais consulté.
- correction : pour les pages modifiées, substituer le texte des blocs édités (blockKey -> text) dans le texte cherché et invalider le cache à chaque modification.

## navigation-45 — P3 (lecture de code) — Volet Signets en deçà d'Acrobat : pas de « Définir la destination », position/zoom non capturés, pas de glisser-déposer, pas de signet courant, pas de sémantique d'arbre
- repro : lecture de code Sidebar.tsx:239-322 et PdfWorkspace.tsx:1475-1478
- preuve : « Nouveau signet » crée `{ page: view.current }` sans `y` ni zoom (Acrobat mémorise la vue exacte) ; aucune action « Définir la destination » ; pas de drag-and-drop pour réordonner/imbriquer ; aucune mise en évidence du signet de la section courante ; liste de `<div>`/`<button>` sans role="tree"/"treeitem"/aria-expanded ni navigation aux flèches ; le numéro affiché (`node.page`) n'est pas une étiquette de page.
- correction : Bookmark {pageId, y, zoom}, action Définir la destination, DnD, surlignage du signet courant, rôles ARIA tree + flèches Haut/Bas/Gauche/Droite.

## navigation-46 — P3 (lecture de code) — Pas de barre d'actions rapides sur une sélection de texte (Copier, Surligner, Barrer, Ajouter une note)
- repro : lecture de code : aucun gestionnaire de sélection hors outils de balisage (PdfWorkspace.tsx:600-660) ; aucun onContextMenu pour le texte (seul PdfWorkspace.tsx:2279, annotations).
- preuve : Acrobat affiche une mini-barre à la fin d'une sélection et un menu contextuel « Copier / Copier avec mise en forme / Surligner… » ; ici il faut d'abord choisir l'outil puis resélectionner.
- correction : popover au mouseup si la sélection est non vide (Copier, Surligner, Souligner, Barrer, Commentaire, Caviarder).
