# F1 — fondation du nouveau module PDF (branche `pdf-rebuild`, worktree `elium-wt-pdf`)

Journal de reprise. `git log pdf-rebuild` = vérité sur ce qui est commité.

## Décisions d'architecture (fixées)
- Viewer = composants pdf.js (`PDFPageView` de `pdfjs-dist/web/pdf_viewer.mjs`) pilotés par NOTRE file de
  rendu (port de `PDFRenderingQueue`/`PDFPageViewBuffer`, non exportés) + NOTRE mise en page virtualisée
  (`core/viewer/layout.ts`, pur). `pdf_viewer.mjs` lit `globalThis.pdfjsLib` à l'évaluation → import dynamique
  après `pdfjs-dist` (`core/viewer/lib.ts`).
- Échelle Elium = px CSS / pt ; `PDFPageView.scale` = échelle / PDF_TO_CSS_UNITS ; `--scale-factor` = échelle.
- Couches Elium (AnnotLayer, ContentEditLayer, ContentEditPreview, FormLayer) rendues DANS le slot de page
  (`renderOverlay`), mêmes coordonnées que l'ancien PageView — code de ces couches inchangé.
- Annotations importées : masquées côté worker via `annotationStorage.modifiedIds` (ids par page) ; couche HTML
  pdf.js = liens seulement (CSS). Le masque ne bloque le 1er rendu que s'il est actif.
- Redessin de contenu (calques, masque) = `reset({keep…})` (update() seul ne rafraîchit pas le raster de base
  au-delà du budget canevas).
- Bug « Largeur 1000 % » : cause = boucle CSS (piste `auto` de la grille `.pdfx`) ; corrigé (minmax(0,1fr),
  contain: strict) + fit pur testé + boîte d'ajustement indépendante des barres (scrollbar-gutter: stable),
  cible d'ajustement suivie par id de page.
- Vignettes : canevas + ImageBitmap (core/thumbs.ts), jamais d'URL data: → indépendant de la CSP.
- Octets du fichier : une seule copie (engine.bytes partagée par l'espace de travail).

## Fait (tout commité sur pdf-rebuild, vérifié sous CSP port 3230)
- 8531a14 assets locaux + ouverture instantanée ; 517a981 / 24e2d3b layout, file, contrôleur, PageStack ;
  8e4964f vignettes virtualisées ; 770bf65 bug maxLen (champs non saisissables) ; fa40c58 CSP lanceur + tests ;
  502d7ce suppression PageView/RenderScheduler + tests ; 83c3da7 perf/ajustement ; b01bd4d is-ready.
- Sondes (harness/f1/) : probe.mjs (corpus), interact.mjs (15/15 OK), modes.mjs, layers.mjs, layers-zoom.mjs,
  print.mjs, bench.mjs, timeline.mjs, heapsnap.mjs.
- Mesures finales (edge-1000pages, CSP) : DOM 515 (app entière), tas après GC 19,8 Mo (app vide 12 Mo),
  56 i/s, 0 longue tâche, saut p.700 35-45 ms, 1er rendu 120-140 ms (in-page). Ancien : 28 384 nœuds,
  51-58 Mo, saut 1 736 ms. Prototype brut : 1 170 nœuds, 6-9 Mo, saut 21-32 ms.

## Reste / non vérifié
- Hauteur du ruban variable selon l'onglet (713 vs 729 px) → zoom d'ajustement qui bouge de ~2 % au changement
  d'onglet (préexistant, Ribbon hors périmètre).
- groupBlocks (mode Modifier) fusionne une page entière de word-contrat en 1 bloc (préexistant).
- OCR (Tesseract) sous CSP : worker blob: autorisé mais scripts/langues depuis CDN → probablement cassé hors ligne.
- desktop/src/app.py (legacy PySide6, pas utilisé par elium.spec) : CSP non modifiée.
- XFA, SignPlacementPreview (Drive) non testés à l'écran.

## Correctifs de la relecture F1 (en cours — reprise possible depuis ici)
Sondes : `harness/f1fix/` (copies des scripts des relecteurs + `interact.mjs` étendu : 19 contrôles dont rotation).
- FAIT (ef4f893) : calques texte/liens pivotés (CSS data-main-rotation) ; course à l'ouverture (génération
  avant l'await, shownGeneration pour le travail de fond) ; vignettes retenues tant que la vue a du travail
  ou qu'un défilement est en cours + rendu coopératif + copie depuis le canevas de la vue ; page courante
  hors état React (ui/currentPage.ts) + emplacements/calques mémorisés ; volet/Organiser via
  ui/useListWindow.ts + cellules memo ; cache d'images borné/fermé ; zoom affiché en taille réelle (ZOOM_UNIT).
- FAIT (fe57622, reprise 25/09 ~01:05, vérifié) : whenIdle (volet suit la page quand la vue est au repos),
  NO_TEXT_A11Y, prefetch getPage au saut. Vérifié sous CSP 3230 : interact 19/19, links/rot/geom OK
  (IoU surlignage 0,85-0,96 sur pages pivotées), race-open 6/6 OK, vitest 1 787 OK.
- FAIT (fada524) : priorités de vignettes dynamiques (position actuelle à l'écran) → Organiser x4 : 2,3 s → 0,7 s.
- MESURÉ, ÉCARTÉ/CLOS : longues tâches à l'ouverture = 0 à CPU normal (4 fichiers, 4 passes) ; mémoire GPU 400 %
  à taille CSS égale (zoommem2.mjs, 3 passes, processus de CE navigateur seulement) : ΔGPU F1 +207…+261 (volet),
  +169…+189 (sans volet) vs prototype +257…+306 → non confirmé. Saut A/B entrelacé par événement (jumpab.mjs) :
  x1 F1 15 ms vs proto 14 ; x4 88 vs 73 (le banc rAF gonflait F1).
- Outils ajoutés : harness/f1fix/jumpab.mjs, jumptrace.mjs, zoommem2.mjs, memproc.mjs ; prototype servi sous
  /spike/ du même serveur 3230 (recopier harness/spike/dist dans web-studio/dist/spike après chaque build).
- FAIT (337579c) : squelette de page sans animation de background-position (repeinte/image) → pulsation
  d'opacité différée (compositeur) ; ouverture détruite si l'espace de travail est démonté.
  scrollab x4 (3 passes entrelacées) : doux volet ouvert 49 / fermé 54 / proto 54 i/s ; rapide 24 / 27 / 29.
- Fins de ligne : les fichiers src/pdf du worktree étaient en CRLF (autocrlf) → convertis en LF dans la copie
  de travail (aucun changement de contenu) : `prettier --check` passe sans option.
- PASSE FINALE (build 337579c, CSP 3230) : probe corpus 11/11 sans erreur CSP ; interact 19/19 ; lien pivoté OK ;
  IoU surlignage 0,85-0,96 (plain/viewrot/crop/zoom) ; import/race-import OK ; race-open 4/4 ; perf x1 edge-1000 :
  DOM 515, tas 24,9 Mo, 60 i/s, 0 longue tâche (ouverture comprise), saut p.700 37 ms (sondage rAF) ;
  vitest 143 fichiers / 1 788 tests, tsc, eslint src/pdf, prettier --check src/pdf : verts.
- CORRECTION DE LA RELECTURE F1 : TERMINÉE (commits ef4f893, fe57622, fada524, 337579c). dist/spike retiré.
- Autosave relancé en arrière-plan le 25/09 ~01:05 (bash pdf-rebuild-work/autosave.sh).
