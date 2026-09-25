# Banc d'essai PDF Elium — consignes communes

Dépôt principal (LECTURE SEULE) : `C:\Users\ludov\Downloads\elium-main\elium-main`. Code en refonte : worktree
`C:\Users\ludov\Downloads\elium-main\elium-wt-pdf` (branche pdf-rebuild) — les chantiers de reconstruction y travaillent
et y commitent (voir leur prompt). Note : la CSP du lanceur a été élargie sur pdf-rebuild (img-src/worker-src/frame-src
data:/blob:) — pour tester la CSP du worktree, faites pointer REPO de csp_server.py vers le worktree.
Module PDF : `web-studio/src/pdf/` (core/ model/ ops/ ui/). Tests existants : `web-studio/tests/pdf-*.test.ts`.

HARNESS = `C:\Users\ludov\Downloads\elium-main\pdf-rebuild-work\harness` (dossier durable ; l'ancien scratchpad Temp n'est plus la référence)

## Jonctions (dossier durable)
- `harness/wt` → `elium-wt-pdf/web-studio` (code du WORKTREE en cours de refonte : importez `./wt/src/...` depuis un script placé dans harness/<dossier>/ via `../wt/src/...`)
- `harness/node_modules` → node_modules du dépôt principal. `harness/ws` (dépôt principal, lecture seule) n'existe que dans l'ancien scratchpad.

## ⚠️ Règles absolues
- Diagnostic/relecture : ne modifiez aucun fichier de code ; scripts dans `HARNESS/<votre-dossier>/`. Reconstruction : modifiez UNIQUEMENT le worktree elium-wt-pdf (jamais le dépôt principal).
- `HARNESS/wt` et `HARNESS/node_modules` sont des JONCTIONS vers le code : ne les supprimez JAMAIS, ne faites
  jamais `rm -rf` sur HARNESS ou un parent (cela effacerait le dépôt).
- N'ouvrez JAMAIS les PDF personnels de l'utilisateur (`C:\Users\ludov\Downloads\*.pdf`) : données privées.
  Utilisez uniquement le corpus ci-dessous (ou générez vos propres PDF de test).
- Pas de réseau externe. Git : seulement les commits prévus par votre prompt, sur pdf-rebuild, jamais de push.

## Serveurs (À LANCER SOI-MÊME sur son port réservé — plus aucun serveur permanent)
- `python csp_server.py <port> <dist>` — MÊME CSP que l'appli de bureau installée (`installer/elium_launcher.py::QuietHandler`) :
  `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com`
  → c'est la cible de référence : l'utilisateur vit DANS ces conditions (appli Edge `--app`).
- `python plain_server.py <port>` (dist du dépôt principal) — SANS CSP (pour distinguer un bug de logique d'un blocage CSP).

## Corpus `HARNESS/corpus/` (vrais producteurs)
| fichier | producteur / particularité |
|---|---|
| word-contrat.pdf | Word (COM) 7 p. : titres, tableau, liste, image, lien, note de bas de page, en-tête/pied, signets de titres, PDF balisé |
| word-250pages.pdf | Word 251 p. (perf) |
| edge-web.pdf | Edge/Chromium (Skia) 3 p. : polices CID Identity-H sous-ensemble, CJK, arabe RTL, SVG vectoriel, dégradé, transparence, lien |
| edge-1000pages.pdf | Edge 1000 p., 5 Mo (perf) |
| scan-jpeg.pdf | 6 p. image seule JPEG (DCT) 200 dpi, bruit, légère inclinaison (OCR) |
| scan-jpx.pdf | 3 p. image JPEG2000 (JPXDecode) |
| mixed-geometry.pdf | 7 p. : A4, paysage, /Rotate 90/180/270, CropBox décalée, A3 ; police Helvetica NON embarquée, texte WinAnsi accentué |
| form-acro.pdf | AcroForm pdf-lib : texte, multiligne, case, radio, liste déroulante, liste multi, date, champ signature vide |
| annotated.pdf | word-contrat + annotations existantes : Highlight, Text + réponse (IRT), FreeText, Ink, Square, StrikeOut, Link |
| encrypted-aes256-pwd-test.pdf | AES-256 R6, mot de passe d'ouverture `test`, propriétaire `owner` |
| encrypted-owner-only.pdf | AES-256 sans mot de passe d'ouverture, permissions restreintes (pas d'impression/modif/copie), propriétaire `owner` |

