# FINDINGS — domaine viewer (ouverture, rendu, performance d'affichage)
# Format : id | sévérité | titre | repro | preuve | cause | correction
# (reprise 2026-09-23 ; chaque constat ci-dessous a été REJOUÉ dans cette session sauf mention code-reading)

## viewer-01 | P1 | perf | Marge de pré-rendu inopérante : une page n'est rendue qu'une fois ENTRÉE dans la zone visible
- Repro : `node 20-prefetch.mjs word-contrat.pdf` (depuis diag/viewer, 3210)
- Preuve : page 3 placée à 150 px puis 600 px sous le bord bas du conteneur, après 2,5 s → `ready:false, bitmap 300x150` (jamais rendue), alors que le code prévoit 900 px d'anticipation.
- Cause : ui/PageView.tsx:80-86 — `new IntersectionObserver(cb, { rootMargin: "900px 0px" })` SANS `root` : la marge agrandit le viewport du document, mais l'intersection est rognée par le conteneur défilant `.pdfx-canvas` (overflow:auto, pdf.css:431-437) ; la marge ne sert donc à rien → chaque page apparaît en squelette puis se peint pendant le défilement.
- Correction : passer `root: scrollRef.current` (le conteneur `.pdfx-canvas`) à l'IO (ou un IO unique partagé créé par PdfWorkspace) avec rootMargin ≈ 1-1,5 hauteur d'écran ; mieux, un calcul de fenêtre visible basé sur scrollTop (comme PDFViewer.getVisiblePages de pdf.js).

## viewer-02 | P3 | perf | Un nouveau worker pdf.js est créé à chaque ouverture ; 1re ouverture ~0,9 s même pour 1 page
- Repro : `node 21-open-breakdown.mjs form-acro.pdf`
- Preuve : `firstOpenToPaintMs: 932`, réouvertures 326/320/198 ms, `workersTotal: 4` pour 4 ouvertures (1 worker par ouverture).
- Cause : core/engine.ts:177 `pdfjs.getDocument({...})` sans `worker:` partagé ; engine.ts:440 `task.destroy()` tue le worker ; pas de pré-chauffe du worker à l'affichage du module.
- Correction : créer un `new pdfjs.PDFWorker()` unique au chargement du module (pré-chauffé pendant l'écran d'accueil) et le passer à getDocument({ worker }) ; ne détruire que le document.

