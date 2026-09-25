export const meta = {
  name: 'pdf-foundation',
  description: 'Fondation du nouveau module PDF : moteur d’affichage virtualisé sur pdf.js PDFPageView, assets pdf.js locaux, CSP bureau, miniatures',
  phases: [
    { title: 'Construire', detail: 'un agent construit la fondation dans le worktree pdf-rebuild' },
    { title: 'Revue', detail: 'deux relecteurs adversariaux : régressions/correction et performance sous CSP' },
    { title: 'Correction', detail: 'corrige les constats confirmés' },
  ],
}

const WT = 'C:\\Users\\ludov\\Downloads\\elium-main\\elium-wt-pdf'
const HARNESS = 'C:\\Users\\ludov\\AppData\\Local\\Temp\\claude\\C--Users-ludov-Downloads-elium-main\\72cb6376-9846-4238-a19b-d350714b8a76\\scratchpad\\harness'

const CONTEXT = `Projet : Elium, suite bureautique locale (React 18 + TypeScript + Vite 5, pdfjs-dist 6.2.108, pdf-lib 1.17). L'utilisateur trouve le module PDF lent, peu fiable et loin d'Adobe Acrobat ; il a choisi « l'option la plus performante » : reconstruire le cœur d'affichage sur les composants de pdf.js (ceux de la visionneuse de Firefox).

TU TRAVAILLES DANS LE WORKTREE GIT ${WT} (branche pdf-rebuild). N'écris RIEN dans C:\\Users\\ludov\\Downloads\\elium-main\\elium-main (dépôt principal, utilisé par d'autres agents) SAUF ce qui est demandé explicitement. web-studio/node_modules du worktree est une JONCTION vers celui du dépôt principal : ne lance pas npm install, ne le supprime jamais. Commits : sur la branche pdf-rebuild uniquement, messages en français (convention du dépôt, ex. "feat(pdf): ..."), terminés par la ligne "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>". Ne pousse pas.

Banc d'essai : lis ${HARNESS}\\README-HARNESS.md (corpus de vrais PDF dans ${HARNESS}\\corpus, Playwright avec channel "msedge", serveur CSP ${HARNESS}\\csp_server.py). Pour tester TON build sous la CSP de bureau : \`cd ${WT}\\web-studio && npx vite build\` (ou npm run build) puis lance \`<repo>\\.venv\\Scripts\\python.exe ${HARNESS}\\csp_server.py 3230 ${WT}\\web-studio\\dist\` en arrière-plan (port 3230 réservé pour toi ; 3210/3211/3220 appartiennent à d'autres). ⚠️ la CSP de ce serveur est celle de installer/elium_launcher.py du DÉPÔT PRINCIPAL ; si tu modifies la CSP dans le worktree, teste aussi avec ta version (le serveur importe elium_launcher depuis ${HARNESS}\\..\\..\\...\\elium-main\\installer : copie csp_server.py dans ton dossier et fais pointer REPO vers ${WT}). Ne supprime jamais les jonctions ${HARNESS}\\ws et ${HARNESS}\\node_modules.
RÉSILIENCE : une première tentative a été interrompue par une limite de facturation (rien n'avait été écrit). Fais des commits WIP réguliers sur pdf-rebuild (au moins après chaque grande étape : assets, engine, layout, PageStack, miniatures, CSP) et tiens un journal ${WT}\..\f1-progress.md (fait / en cours / reste) pour qu'une reprise soit possible. Vérifie au démarrage si ce journal ou des commits existent déjà et reprends-les.
Mesures de référence (1000 pages, edge-1000pages.pdf, sous CSP) : actuel = 28 400 nœuds DOM, 57-83 Mo de tas JS, 38 i/s au défilement avec longues tâches jusqu'à 98 ms ; prototype PDFViewer brut de pdf.js = 1 170 nœuds, 9 Mo, 52-54 i/s, saut à la page 700 en 55 ms. Prototype : ${HARNESS}\\spike\\main.js et bench.mjs (réutilise-les).
Tests : \`cd ${WT}\\web-studio && npx vitest run\` (tout doit rester vert ; les tests PDF sont tests/pdf-*.test.ts et src/pdf/*.test.ts), \`npx tsc --noEmit -p .\` (ou npm run build), \`npx eslint src/pdf\`, \`npx prettier --check "src/pdf/**/*.{ts,tsx,css}"\`.`

