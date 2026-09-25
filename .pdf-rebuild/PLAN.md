> ⚠️ Copie embarquée dans la branche pour la reprise dans le cloud : lire d'abord `.pdf-rebuild/CLOUD.md` (chemins Windows ci-dessous = machine de l'utilisateur).

# Refonte du module PDF « niveau Acrobat » — PLAN DURABLE

Ce fichier est la source de vérité de l'orchestration. Il survit aux coupures (limite de dépense par fenêtre de 5 h),
aux redémarrages de session et au nettoyage du dossier Temp. Le mettre à jour APRÈS CHAQUE ÉTAPE.

## Demandes de l'utilisateur (à respecter)
- 2026-09-23 : « les fonctionnalités PDF ne fonctionnent quasiment jamais / pas à la hauteur d'Adobe → retravaille tout le
  système PDF, optimise-le, rends-le aussi performant qu'Adobe ». Puis : « prends l'option la plus performante ».
- 2026-09-24 : « prends le temps qu'il faudrait, même plusieurs jours, mais fais en sorte que les fenêtres de 5 h ne
  détruisent pas des travaux en cours (enregistre bien tout) ».
- 2026-09-24 : « toutes les fonctionnalités doivent fonctionner sur l'application ET sur le Drive » (règle permanente
  de parité double plateforme).