## viewer-03 | P1 | perf | Défilement continu à 24 i/s sur edge-1000pages (100 longues tâches, 17 % d'images avec une page blanche au centre)
- Repro : `node 05-scroll.mjs edge-1000pages.pdf 300` puis `node 05-scroll.mjs word-250pages.pdf 300` (3210, 1440x900, dsf 1, zoom Largeur 175 %)
- Preuve (edge-1000) : 300 crans de molette de 240 px en 31,6 s → `avgFps 24, p50 33 ms, p95 83 ms, max 133 ms, 143 images > 50 ms, blankCentreFrames 129/767, longTasks n=100 total 6143 ms max 101 ms`. Témoin word-250 : `avgFps 58, p95 17 ms, 0 longue tâche, 0 page blanche`. Le coût croît donc avec le NOMBRE de pages, pas avec le contenu visible.
- Cause : (1) PdfWorkspace.tsx:1841 `const visiblePages = pages;` → 1000 PageView montées (déjà connu : 28 000 nœuds) ; (2) PdfWorkspace.tsx:518-532 `onScroll` parcourt les 1000 `[data-page]` et lit offsetTop/offsetHeight à CHAQUE événement scroll (pas de rAF/throttle) ; (3) chaque changement de `view.current` (setView ligne 531) re-rend PdfWorkspace et les 1000 PageView, car `children` est recréé à chaque rendu (commentaire PageView.tsx:273-279) ; (4) viewer-01 (pas d'anticipation) → pages blanches.
- Correction : virtualiser (ne monter que les pages dans une fenêtre ±N autour du viewport, espaceurs de hauteur calculée), calculer la page courante par recherche dichotomique sur un tableau d'offsets cumulés (pas de lecture DOM), sortir `current` du state global (ref + abonnement ciblé pour la barre de navigation), throttler onScroll via rAF.

## viewer-04 | P1 | perf/mémoire | Les rasters et calques texte des pages quittées ne sont JAMAIS libérés : 1,5 Go de bitmaps après un parcours de word-250pages
- Repro : `node 06-traverse-memory.mjs word-250pages.pdf 1 120` (et `node 05-scroll.mjs …` : section « hors écran »)
- Preuve : dsf 1, page 1 → 251 : `rasterised 1→251, bitmapMB 6→1541, dom 7400→20860, spans 28→7000` ; après 49 pages de défilement molette sur edge-1000 : `offscreenRaster 46, offscreenMB 283, textLayersOff 46`. À dsf 2 (`DSF=2 node 06b-traverse-memory-dsf.mjs word-250pages.pdf 1 120`) : `bitmapMB 25→5994` (6 Go de canvas conservés, 244 rasters), parcours 68,8 s au lieu de 32,6 s.
- Cause : ui/PageView.tsx:93-97 — quand la page sort (`visible=false`), l'effet raster retourne sans rien faire ; le `<canvas>` garde son bitmap (width/height jamais remis à 0) ; l'effet texte (l.132-159) ne vide pas non plus le conteneur (`replaceChildren` seulement au rendu suivant). Aucun plafond global (pdf.js PDFViewer garde ~10 pages en cache LRU et libère les autres).
- Correction : à la sortie de la fenêtre élargie, `canvas.width = canvas.height = 0` (libère la mémoire GPU/CPU), `container.replaceChildren()`, `page.cleanup()` ; LRU global de N pages rendues (N≈8-12, borné en Mo) dans RenderScheduler.

## viewer-05 | P1 | perf | Avec 1000 pages, un simple changement de « page courante » bloque le fil principal 110-140 ms (re-rendu de toutes les pages)
- Repro : `node 24-rerender-cost.mjs edge-1000pages.pdf` ; témoins `word-250pages.pdf`, `word-contrat.pdf`
- Preuve : bascule 20× entre les pages 1 et 2 DÉJÀ rendues (aucun nouveau rendu pdf.js) : edge-1000 → `longTasks n=37 total 2570 ms max 156 ms`, image suivante après changement `[113,115,121,130,138,118] ms` ; word-250 → 0 longue tâche, `[44,36,49,32,48,37] ms` ; word-contrat (7 p.) → `[26..33] ms`. Coût linéaire en nombre de pages.
- Cause : PdfWorkspace.tsx:531 `setView(... current: best)` dans onScroll → re-rendu complet de PdfWorkspace (2800 lignes) qui reconstruit les 1000 éléments PageView (l.2169-2300) avec `children` neufs, `hitList`, callbacks inline (`onTextLayer`, `onLinkActivate`) → memo inopérant (PageView.tsx:273-290).
- Correction : virtualisation (viewer-03) + isoler `current` (store externe/useSyncExternalStore consommé seulement par la barre de navigation et la vignette active) ; mémoriser les enfants par page.

## viewer-06 | P0 | bug | Saisir un numéro de page ne fonctionne pas : taper « 900 » amène à la page 10 ; le champ ne peut même pas être vidé
- Repro : `node 07-goto.mjs edge-1000pages.pdf 900` (3210) — clic dans le champ, Fin, Retour arrière ; puis tout sélectionner et taper 9-0-0 (120 ms entre touches, cadence humaine)
- Preuve : après Retour arrière sur « 1 » la valeur reste `"1"` ; trace des valeurs du champ pendant la saisie `1 → 9 → 1 → 10 → 1 → 10 → 1 → 2 → 4 → 7 → 8 → 9 → 10` ; page 900 `msUntilPainted: jamais (30 s)`, `visible:false`, page finale = 10. 21 longues tâches (1776 ms, max 167 ms) pendant la saisie.
- Cause : PdfWorkspace.tsx:1950-1958 — `<input value={view.current} onChange={… if (n) goTo(n)}>` : champ CONTRÔLÉ par la page courante, navigation déclenchée à CHAQUE frappe (« 9 » part vers la page 9 en défilement smooth), et onScroll (l.518-532) réécrit `view.current` pendant l'animation, donc la valeur tapée est écrasée entre deux touches ; `n=0` ignoré → impossible de vider le champ.
- Correction : état local d'édition (valeur brute tant que le champ a le focus), navigation seulement sur Entrée/blur, sélection du contenu au focus, validation 1..N (et libellés de page), ne pas resynchroniser depuis le scroll pendant l'édition.

## viewer-07 | P1 | bug | Toute navigation (Page suivante, PageDown, signet, lien, champ) cache le haut de la page cible de 145 px
- Repro : `node 18-goto-offset.mjs` (word-contrat, 3210)
- Preuve : PageDown → page 2 : `offsetParent: "pdfx pdfx--theme-paper", offsetTop 1675, pageTopMinusViewportTop: -145` ; bouton › → page 3 : idem `-145`. Le titre en haut de la page cible est sous le bord du conteneur.
- Cause : PdfWorkspace.tsx:508-511 `goTo` utilise `el.offsetTop - 16`, mais l'offsetParent de `.pdfx-page` est `.pdfx` (racine du module) et non le conteneur défilant `.pdfx-canvas` (qui n'est pas positionné) → l'offset inclut la hauteur de la barre + ruban (~161 px). Même erreur dans `onScroll` (l.521-526 compare offsetTop au scrollTop) → la « page courante » est décalée d'autant.
- Correction : calculer `top = host.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - marge`, ou rendre `.pdfx-canvas` `position: relative` (pdf.css:431) pour qu'il devienne l'offsetParent.

## viewer-08 | P2 | bug | Rafale de PageDown : 5 appuis rapides depuis la page 1 amènent à la page 3 (attendu 6)
- Repro : `node 26-pagedown-burst.mjs word-contrat.pdf`
- Preuve : intervalle 120 ms → trace du champ `["1","1","2","2","2"]`, page finale 3 ; intervalle 400 ms → `["2".."6"]`, page 6 (correct).
- Cause : PdfWorkspace.tsx:1706-1713 `goTo(view.current + 1)` part de `view.current`, que onScroll (l.518-531) réécrit pendant le défilement `behavior: "smooth"` (l.511 + `scroll-behavior: smooth` pdf.css:436) avec la page intermédiaire ; les appuis suivants repartent donc d'une page en retard.
- Correction : mémoriser une « page cible » (ref) pendant une navigation programmée et l'utiliser comme base ; ignorer onScroll pour `current` tant que l'animation n'est pas terminée ; défilement instantané pour PageDown (comme Acrobat en mode une page).