const BUILD = `${CONTEXT}

=== MISSION : FONDATION F1 du nouveau module PDF ===
Lis d'abord en entier : web-studio/src/pdf/core/engine.ts, core/render.ts, core/coords.ts, ui/PageView.tsx, ui/state.ts, et dans ui/PdfWorkspace.tsx tout ce qui touche l'affichage (scrollRef, onScroll, visiblePages, stableSizeOf, rotationOf, applyFit, zoom, goTo, textLayers, hitQuads, thèmes, ocConfig, annotationMode) ; ui/Sidebar.tsx (miniatures) ; ui/Organize.tsx (vignettes) ; node_modules/pdfjs-dist/web/pdf_viewer.mjs (classes PDFPageView, PDFRenderingQueue, PDFPageViewBuffer, PDFViewer : comprends comment Firefox virtualise, priorise, et utilise le « detail canvas » pour le rendu par tuiles à fort zoom).

À livrer (qualité production, pas un prototype) :
1. Assets pdf.js LOCAUX : un petit plugin Vite (dans vite.config.ts ou web-studio/scripts/) qui copie depuis node_modules/pdfjs-dist les dossiers wasm/, cmaps/, standard_fonts/, iccs/ (+ build/pdf.sandbox.min.mjs pour le futur JavaScript de formulaire) vers dist/pdfjs/ au build et les sert en dev — AUCUN binaire commité. Un module core/assets.ts qui calcule les URL (relatives à import.meta.env.BASE_URL / document.baseURI, compatible file servi par le lanceur de bureau). engine.ts passe wasmUrl, cMapUrl + cMapPacked, standardFontDataUrl, iccUrl, enableHWA. Vérifie : scan-jpx.pdf s'affiche (JPEG2000), CJK d'edge-web OK, Helvetica non embarquée de mixed-geometry OK. Fais la même chose pour src/drive-cloud/ui/SignPlacementPreview.tsx et src/detector/ingest/fromPdf.ts s'ils ouvrent pdf.js (factorise une fonction commune d'options getDocument).
2. Ouverture instantanée : PdfEngine.open ne doit plus faire getPage() séquentiellement sur TOUTES les pages ni bloquer sur la détection signature/formulaire. Géométrie paresseuse : taille de la page 1 connue immédiatement, les autres estimées puis complétées en tâche de fond par lots (et à la demande quand une page devient visible), avec un événement pour que la mise en page se corrige sans saut visible de la page courante. Les infos « signé / a un formulaire / XFA » calculées en arrière-plan. Garde l'API publique d'engine compatible avec le reste du module (ops, dialogs) ou adapte tous les appelants.
3. Moteur de défilement virtualisé : core/viewer/layout.ts (PUR, testé en vitest : décalages par préfixes pour les modes continu vertical, page unique, deux pages, deux pages avec couverture ; gap ; recherche binaire de la plage visible ; page « courante » = la plus visible ; ancrage lors d'un changement de zoom ou de tailles) + ui/PageStack.tsx qui remplace le rendu actuel des pages dans PdfWorkspace : seules les pages dans la fenêtre visible ± marge sont montées (DOM O(visible)), positionnement absolu, une instance pdf.js PDFPageView par page montée (canvas + detail canvas/tuiles + couche texte + couche d'annotations pdf.js pour les liens), tampon LRU (~10 pages rendues gardées en mémoire comme PDFPageViewBuffer), file de rendu priorisée (visibles d'abord, puis la suivante dans le sens du défilement, rendu coopératif via onContinue comme PDFRenderingQueue, annulation des pages sorties), zoom instantané par transformation CSS puis re-rendu net (comme PDFPageView.update), zoom Ctrl+molette ancré sous le curseur, HiDPI plafonné intelligemment (maxCanvasPixels adapté), rotation par page (page /Rotate + rotation utilisateur), pages insérées (from === null : vierge ou image) rendues par nous, thèmes de lecture (utilise pageColors de pdf.js ou filtres CSS existants), calques (optionalContentConfig).
   Contrat pour les couches Elium : PageStack reçoit une fonction renderOverlay(page, index, {size, rotation, scale}) dont le résultat React est rendu (portail) au-dessus de la page, exactement là où PageView rendait ses children aujourd'hui — AnnotLayer, ContentEditLayer, ContentEditPreview, FormLayer doivent continuer à fonctionner SANS modification de leur code (même empilement, mêmes coordonnées). Conserve : surlignage des résultats de recherche (hits), onTextLayer (la sélection de texte → quads de core/text.ts doit continuer à marcher avec la couche texte de pdf.js), activation des liens (interne → goTo, externe → confirmation existante), onVisible/page courante, annotationMode (quand state.importedAnnots est vrai, pdf.js ne doit PLUS peindre les annotations de balisage importées, mais doit continuer d'afficher liens et widgets de formulaire : utilise le mécanisme modifiedIds de l'AnnotationStorage de pdf.js — voir pdf.mjs \`get modifiedIds\` et la façon dont render() le transmet — pour masquer précisément les annotations importées, sinon repli documenté).
   API impérative : scrollToPage(index, {top?: points, behavior}), zoom avec point d'ancrage, plage visible, page courante. PdfWorkspace câble goTo/zoom/fit dessus. Corrige applyFit : « Largeur » donnait 1000 % sur mixed-geometry.pdf (pages de tailles/rotations mixtes, CropBox décalée) — reproduis, trouve la cause, corrige, ajoute un test.
   Supprime le code mort (ancien PageView/RenderScheduler s'ils ne servent plus ; garde renderToCanvas si utilisé par l'export).
4. Miniatures : sous la CSP de bureau les <img src="data:..."> sont bloquées (Sidebar.tsx ~117, Organize.tsx ~71). Crée un service de vignettes (core/thumbs.ts : rendu basse résolution via pdf.js, cache LRU d'ImageBitmap, dessin direct dans un <canvas>, file de priorité, annulation) et un composant ThumbCanvas ; virtualise la liste des miniatures du volet (1000 pages fluides) et de la vue Organiser. Ne touche aux autres fonctions de Sidebar/Organize que le strict nécessaire.
5. CSP de bureau : dans installer/elium_launcher.py (et desktop/src/app.py s'il est encore réellement utilisé pour construire l'appli — vérifie installer/elium.spec / build scripts), passe à : default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src <inchangé>; font-src <inchangé> ; img-src 'self' data: blob:; worker-src 'self' blob:; connect-src 'self' data: blob:; media-src 'self' data: blob:; frame-src 'self' blob:; object-src 'none'; base-uri 'self'. Justifie chaque ajout en commentaire (images de signature/miniatures en data:, impression via iframe blob:, OCR). N'ajoute PAS 'unsafe-eval' ni 'unsafe-inline' dans script-src. Mets à jour les tests Python qui vérifient la CSP s'il y en a (cherche dans tests/python) et lance \`.venv\\Scripts\\python -m pytest tests/python -q\` depuis le worktree (utilise le python du dépôt principal : C:\\Users\\ludov\\Downloads\\elium-main\\elium-main\\.venv\\Scripts\\python.exe) + ruff sur installer/.
6. Vérification OBLIGATOIRE avant de finir : build du worktree servi sous la CSP (port 3230) + Playwright/Edge : ouvre chaque PDF du corpus, capture d'écran de la 1re page (regarde-les), vérifie zéro erreur console CSP, miniatures visibles, JPX visible, et mesure sur edge-1000pages et word-250pages : DOM, tas, i/s de défilement, longues tâches, saut page 700, temps jusqu'au premier rendu. Objectif : au moins aussi bon que le prototype PDFViewer brut. Vérifie aussi qu'annoter (surlignage sur texte sélectionné, rectangle), éditer un paragraphe (mode Modifier), remplir un champ (form-acro) fonctionnent toujours à l'écran, et que la recherche Ctrl+F surligne.
7. Tests vitest ajoutés (layout pur, géométrie paresseuse via le shim node si possible, applyFit), tous les tests existants verts, tsc + eslint + prettier propres. Commit(s) sur pdf-rebuild.

Rends compte : fichiers créés/modifiés, décisions d'architecture (et pourquoi), mesures avant/après chiffrées, ce qui reste à faire ou ce que tu n'as pas pu vérifier. Sois honnête : ne prétends pas avoir vérifié ce que tu n'as pas exécuté.`