## Emplacements
- Worktree : `C:\Users\ludov\Downloads\elium-main\elium-wt-pdf` — branche `pdf-rebuild` (poussée sur origin/pdf-rebuild le 25/09 à la demande de l'utilisateur ; ne déclenche aucune release — seul master publie).
  `web-studio/node_modules` = JONCTION vers `elium-main\web-studio\node_modules` (ne jamais supprimer, pas de npm install).
- Dossier durable : `C:\Users\ludov\Downloads\elium-main\pdf-rebuild-work\` (ce fichier, `harness/` = corpus + scripts +
  constats, `workflows/` = scripts de workflow, `logs/autosave.log`).
- Banc d'essai d'origine (scratchpad de la session 72cb6376, dans Temp) : copié ici. JONCTIONS du dossier durable :
  `harness/wt` → `elium-wt-pdf/web-studio`, `harness/node_modules` → node_modules du dépôt principal (ne jamais `rm -rf`).

## Protection contre les coupures
1. `autosave.sh` (à relancer en arrière-plan à CHAQUE nouvelle session : `bash pdf-rebuild-work/autosave.sh`) :
   toutes les 5 min, instantané des worktrees `elium-wt-pdf*` sur `refs/autosave/<branche>` (index temporaire : ne
   touche ni la branche, ni l'index, ni les fichiers) + copie des constats/journaux/workflows vers ce dossier.
   Restaurer : `git -C <wt> diff HEAD refs/autosave/<branche>` puis `git checkout refs/autosave/<branche> -- <fichiers>`.
2. Chaque agent : commits WIP sur sa branche après chaque étape, journal de reprise (`*-progress.md`), constats en
   append dans `FINDINGS.md`. Chaque workflow saute les étapes aval si l'étape amont a été coupée.
3. Moi (orchestrateur), après chaque notification : commit WIP de ce qui traîne, mise à jour de ce PLAN et de la
   mémoire `pdf-rebuild-2026-09`.
4. Les workflows ne se reprennent pas d'une session à l'autre (resumeFromRunId = même session) : relancer via
   `scriptPath` ; les agents repartent des journaux/commits.

## Environnements cibles (vérifier les DEUX)
- Appli de bureau : Edge `--app` + CSP de `installer/elium_launcher.py` (la plus stricte). Banc : `harness/csp_server.py <port> <dist>`.
- Drive web : même SPA web-studio servie par Caddy SANS CSP (`web-studio/Dockerfile`) ; API `/api` (serveur Fastify,
  `tests/dev-drive-server.ts` pour un serveur local avec Postgres embarqué). Le Drive est aussi utilisable depuis l'appli
  de bureau (donc sous CSP de bureau).

## Outil de validation
- Adobe Acrobat Pro 26.2 est installé et pilotable en COM : `harness/acrobat-check.ps1` (voir README-HARNESS). À utiliser par chaque chantier.

## Architecture décidée
- Affichage : composants pdf.js 6.2 (`PDFPageView`) + file de rendu + mise en page virtualisée Elium (`core/viewer/`).
- Assets pdf.js locaux (plugin Vite `scripts/pdfjs-assets-plugin.ts`), options getDocument communes (`core/assets.ts`).
- Annotations importées masquées via surcharge `annotationStorage.modifiedIds`.
- Formulaires : viser AnnotationLayer pdf.js (ENABLE_FORMS) + scripting (quickjs) + `saveDocument()`.
- Enregistrement : incrémental par défaut (préserve signatures/structure), réécriture complète seulement si nécessaire.

## Chantiers
| # | Chantier | État | Notes |
|---|---|---|---|
| F1 | Fondation affichage/assets/CSP/vignettes | ✅ TERMINÉE 25/09 | 14 commits (8531a14…337579c) ; vitest 1 788, pytest 238, tsc/eslint/prettier OK ; 0 violation CSP sur le corpus ; 1000 p. : 515 nœuds, 25 Mo, saut 15-45 ms ; relecture corrigée (liens/texte pivotés, course ouverture, vignettes coopératives, 100 % = taille réelle). Reste noté : groupBlocks fusionne une page entière (→ T3), hauteur de ruban variable (→ T10), JS de formulaire non branché (→ T2) |
| D | Diagnostic | 6/12 FAITS | forms 35, textedit 28, organize 42, annotations 35, navigation 46, viewer 28 constats → `harness/diag-results.json`. Non faits (auto-diagnostic par chaque chantier) : save, security, signature, convert, ux, architecture |
| T1 | Enregistrement incrémental + fidélité + chiffrés + signés + vrai « Enregistrer » + récupération | ✅ TERMINÉ 25/09 | 20 commits (7cefe62→1824686) ; vitest 1 832 ; incrémental (1000 p. + 1 annot = +2 Ko, ~0,3 s), chiffrés conservés, signature Elium valide après annotation/insertion (avertissement), Ctrl+S réel (File System Access, repli téléchargement), brouillons sans copie de la source, /Redact non appliqués conservés. Limites : FS Access réel et signatures non rouverts dans Acrobat ; permissions owner-only non appliquées (→T7) ; 2e signature invalide la 1re, signer un PDF protégé retire la protection (→T8) ; doc in-app à mettre à jour (→V) |
| T2 | Formulaires (pdf.js forms + scripting + création de champs) | EN COURS — interrompu pour passage au cloud (25/09 ~07:15) | étape 1 faite (f3ef868) ; ops/formpdf.ts écrit, non branché/testé ; reste : voir CLOUD.md + args/T2.json |
| T3 | Édition texte & images (moteur + UI) | À FAIRE | |
| T4 | Commentaires / annotations | À FAIRE | |
| T5 | Organisation des pages + décoration | À FAIRE | |
| T6 | Navigation, recherche, sélection/copie | À FAIRE | |
| T7 | Sécurité, caviardage, assainissement | À FAIRE | |
| T8 | Remplir & signer, signatures numériques | À FAIRE | ne pas régresser le PAdES reconnu par Adobe |
| T9 | Conversion, export, OCR, comparaison, compression, impression | À FAIRE | |
| T10 | Interface façon Acrobat (outils, raccourcis, menus) | À FAIRE | |
| T11 | Drive : ouvrir/éditer/enregistrer un PDF (nouvelle version chiffrée), mêmes fonctionnalités | À FAIRE | parité exigée |
| V | Vérification finale corpus complet (bureau CSP + web + Drive), fusion master, version, push, MSI | À FAIRE | |
