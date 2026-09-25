# Reprise du chantier « refonte PDF » dans le cloud

Ce dossier embarque dans la branche `pdf-rebuild` tout l'état d'orchestration qui vivait jusqu'ici HORS du dépôt, sur le
PC Windows de l'utilisateur (`C:\Users\ludov\Downloads\elium-main\pdf-rebuild-work\`). À lire dans cet ordre :
`CLOUD.md` (ce fichier) → `PLAN.md` (chantiers, états, décisions, consignes utilisateur) → le journal du chantier en
cours (`T2-progress.md`) → `harness/README-HARNESS.md`.

## Consignes de l'utilisateur (permanentes)
- Refaire TOUT le module PDF (`web-studio/src/pdf/`) pour qu'il soit aussi performant et fiable qu'Adobe Acrobat Pro ;
  option la plus performante ; prendre le temps qu'il faut (plusieurs jours OK).
- Ne jamais perdre de travail aux coupures (limite de dépense par fenêtre de ~5 h) : commits WIP fréquents + journaux
  `*-progress.md` + constats en append (`FINDINGS.md`) ; pousser `pdf-rebuild` régulièrement.
- Toute fonctionnalité doit marcher dans l'APPLICATION de bureau (Edge `--app` + CSP stricte de
  `installer/elium_launcher.py`) ET dans le DRIVE web (même SPA servie sans CSP).
- PAS de co-édition PDF en temps réel (retirée à la demande de l'utilisateur) — ne pas la proposer.
- Répondre en français. Commits en français (`feat(pdf): …`, `wip(pdf): …`), terminés par la ligne Co-Authored-By.
- `master` = publication automatique d'une release (bump de `__version__` dans `src/elium/__init__.py` + `web-studio/package.json`
  puis push). NE PAS fusionner `pdf-rebuild` dans `master` avant l'étape V (vérification finale) du PLAN.

## État au moment du passage au cloud (25/09/2026 ~07:15)
- F1 (moteur d'affichage virtualisé sur pdf.js `PDFPageView`, assets pdf.js locaux, CSP, vignettes) : ✅
- T1 (enregistrement incrémental, PDF chiffrés/signés, vrai Ctrl+S via File System Access, récupération) : ✅
- T2 (formulaires) : EN COURS, interrompu volontairement pour le passage au cloud.
  - Étape 1 faite (commit f3ef868) : remplissage via le moteur de formulaires pdf.js, synchro annotationStorage ⇄ modèle,
    annulation par champ, surlignage, réinitialisation /DV.
  - En cours : `web-studio/src/pdf/ops/formpdf.ts` (apparences Unicode avec Liberation Sans embarquée quand
    `saveDocument()` de pdf.js n'en génère pas + aplatissement ISO 32000) — écrit mais PAS encore branché, compilé ni testé.
  - Reste (cf. `workflows/args/T2.json`, champ `scope`) : JavaScript de formulaire (PDFScriptingManager + sandbox quickjs,
    `core/forms/scripting.ts` non vérifié), branchement de savePdf sur `saveDocument()` + formpdf, préparation de formulaire
    complète (création/édition de tous les types de champs, poignées, propriétés, champs existants, détection auto),
    import/export FDF/XFDF/CSV compatibles Acrobat, aplatissement, champs obligatoires, XFA, puis relecture adversariale
    et correction.
- Ensuite : T3 → T11 puis V (voir PLAN.md).

## Ce qui DIFFÈRE dans le cloud (Linux) — à adapter
- Chemins : tout ce qui est écrit `C:\Users\ludov\...` dans PLAN.md, README-HARNESS.md et les workflows désigne la machine
  Windows. Dans le cloud : dépôt = racine du checkout ; ce dossier = `.pdf-rebuild/` ; corpus = `.pdf-rebuild/harness/corpus/`.
  Les constantes `WT`, `WORK`, `HARNESS`, `PY` en tête de `workflows/wf-track.js` sont à remplacer par les chemins du cloud.
- Il n'y a PAS de worktree séparé ni de jonction : on travaille directement sur la branche `pdf-rebuild` du checkout.
- Dépendances : `cd web-studio && npm ci` (pas de node_modules commité). Python : créer un venv et `pip install -e .`
  si les tests Python/interop sont nécessaires (`pytest tests/python`).
- Navigateur : pas d'Edge. Utiliser Playwright avec Chromium (`npx playwright install chromium` si le réseau le permet ;
  sinon tests Node/vitest uniquement). Le moteur est le même (Chromium) que l'appli Edge.
- CSP de bureau : `harness/csp_server.py <port> <dist>` fonctionne sous Linux (il importe `installer/elium_launcher.py` :
  mettre la variable `REPO` du script sur la racine du checkout).
- PAS d'Adobe Acrobat Pro (validation `harness/acrobat-check.ps1` = Windows seulement) : noter dans les journaux les
  fichiers à faire valider plus tard sur la machine de l'utilisateur, et compenser par pdf.js + pdf-lib + qpdf si disponible.
- PAS de Word ni d'Edge headless pour régénérer le corpus : le corpus est commité ici tel quel (8,6 Mo, synthétique,
  aucune donnée personnelle). NE JAMAIS utiliser les PDF personnels de l'utilisateur.
- Constats détaillés : `harness/diag-results.json` (6 domaines, 214 constats prouvés : forms, textedit, organize,
  annotations, navigation, viewer), `harness/findings/*.md`, `harness/f1-review-findings.json`, `harness/T1-results.json`.

## À faire avant la fusion finale dans master (étape V)
- Retirer ce dossier `.pdf-rebuild/` (corpus binaire compris) de ce qui part dans `master` (fusion par squash, ou commit de
  suppression avant fusion) pour ne pas alourdir le dépôt.
- Mettre à jour la documentation intégrée (`web-studio/src/docs/documentation.ts`), bumper la version, pousser `master`,
  vérifier la release GitHub puis rafraîchir le MSI dans les Téléchargements de l'utilisateur (sur sa machine).