phase('Construire')
const report = await agent(BUILD, { label: 'build:foundation', phase: 'Construire' })

if (!report) {
  log('Constructeur interrompu (limite ?) : revue sautée pour ne pas gaspiller — relancer le workflow.')
  return { report: null, reviews: [], fixReport: 'constructeur interrompu' }
}

phase('Revue')
const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          severity: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] },
          evidence: { type: 'string', description: 'Ce que tu as exécuté et observé' },
          location: { type: 'string', description: 'fichier:ligne' },
          fix: { type: 'string' },
        },
        required: ['title', 'severity', 'evidence', 'location', 'fix'],
      },
    },
    verdict: { type: 'string' },
  },
  required: ['findings', 'verdict'],
}
const LENSES = [
  { key: 'regressions', prompt: `Lentille RÉGRESSIONS & CORRECTION. Compare le worktree à master (\`git -C ${WT} diff master...pdf-rebuild\`). Cherche tout ce qui a cassé ou changé de comportement : annotations (création sur texte sélectionné, formes, sélection/déplacement), mode Modifier le texte (ContentEditLayer/Preview alignés sur la page ?), formulaires (FormLayer), recherche et surlignage, liens, rotation par page, pages insérées/vierges/images, recadrage, thèmes, calques, annotations importées d'annotated.pdf (doublons ? invisibles ?), ouverture de PDF chiffré (mot de passe), vue Organiser, miniatures, zoom/ajustements, raccourcis, courses asynchrones (ouvrir un 2e fichier pendant le chargement du 1er), fuites (PDFPageView détruits ? ImageBitmap fermés ?). EXÉCUTE : build + serveur CSP sur le port 3231 (\`python csp_server.py 3231 <wt>/web-studio/dist\`) et Playwright sur le corpus ; lance vitest/tsc/eslint. Un constat sans exécution = P3 max.` },
  { key: 'perf', prompt: `Lentille PERFORMANCE & CONDITIONS DE BUREAU. Build du worktree servi sous la CSP (port 3232 : \`python csp_server.py 3232 <wt>/web-studio/dist\`, avec la CSP du worktree : copie csp_server.py et fais pointer REPO vers ${WT}). Mesure sur edge-1000pages, word-250pages, scan-jpeg, edge-web : temps jusqu'au premier rendu, DOM, tas JS, i/s au défilement continu, longues tâches, saut à la page 700, zoom 100→400 % (temps jusqu'au rendu net, mémoire des canvas), netteté à deviceScaleFactor 2 (capture), miniatures (1000 vignettes : fluidité du volet), erreurs console/CSP. Compare au prototype ${HARNESS}\\spike (port 3220) et donne les chiffres. Cherche les goulots (profil via PerformanceObserver/longtask, compteurs de rendus React) et les cas pathologiques (zoom 800 % sur A3, rotation 90° avec CropBox, page image 200 dpi).` },
]
const reviews = await parallel(LENSES.map((l) => () =>
  agent(`${CONTEXT}\n\n=== RÔLE : RELECTEUR ADVERSARIAL de la fondation F1 (déjà construite dans le worktree par un autre agent). NE MODIFIE PAS le code : écris tes scripts dans ${HARNESS}\\review-f1-${l.key}\\. ÉCONOMIE : budget de tokens limité (l'org a une limite de dépense) — vise les risques les plus probables, scripts courts, pas de re-mesures en boucle ; écris tes constats au fil de l'eau dans ${HARNESS}\\review-f1-${l.key}\\FINDINGS.md. ===\nRapport du constructeur :\n${report}\n\n${l.prompt}`,
    { label: `review:${l.key}`, phase: 'Revue', schema: REVIEW_SCHEMA })))
const all = reviews.filter(Boolean).flatMap((r) => r.findings)
log(`${all.length} constats de revue (${all.filter((f) => f.severity === 'P0' || f.severity === 'P1').length} P0/P1)`)

phase('Correction')
let fixReport = 'Aucun constat à corriger.'
if (all.length) {
  fixReport = await agent(`${CONTEXT}\n\n=== MISSION : CORRIGER la fondation F1 selon la revue ===
Rapport initial du constructeur :\n${report}\n\nConstats des relecteurs (vérifie chacun toi-même avant de corriger ; corrige tous les P0/P1 confirmés et les P2/P3 raisonnables ; si tu écartes un constat, dis pourquoi) :\n${JSON.stringify(all, null, 1)}\n\nAprès corrections : vitest + tsc + eslint + prettier verts, re-mesure sous CSP (port 3230), commit sur pdf-rebuild. Rends compte précisément de ce qui a été corrigé, écarté, et des mesures finales.`,
    { label: 'fix:foundation', phase: 'Correction' })
}
return { report, reviews, fixReport }