## Outils
- Playwright (navigateur = Edge installé, même moteur que l'appli) : `import { chromium } from "@playwright/test";`
  `chromium.launch({ channel: "msedge", headless: true })`. Gabarit complet : `HARNESS/probe-template.mjs`
  (ouvre le module PDF : bouton `/^PDF/` sur l'accueil, puis `setInputFiles('input[type="file"][accept*="pdf"]', …)`).
  Téléchargements : `page.waitForEvent("download")` puis `download.saveAs(...)` — l'appli enregistre via un lien blob.
  Captures d'écran : `page.screenshot({ path })` fonctionnent (Playwright), utilisez-les pour VOIR le résultat.
  Le conteneur de défilement est `.pdfx-canvas`, les pages sont des `<canvas>` dedans.
- Scripts Node exécutant le code de production : placez un `.mts` dans `HARNESS/diag/<domaine>/` et importez via
  un chemin RELATIF vers `HARNESS/wt/src/...` (ex. `../wt/src/pdf/ops/save.ts`), lancez `npx tsx fichier.mts`
  depuis HARNESS (ou votre sous-dossier). Gabarit : `HARNESS/node-test-template.mts`.
  Si vous atteignez `PdfEngine`/pdfjs en Node, importez D'ABORD `wt/tests/pdfjs-node-shim.ts`.
- Vérifier un PDF produit : rouvrir avec pdf-lib ET pdf.js (texte via `getTextContent`, annotations via
  `getAnnotations`, champs via `getFieldObjects`), et le RENDRE en image via Playwright pour le regarder.
  Helpers de décodage du flux de contenu : voir `shownText()` dans `web-studio/tests/pdf-export.test.ts`.
- Python : `C:\Users\ludov\Downloads\elium-main\elium-main\.venv\Scripts\python.exe` (Pillow, cryptography).
- Machine : 8 cœurs, d'autres agents tournent en parallèle — pas de boucles de benchmark de plusieurs minutes.

## Référence qualité
L'utilisateur dit : « les fonctionnalités PDF ne sont pas performantes, ne fonctionnent quasiment jamais et/ou ne
sont pas à la hauteur d'Adobe ». Référence = Adobe Acrobat Pro. Un constat vaut par sa PREUVE (commande exécutée +
sortie observée), pas par une lecture de code.

## ✅ Validation par le VRAI Adobe Acrobat Pro (installé sur cette machine, v26.2)
Acrobat Pro se pilote en COM/IAC, de façon invisible — c'est la référence absolue pour « aussi bien qu'Adobe ».
- `powershell -STA -File HARNESS\acrobat-check.ps1 <sortie.json> <pdf1> <pdf2> ...` → pour chaque fichier : ouverture
  (open), nombre de pages, `dirty` (true = Acrobat a dû RÉPARER le fichier → défaut), nombre de champs, producteur,
  et pour chaque champ signature : `signatureValidate()` + `signatureInfo()` (status, docValidity, objValidity, revision).
- Variante JScript : `cscript //nologo HARNESS\acrobat-check.js <pdf>...`.
- Étendre via `pdDoc.GetJSObject()` (API JavaScript d'Acrobat : getField, getAnnots, getPageNthWord, syncAnnotScan…)
  pour vérifier annotations, valeurs de formulaire, texte, etc. Toujours fermer (`CloseAllDocs`, `Exit`).
- Un fichier produit par Elium n'est « bon » que s'il s'ouvre dans Acrobat SANS réparation (dirty=false) et y montre
  la même chose qu'Elium.