## viewer-09 | P0 | bug | Calque texte désaligné (police 13 px fixe, pas d'étirement, pas de rotation) → sélection/copie/surlignage de texte inutilisables
- Repro : `node 10-textlayer-align.mjs word-contrat.pdf 1` ; `node 10-textlayer-align.mjs mixed-geometry.pdf 3 http://127.0.0.1:3211/ 1` ; `node 11-select-text.mjs` puis `node 11-select-text.mjs http://127.0.0.1:3211/` (identique avec et sans CSP)
- Preuve : word-contrat p1 à 175 % : police attendue 21 / 35,1 / 27,9 px, police calculée `13 px` partout, `transform: none` alors que `--scale-x` vaut 0,90-0,95 ; boîte du titre 190×13 px contre 465×35 px de glyphes (captures out/10-textlayer-word-contrat-p1-3210.png : les cadres rouges ne couvrent qu'un tiers du texte). Page /Rotate 90 : calque horizontal en haut à gauche, texte peint vertical à droite (out/10-textlayer-mixed-geometry-p3-3211.png). Souris : glisser sur les glyphes visibles du titre → sélection `""` ; glisser sur la 2e moitié visible de la ligne 1 → sélectionne tout le reste de la page (≈1 200 caractères, 3 paragraphes) ; seul un glisser DANS la boîte de 13 px (témoin) sélectionne le titre.
- Cause : pdf.css:541-563 ne reprend pas les règles CSS obligatoires du TextLayer de pdf.js 6 (pdf_viewer.css `.textLayer`) : `--total-scale-factor: calc(var(--scale-factor) * var(--user-unit))`, `span { font-size: calc(var(--text-scale-factor) * var(--font-height)); transform: rotate(var(--rotate)) scaleX(var(--scale-x)) scale(var(--min-font-size-inv)); }`, `[data-main-rotation="90"] { transform: rotate(90deg) translateY(-100%) }` etc. ; PageView.tsx:142 ne pose que `--scale-factor`. Les variables posées par pdf.js (pdf.mjs:14881, 15025, 15085) ne sont consommées par aucune règle (grep : 0 occurrence de `--font-height`/`--scale-x` dans src/).
- Impact aval : surlignage/soulignement/barré depuis la sélection (PdfWorkspace.tsx:603-642, quads tirés des rectangles de sélection), copier, « Lire à voix haute » de la sélection.
- Correction : importer `pdfjs-dist/web/pdf_viewer.css` (ou copier intégralement le bloc `.textLayer` : variables, rotation principale, `.endOfContent`, `.markedContent`) et donner au conteneur la classe `textLayer` ; poser aussi `--user-unit` ; test de non-régression : sélection d'une ligne au glisser = texte exact de la ligne.

## viewer-10 | P0 | bug | Au-delà du zoom « Largeur », toute l'interface s'élargit hors de la fenêtre : pas de défilement horizontal, zoom/navigation/recherche disparaissent
- Repro : `node 04-zoom-overflow.mjs` (1440x900) et `node 27-overflow-rootcause.mjs` (1366x768, écran de portable)
- Preuve : 1440 px, zoom 400 % : `canvasClientW 2429 = canvasScrollW 2429, canHScroll false, zoombar.x 2519, main.w 2763` ; molette horizontale `scrollLeft 0 → 0` ; capture out/04-zoom-400.png : la barre de navigation et le zoom ont disparu, la moitié droite de la page est inaccessible. 1366 px : dès 200 % `zoombarRight 1563 > 1366`. Correctif testé en CSSOM : `grid-template-columns: minmax(0,1fr)` sur `.pdfx` → `canvasClientW 1032, canvasScrollW 2429, canHScroll true, zoombar visible`.
- Cause : ui/workspace.css:52-55 — `.pdfx { display:grid; grid-template-rows: … }` sans `grid-template-columns` : colonne implicite `auto` dont la taille minimale = min-content du contenu ; combiné à pdf.css:461-467 `.pdfx-pages { min-width: min-content }`, la largeur des pages zoomées propage jusqu'à la racine au lieu de faire défiler `.pdfx-canvas`.
- Correction : `grid-template-columns: minmax(0, 1fr)` sur `.pdfx`/`.elx` (et `min-width:0` sur `.pdfx-main`) ; test : à 400 %, `scrollWidth > clientWidth` et barre d'outils dans la fenêtre.

## viewer-11 | P1 | bug | Changer le zoom (liste, Ctrl+-, Ctrl+0) fait perdre la page lue : de la page 50 on se retrouve page 86, 34 ou 94 ; le champ page reste faux
- Repro : `node 23-zoom-anchor.mjs word-250pages.pdf 50`
- Preuve : départ `pageAtCentre 50` (Largeur) → liste 100 % : `pageAtCentre 86, field "50", scrollTop 73231 inchangé` ; retour p.50 puis Ctrl+- (150 %) : `pageAtCentre 34` ; Ctrl+0 (Page entière) : `pageAtCentre 94, field "50"`.
- Cause : PdfWorkspace.tsx:494-495 `setScale` / 1133-1137 / 1677-1680 ne modifient que `view.scale`/`zoomMode` : aucune conservation d'ancre (scrollTop gardé en pixels alors que la hauteur de toutes les pages change) ; `current` n'est pas recalculé faute d'événement scroll.
- Correction : avant le changement d'échelle, mémoriser (page, fraction verticale/horizontale) au centre ou en haut du viewport ; après le rendu (useLayoutEffect sur scale), recalculer scrollTop/scrollLeft pour ramener ce point ; appliquer la même ancre au changement de mode et à la rotation de vue.

## viewer-12 | P2 | bug | Ctrl+molette ne zoome pas autour du pointeur : le point visé dérive de 166 pt
- Repro : `node 14-ctrl-wheel.mjs word-contrat.pdf` (5 crans Ctrl+molette au point (900,520))
- Preuve : point de page sous le pointeur avant `x 305,1 pt / y 192,4 pt` (175 %) → après `x 139,1 / y 195,3` (390 %) : `driftPt dx -166`. 5 images « squelette » (page blanche) pendant le zoom.
- Cause : PdfWorkspace.tsx:538-553 — le calcul `scrollLeft = px*ratio - offset` suppose un contenu qui commence en x=0 et grandit proportionnellement, en ignorant le centrage des pages (`align-items:center`, pdf.css:461-467) et le padding 22/24 px ; en plus `before = view.scale` est la valeur capturée par la closure (l'effet est réabonné à chaque rendu, l.557) et le rAF peut s'exécuter avant le commit React (scrollLeft borné à l'ancienne largeur) — et viewer-10 empêche de toute façon tout défilement horizontal.
- Correction : ancrer sur un point de PAGE (page + coordonnées pt sous le pointeur, via getBoundingClientRect de la page) et le reprojeter dans un useLayoutEffect après le changement d'échelle ; scale courant lu dans une ref ; zoom CSS immédiat (transform) puis re-raster différé (comme pdf.js).

## viewer-13 | P1 | parity-gap | Outils « Zoom sur une zone » (Z) et « Main » (H) du ruban sans aucun effet
- Repro : `node 15-tools-zoomarea-hand.mjs`
- Preuve : Zoom sur zone, rectangle tracé 300x90 px → `zoom 175 % → 175 %, scrollTop 0 → 0` ; Main, glisser 300 px vers le haut → `scrollTop 0 → 0` (le curseur « grab » change seulement).
- Cause : `zoomArea` n'existe que dans model/types.ts:460, Ribbon.tsx:251-255 et le raccourci PdfWorkspace.tsx:1738 — aucun gestionnaire ; `hand` = seulement la classe CSS `is-hand` (PdfWorkspace.tsx:2160, pdf.css:439-444) et la désactivation du calque texte (l.2199), aucun pointermove qui fait défiler.
- Correction : Main = pointerdown/pointermove sur `.pdfx-canvas` qui décrémente scrollLeft/scrollTop (+ inertie), et barre d'espace maintenue = main temporaire (Acrobat) ; Zoom zone = rectangle élastique puis `scale = min(viewW/rectW, viewH/rectH)` + ancrage du rectangle au centre ; clic simple = zoom avant, Alt/Ctrl+clic = arrière.

## viewer-14 | P1 | parity-gap | Modes « Une page », « Double page continue » et « page de couverture » inexistants : Une page = Continu, les deux clics Double page = même rendu
- Repro : `node 13-modes.mjs word-contrat.pdf`
- Preuve : « Une page » : `cls pdfx-canvas--single, mounted 7, scrollH 10508` identique au continu (toutes les pages empilées) ; Double page 1er clic (`facing`) et 2e clic (`facingContinuous`) : `scrollH 3032`, positions identiques ; p1 et p2 côte à côte (pas de couverture isolée) alors que `spreadCover: true` est l'état par défaut.
- Cause : PdfWorkspace.tsx:1139-1147 ne change que `view.mode` ; seul pdf.css:469-476 distingue les modes (flex-wrap pour facing*) ; aucune règle pour `--single` ; `spreadCover`, `scrollWrapped`, `showRulers`, `fullscreen` (state.ts:21-25) ne sont lus nulle part (grep). Le flex-wrap apparie les pages au hasard de la largeur : dès que 2 pages ne tiennent plus (zoom > ~86 %), le mode double page redevient une colonne.
- Correction : Une page = ne rendre que la page courante (PageDown/molette en bout de page = page suivante) ; Double page = grille de paires calculées (avec option couverture : p1 seule à droite), défilement par paire en non-continu ; défilement horizontal/enveloppé si on veut la parité pdf.js.

## viewer-15 | P2 | bug | Liens : zone cliquable décalée de la CropBox (20×30 pt ici) et destination /XYZ ignorée (on arrive en haut de page)
- Repro : `node gen_links.mjs && node 22-links-geometry.mjs` (gen/links-geometry.pdf : p1 CropBox [20 30 400 575], p2 /Rotate 90, p3 cible /XYZ 0 150)
- Preuve : p1 rectangle peint sous le lien URI `x 80, y 145` mais bouton du lien `x 100, y 115` (décalage +20/-30 px à 100 %) ; idem lien interne (peint y 245, bouton y 215) ; p2 /Rotate 90 correct (700,100). Clic du lien vers p3 /XYZ y=150 : `page3Top 16` (haut de page, 145 px sous le bord, cf. viewer-07), destination à `706 px` dans un viewport [161,874] au lieu d'arriver en haut.
- Cause : PageView.tsx:177-184 — `x: min(x1,x2)`, `y: p.size.h - max(y1,y2)` sans soustraire l'origine de CropBox (`engine.pages[i].ox/oy`, engine.ts:204-205) ; PageView.tsx:257-258 ne transmet que `resolved.page` (le `y` calculé par engine.resolveDest l.353-357 est jeté) ; PdfWorkspace.tsx:2205-2206 `goTo(target.page)` sans y.
- Correction : soustraire (ox, oy) avant la conversion ; transmettre `{page, y, x, zoom}` et gérer /XYZ, /FitH, /FitR, /Fit ; ajouter l'historique Précédent/Suivant (Alt+←) comme Acrobat.


## (reprise n°3 — 2026-09-24) constats ajoutés
## viewer-16 | P1 | perf | Ouverture : 2,6 s avant la 1re page sur edge-1000 (pdf.js seul : 0,21 s) — séquence bloquante getPage×N + getAnnotations×N puis montage de 1000 pages
- Repro : `node 28-open-milestones.mjs edge-1000pages.pdf` (3210) ; témoin pdf.js même version, worker chaud : `python refserver.py &` puis `node 25-open-sequence.mjs`
- Preuve (appli, 3210) : edge-1000 → `firstPageMounted 1328 ms, page1Text 2327, page1Ready 2624 ms`, longues tâches `1029+300, 1330+420, 1806+122, 1929+126, 2127+174 …` (1344 ms au total) ; word-250 → `page1Ready 1128 ms` ; word-contrat → 619 ms. Référence pdf.js 6.2 (ref-open.html) : `minimal_firstPaint 214 ms` (edge-1000), 263 ms (word-250) ; la seule séquence Elium avant montage React coûte `elium_getPageLoop 359 + meta/fields/sig 24 + outline+annotLoop 254 = 652 ms` sur edge-1000.
- Cause : core/engine.ts:196-209 boucle SÉQUENTIELLE `await doc.getPage(i+1)` sur toutes les pages (aller-retour worker ×1000) juste pour lire les tailles ; engine.ts:214-219 `getFieldObjects()` + getAnnotations des 8 premières pages ; PdfWorkspace.tsx:320-341 `await next.annotations(page.from)` sur TOUTES les pages (import des annotations) avant `reset()` ; puis montage des 1000 PageView + 1000 IntersectionObserver (tâche de 420 ms, cf. DOM 28 000 nœuds déjà connu) ; la page 1 n'est demandée qu'après tout cela.
- Correction : afficher dès getDocument + getPage(1) (tailles des autres pages = celle de la page 1 en provisoire, puis mises à jour par lots via `Promise.all` par tranches de 50, ou lecture directe des MediaBox avec pdf-lib) ; import des annotations paresseux par page à l'affichage (ou en tâche de fond `requestIdleCallback`) ; virtualisation (viewer-03) ; worker pré-chauffé (viewer-02).

## viewer-17 | P1 | bug | « Page entière » recalcule le zoom de TOUT le document sur la page courante : le zoom saute (78→110→107→78 %) et « Page suivante » recule
- Repro : `node 29b-fit-per-page-nav.mjs fitPage` (mixed-geometry.pdf, 3210) ; `node 29-fit-per-page.mjs` (même chose à la molette)
- Preuve : 6 clics sur « › » depuis la p.1 : zoom/champ `78 %/1 → 110 %/2 → 107 %/3 → 78 %/4 → 107 %/3 → 78 %/4 → 121 %/5` : le zoom global change à chaque page et la navigation revient en arrière (4 → 3) car le changement d'échelle déplace le contenu sous le scrollTop inchangé (cf. viewer-11) et onScroll réélit une page antérieure. (Largeur : même mécanisme ; l'emballement connu à 1000 % sur mixed-geometry vient en plus de viewer-10 : `clientWidth 1106 → 8468` mesuré par 03-fitwidth-mixed.mjs, boucle ResizeObserver → applyFit.)
- Cause : PdfWorkspace.tsx:464-481 `applyFit` lit `pages[view.current - 1]` et dépend de `view` entier (useCallback deps l.481) → réexécuté à chaque changement de page courante (useEffect l.483-485) ; aucune ancre de défilement (viewer-11).
- Correction : calculer l'échelle « Page entière/Largeur » une fois (sur la page courante au moment du choix, ou sur la plus grande page du document comme pdf.js), ne la recalculer que sur redimensionnement du conteneur (ResizeObserver) ou changement de mode ; ne jamais la recalculer sur un changement de page courante ; ancrer le défilement lors d'un recalcul.

## viewer-18 | P1 | perf | Saut à une page lointaine (Début/Fin, champ, signet) : 1,3 à 2,6 s, et 16 à 60 pages intermédiaires rastérisées pour rien
- Repro : `node 30-jump-timing.mjs edge-1000pages.pdf 900` et `node 30-jump-timing.mjs word-250pages.pdf 200` (3210 ; champ rempli d'un seul coup avec fill() pour neutraliser viewer-06)
- Preuve : edge-1000 → champ « 900 » : page peinte à l'écran après `2554 ms` (21 longues tâches, 1433 ms) ; Fin → `2148 ms` ; Début → `1873 ms`. word-250 → champ « 200 » `1539 ms` avec `rasterised 1 → 60` (59 pages survolées rendues), Fin `1341 ms` (+34 pages), Début `1453 ms` (+36 pages). Acrobat/pdf.js : saut instantané, seule la page cible est rendue.
- Cause : PdfWorkspace.tsx:505-515 `goTo` → `scrollTo({ behavior: "smooth" })` (+ `scroll-behavior: smooth` sur `.pdfx-canvas`, pdf.css:436) : l'animation traverse toutes les pages intermédiaires, chacune devient `visible` et soumet un rendu (PageView.tsx:93-123) qui n'est annulé que si elle ressort à temps ; et ces rasters ne sont jamais libérés (viewer-04). Priorité = index de page (PageView.tsx:113), pas la distance au viewport, et `RenderScheduler.reprioritise` (render.ts:83) n'est jamais appelé.
- Correction : navigation programmée en `behavior: "instant"` (ou smooth seulement si la distance < 1 écran) ; supprimer `scroll-behavior: smooth` du conteneur ; ne soumettre un rendu qu'après stabilisation (~100 ms sans scroll) pour les pages traversées ; priorité = distance au centre du viewport, recalculée via reprioritise.

## viewer-19 | P1 | bug | À fort zoom, PageDown/PageUp sautent une page entière : à 400 %, 79 % de la page 1 ne sont jamais affichés
- Repro : `node 31-pagedown-zoomed.mjs` (word-contrat, 3210, zoom 400 %)
- Preuve : hauteur page 3368 px, viewport 713 px ; PageDown depuis le haut de la p.1 → `scrollTop 0 → 3553` (champ 2) : `fractionOfPage1Skipped 0.79`. Témoin : Espace (comportement natif du navigateur) → `+623 px` (un écran), Flèche bas `+40 px`.
- Cause : PdfWorkspace.tsx:1706-1713 — `PageDown → goTo(view.current + 1)`, `PageUp → goTo(view.current - 1)` : navigation par page quel que soit le zoom (et avec l'erreur d'offset viewer-07 + l'imprécision viewer-08).
- Correction : en mode continu, PageDown/PageUp = défilement d'un écran moins un recouvrement (comme Acrobat et le navigateur) ; ne passer à la page suivante que si le bas de la page est visible (mode Une page) ; Ctrl+PageDown ou → = page suivante.

## viewer-20 | P1 | bug | Texte CJK à police non embarquée totalement invisible (aucun glyphe peint)
- Repro : `python gen_fonts.py` (produit gen/cjk-nonembedded.pdf : Type0 /UniJIS-UCS2-H, CIDFont Adobe-Japan1 sans FontFile — cas réel des PDF japonais/chinois de bureautique) ; `python refserver.py &` ; `node 19-fidelity.mjs cjk` ; comparaison visuelle out/cmp-cjk.png (gauche = pdf.js avec ressources, droite = Elium)
- Preuve : `inkRefPct 0.47` vs `inkEliumPct 0.15` ; la ligne « 日本語のテキスト：請求書 » est absente du rendu Elium (seule la ligne latine reste) ; console : `loadFont - translateFont failed: "Ensure that the cMapUrl API parameter is provided."`. Même symptôme attendu dans le calque texte/recherche (pas de décodage CMap).
- Cause : core/engine.ts:177-183 `getDocument({ data, password, useSystemFonts: true })` sans `cMapUrl`/`cMapPacked` (cause déjà connue ; impact concret : texte CJK perdu). Les cmaps sont pourtant livrées dans pdfjs-dist/cmaps (servies en local, compatibles CSP 'self').
- Correction : copier `pdfjs-dist/cmaps` et `standard_fonts` dans le build (vite-plugin-static-copy) et passer `cMapUrl: new URL("./pdfjs/cmaps/", location.href).href, cMapPacked: true, standardFontDataUrl: …` (local, donc conforme « local-first » et à la CSP `default-src 'self'`) ; test de rendu avec ce PDF.

## viewer-21 | P2 | bug | Polices standard non embarquées (ZapfDingbats, Symbol) remplacées : pictogrammes de cases/coches différents
- Repro : `node 19-fidelity.mjs std14` (gen/std14-symbol-zapf.pdf) ; out/cmp-std14.png
- Preuve : `pctPixelsDiff 0.46, inkRefPct 0.75 vs inkEliumPct 0.65` ; visuellement les coches ✓✔, croix ✗✘ et puces ■● de ZapfDingbats sont dessinées avec une autre police (plus fines, ■ et ● plus petits) ; console `Ensure that the standardFontDataUrl API parameter is provided` / `Cannot load system font: ZapfDingbats`. (Helvetica/Times/Courier non embarquées : 0 % d'écart — substitution système correcte.)
- Cause : engine.ts:177-183 sans `standardFontDataUrl` (les polices Foxit/Liberation livrées par pdfjs-dist ne sont pas utilisées).
- Correction : même correctif que viewer-20 (standardFontDataUrl local).

## viewer-22 | P2 | parity-gap | Au-delà de 400 % (HiDPI) / 800 % (écran standard) le raster est plafonné à 18 Mpx : texte flou, pas de rendu par tuiles
- Repro : `node 08-hidpi-sharpness.mjs word-contrat.pdf` (dsf 1 / 1,25 / 2) ; `node 09-sharp-visual.mjs` (captures out/09-dsf2-z200.png vs out/09-dsf2-z800.png)
- Preuve : bitmap plafonné à `3567x5045` (≈18 Mpx) : dsf 1 à 800 % `rasterPerPhysPx 0.75` ; dsf 1,25 à 800 % `0.6` ; dsf 2 à 400 % `0.75`, à 800 % `0.37` (1 pixel de rendu étiré sur ~2,7 pixels physiques) — bords des glyphes visiblement baveux sur out/09-dsf2-z800.png ; chaque page gardée à 72 Mo (cf. viewer-04). Le zoom maximum est 1000 % (state.ts:44) contre 6400 % dans Acrobat.
- Cause : core/render.ts:15 `MAX_CANVAS_PIXELS = 18_000_000` + `effectiveDpr` (render.ts:49-55) réduit le DPR pour TOUTE la page ; aucun rendu de la seule zone visible.
- Correction : au-delà d'un seuil, rendre un canvas « détail » limité au viewport (pdf.js 5+ : `enableDetailCanvas` / `PDFPageDetailView`, ou `page.render` avec transform/viewport décalé sur la région visible) par-dessus un fond basse résolution ; relever MAX_SCALE à 64.

## viewer-23 | P3 | ux | Chaque changement de zoom fait clignoter la page en blanc (1-2 images) au lieu d'étirer l'ancien rendu
- Repro : `node 32-zoom-flash.mjs edge-web.pdf 1` ; `node 32-zoom-flash.mjs word-contrat.pdf 2`
- Preuve : sur 4 changements de zoom, 1 à 2 images par changement avec la page 1 en squelette/blanche (`firstBadMs 43-240`) ; plus long sur les pages lourdes et avec viewer-12 (5 images squelette pendant un Ctrl+molette).
- Cause : core/render.ts:103-114 redimensionne le canvas visible (`canvas.width = …` efface le bitmap) et le peint en blanc AVANT le rendu ; PageView.tsx:99 `setRendered(false)` réaffiche le squelette.
- Correction : rendre dans un canvas hors écran puis permuter (comme pdf.js : l'ancien canvas reste affiché, étiré en CSS, jusqu'à la fin du nouveau rendu) ; ne pas repasser en squelette sur un simple changement d'échelle.

## viewer-24 | P2 | parity-gap | Les numéros de page logiques du fichier (/PageLabels : i, ii, 1, 2…) sont ignorés à l'affichage
- Repro : `node gen_labels.mjs && node 36-page-labels.mjs` (gen/page-labels.pdf, 3210) ; témoin `npx tsx 36b-labels-pdfjs.mts`
- Preuve : pdf.js `getPageLabels() → ["i","ii","1","2","3"]` ; Elium affiche `pageBadges ["1","2","3","4","5"]`, vignettes `1..5`, champ `1 / 5`. Acrobat affiche « i (1 sur 5) » et accepte la saisie « ii ».
- Cause : aucun appel à `getPageLabels` dans web-studio/src (grep : 0) ; `pageLabel()` (model/doc.ts:217-219) ne connaît que les libellés créés dans la session ; PdfWorkspace.openBytes (l.310-360) ne les importe pas.
- Correction : dans PdfEngine.open, lire `doc.getPageLabels()` et initialiser `pages[i].label` ; accepter un libellé dans le champ de navigation (après correction viewer-06).

## viewer-25 | P2 | parity-gap | « Plein écran » (F11) garde toute l'interface : pas de mode lecture ni de mode présentation
- Repro : `node 33-fullscreen.mjs` (word-contrat, 3210)
- Preuve : après clic sur « Plein écran » : `fullscreenElement "pdfx …"` mais `topbar, ribbon, rail, sidePanel, statusbar : true`, zone de page `1106x729` = 62 % de l'écran (identique à avant) ; flèche droite → page inchangée (`1`).
- Cause : PdfWorkspace.tsx:1156-1160 fait seulement `document.querySelector(".pdfx").requestFullscreen()` ; l'état `fullscreen` de state.ts n'est lu nulle part (cf. viewer-14).
- Correction : mode lecture (Ctrl+H Acrobat : masquer ruban/panneaux, barre flottante) et mode Plein écran (Ctrl+L : seul le canevas, page entière, une page par écran, ←/→/clic pour avancer, Échap pour sortir) ; appliquer `requestFullscreen` sur `.pdfx-canvas` avec une classe qui masque le chrome.

## viewer-26 | P0 | bug | Une seule note dans le fichier suffit à effacer du rendu TOUS les champs de formulaire remplis (et toute annotation non importée : filigrane…)
- Repro : `node gen_form_comment.mjs && node 38-annotmode-hides-widgets.mjs` (3210) — gen/form-filled.pdf = form-acro.pdf dont les 13 champs sont remplis (apparences générées) ; gen/form-filled-plus-note.pdf = le même + 1 note (Text) + 1 annotation Watermark « COPIE »
- Preuve : raster page 1 : `canvasInkPx 24557` (sans note) → `2053` (avec note) ; `htmlFieldsOverPage 0` dans les deux cas ; capture côte à côte out/cmp-38.png : à droite, toutes les valeurs (Nom, Prénom, Adresse, Motif, date), la case cochée, la radio, la liste et les cadres des champs ont disparu ; le filigrane « COPIE » n'est jamais peint ; toast « 1 annotation(s) importée(s) ». Cas courant : formulaire rempli ou contrat signé portant un commentaire de relecture.
- Cause : PdfWorkspace.tsx:2200 `annotationMode={state.importedAnnots ? 0 : 1}` — dès qu'UNE annotation importable existe (ops/import-annots.ts:615 `hasImportableAnnots`), toutes les pages sont rendues avec `AnnotationMode.DISABLE` (render.ts:123-131), ce qui supprime aussi les widgets de formulaire, liens, et tous les sous-types non importés (Watermark, FileAttachment, Caret, Redact, Stamp sans image résolue…) ; aucun calque HTML ne redessine les champs en mode lecture.
- Correction : ne masquer QUE les annotations importées : rendre avec `AnnotationMode.ENABLE` (ou ENABLE_FORMS + calque de formulaires) à partir d'une copie des octets dont `stripImportedAnnots` (import-annots.ts:627) a retiré les seules annotations importées, ou via la liste d'ids masqués de l'annotationStorage de pdf.js ; test de non-régression : formulaire rempli + 1 note → valeurs visibles.

## viewer-09 (complément reprise n°3) — « Pivoter la vue » aggrave le désalignement du calque texte
- Repro : `node 37-rotate-view-textlayer.mjs` (word-contrat, 3210) ; capture out/37-rotate-view-textlayer.png (spans surlignés en rouge)
- Preuve : après rotation de vue, page `1042x737`, `data-main-rotation="90"` posé par pdf.js mais `transform: none` sur le calque et les spans ; span du titre « Contrat de prestation de services » en `x 124, y 80, 191x13` (horizontal, en haut à gauche) alors que le titre est peint verticalement sur le bord droit : `inkPixelsUnderSpan 103 / 2480`. Le calque entier est horizontal au milieu de la page tournée → sélection/recherche/surlignage inutilisables après rotation.
- Cause/correction : identiques à viewer-09 (règles `.textLayer[data-main-rotation]` de pdf_viewer.css absentes de pdf.css:541-563).

## viewer-27 | P3 | perf/mémoire | Les octets du fichier sont copiés 4 fois en mémoire à l'ouverture
- Repro : lecture de code (evidenceType code-reading)
- Preuve : core/engine.ts:176 `const mine = bytes.slice()` + engine.ts:178 `data: bytes.slice()` (copie transférée au worker) ; PdfWorkspace.tsx:296 `bytesRef.current = raw.slice()` ; `raw` lui-même reste référencé (pendingPassword / closure). Pour un scan de 300 Mo : ~1,2 Go de tampons.
- Correction : une seule copie conservée (partagée entre engine.bytes et bytesRef), transférer à pdf.js une copie unique ; libérer `raw` après ouverture.

## viewer-28 | P1 | desktop-env | Sous la CSP de bureau, une page image insérée s'affiche BLANCHE dans le visualiseur (pas seulement dans les vignettes)
- Repro : `node 39-image-page-csp.mjs http://127.0.0.1:3210/` puis témoin `node 39-image-page-csp.mjs http://127.0.0.1:3211/` (word-contrat + gen/photo.png via l'entrée « image/* »)
- Preuve : 3210 → page 8 créée, `<img class="pdfx-page__image" src="data:image/png;base64,…">` `naturalWidth 0`, 8 violations CSP ; 3211 → `naturalWidth 600` (image visible). Captures out/39-image-page-csp.png / -nocsp.png.
- Cause : PdfWorkspace.tsx:1515-1522 lit l'image en `readAsDataURL` et la stocke dans `page.image` ; PageView.tsx:206-208 l'affiche en `<img src={p.image}>` ; la CSP du lanceur (`default-src 'self'`, pas d'`img-src data: blob:`) bloque les URL data: — même cause que le blocage connu des vignettes. (Même mécanisme probable pour l'outil « image » : PdfWorkspace.tsx:1529-1550 attend `img.onload` d'une URL data:, qui ne se déclenche pas sous cette CSP.)
- Correction : ajouter `img-src 'self' data: blob:` à la CSP du lanceur (installer/elium_launcher.py) ET/OU convertir en `URL.createObjectURL(file)` (blob:) + autoriser blob: ; test e2e sous la CSP réelle.
