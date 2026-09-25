export const meta = {
  name: 'pdf-track',
  description: 'Un chantier de la refonte PDF : auto-diagnostic + reconstruction + vérification (appli CSP + Drive), revue adversariale, correction',
  phases: [
    { title: 'Construire', detail: 'diagnostic ciblé puis reconstruction du domaine, commits WIP + journal' },
    { title: 'Revue', detail: 'relecteur adversarial qui exécute (bureau CSP + web/Drive)' },
    { title: 'Correction', detail: 'corrige les constats confirmés' },
  ],
}

// args = { key, title, scope, domains: [clés de diag-results.json], port }
const T = args
const WT = 'C:\\Users\\ludov\\Downloads\\elium-main\\elium-wt-pdf'
const WORK = 'C:\\Users\\ludov\\Downloads\\elium-main\\pdf-rebuild-work'
const HARNESS = `${WORK}\\harness`
const PROGRESS = `${WORK}\\${T.key}-progress.md`
const PY = 'C:\\Users\\ludov\\Downloads\\elium-main\\elium-main\\.venv\\Scripts\\python.exe'

const CONTEXT = `Projet Elium (suite bureautique locale chiffrée ; React 18 + TS + Vite 5 ; pdfjs-dist 6.2.108 ; pdf-lib 1.17). REFONTE COMPLÈTE du module PDF pour le rendre « aussi performant qu'Adobe Acrobat Pro » (demande utilisateur). Lis d'abord ${WORK}\\PLAN.md (plan, décisions d'architecture, règles) et ${HARNESS}\\README-HARNESS.md (banc d'essai : corpus de vrais PDF dans ${HARNESS}\\corpus, gabarits Playwright/Node, serveur csp_server.py). Les chemins du README qui pointent vers le scratchpad Temp sont remplacés par ${HARNESS} ; les jonctions ws/ et node_modules/ du README n'existent pas ici : lance tes scripts Node depuis ${WT}\\web-studio (ou crée une jonction dans ton dossier de travail avec \`cmd /c mklink /J\` — ne supprime JAMAIS une jonction avec rm -rf).

TRAVAILLE DANS ${WT} (branche pdf-rebuild, seule à modifier). Ne touche pas au dépôt principal C:\\Users\\ludov\\Downloads\\elium-main\\elium-main (sauf lecture). web-studio/node_modules est une JONCTION : pas de npm install, ne jamais la supprimer. Les nouvelles dépendances npm sont interdites sauf nécessité absolue (justifie-la dans ton rapport ; ne l'installe pas toi-même).

RÈGLE DE PARITÉ (utilisateur) : toute fonctionnalité doit marcher dans l'APPLICATION de bureau (Edge --app + CSP stricte de installer/elium_launcher.py) ET dans le DRIVE (même SPA web-studio servie sans CSP par Caddy ; ouverture/enregistrement de PDF depuis le Drive = chantier T11, mais n'introduis rien qui ne marcherait que dans un environnement).

PROTOCOLE ANTI-COUPURE (OBLIGATOIRE — l'organisation a une limite de dépense qui coupe les agents toutes les ~5 h) :
- Journal de reprise : ${PROGRESS}. AU DÉMARRAGE lis-le (et \`git -C ${WT} log --oneline master..pdf-rebuild\`) : s'il existe, une tentative précédente a été coupée → REPRENDS où elle en était, ne recommence pas. Mets-le à jour après chaque étape (fait / en cours / reste / décisions / mesures).
- Commit WIP sur pdf-rebuild après chaque étape significative (au plus ~20 min de travail sans commit). Messages en français "feat(pdf): …" / "wip(pdf): …" terminés par "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>". Ne pousse pas. Un instantané automatique (refs/autosave/pdf-rebuild) tourne aussi toutes les 5 min, mais ne compte pas dessus pour l'historique.
- Constats et mesures : append dans ${HARNESS}\\${T.key}\\FINDINGS.md au fil de l'eau.
- Économie : budget limité — lis le code ciblé, scripts courts, pas de re-mesures en boucle.

VÉRIFICATION : \`cd ${WT}\\web-studio && npx vite build\` puis \`${PY} ${HARNESS}\\csp_server.py ${T.port} ${WT}\\web-studio\\dist\` en arrière-plan (port ${T.port} réservé à toi ; +1 pour ton relecteur) — ATTENTION : csp_server.py importe elium_launcher depuis le dépôt principal ; pour tester la CSP du worktree, copie-le et fais pointer REPO vers ${WT}. Playwright avec \`chromium.launch({ channel: "msedge" })\`. Vérifie le RÉSULTAT réel (fichier téléchargé rouvert avec pdf.js ET pdf-lib, rendu regardé en capture d'écran), pas l'absence d'exception. VALIDATION ACROBAT (obligatoire quand ton chantier produit des PDF) : Adobe Acrobat Pro 26.2 est installé — \`powershell -STA -File ${HARNESS}\\acrobat-check.ps1 <out.json> <pdf>...\` (voir README-HARNESS) : chaque fichier produit doit s'ouvrir sans réparation (dirty=false) et montrer dans Acrobat la même chose qu'Elium (étends le script via GetJSObject si besoin : champs, annotations, texte). Tests : vitest (tout doit rester vert), \`npx tsc --noEmit -p .\`, eslint et prettier sur les fichiers touchés.`

const DIAG = T.domains?.length
  ? `Constats DÉJÀ PROUVÉS de ton domaine (diagnostic multi-agents, preuves exécutées) : lis dans ${HARNESS}\\diag-results.json les entrées ${T.domains.map((d) => `"${d}"`).join(', ')} (summary, parity, findings avec repro/cause/correction ; scripts de repro dans ${HARNESS}\\diag\\<domaine>\\). Traite TOUS les P0/P1 et le maximum de P2 ; revérifie chaque constat avant de le corriger (le code a pu bouger avec la fondation F1).`
  : `Ton domaine n'a PAS encore été diagnostiqué : commence par un diagnostic prouvé rapide (repro exécutée sur le corpus, sous CSP de bureau), consigné dans ${HARNESS}\\${T.key}\\FINDINGS.md, puis corrige.`

const BUILD = `${CONTEXT}

=== CHANTIER ${T.key} — ${T.title} ===
${DIAG}

Périmètre et objectifs :
${T.scope}

Exigence de qualité (utilisateur) : niveau Acrobat Pro / Google Workspace — complet, fiable, rapide, soigné ; pas de squelette. Tout ce que l'écran montre doit se retrouver dans le fichier enregistré, et inversement. Aucun échec silencieux : toute limite rencontrée est signalée clairement à l'utilisateur (toast/dialogue).
Finis par : tests (vitest ajoutés pour la logique pure + non-régression), vérification Playwright sous CSP, commit final, journal à jour. Rapport : fait, preuves chiffrées, ce qui reste / n'a pas pu être vérifié (honnêtement).`

phase('Construire')
const report = await agent(BUILD, { label: `build:${T.key}`, phase: 'Construire' })
if (!report) {
  log(`build:${T.key} interrompu — relancer ce workflow avec les mêmes args (le journal ${PROGRESS} permet la reprise).`)
  return { key: T.key, report: null, review: null, fix: null }
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
          evidence: { type: 'string', description: 'Commande exécutée + sortie observée' },
          location: { type: 'string' },
          fix: { type: 'string' },
        },
        required: ['title', 'severity', 'evidence', 'location', 'fix'],
      },
    },
    verdict: { type: 'string' },
  },
  required: ['findings', 'verdict'],
}
const review = await agent(`${CONTEXT}

=== RÔLE : RELECTEUR ADVERSARIAL du chantier ${T.key} — ${T.title} (NE MODIFIE PAS le code ; scripts dans ${HARNESS}\\review-${T.key}\\ ; constats en append dans ${HARNESS}\\review-${T.key}\\FINDINGS.md) ===
Rapport du constructeur :
${report}

Diff à relire : \`git -C ${WT} log --oneline\` et \`git -C ${WT} diff <commit avant le chantier>..pdf-rebuild -- web-studio\` (repère le premier commit du chantier via le journal ${PROGRESS}).
Cherche en EXÉCUTANT (build + serveur CSP port ${T.port + 1} + Playwright/Edge, et vitest/tsc) : ce qui est cassé, faux dans le fichier enregistré, régressé ailleurs dans le module PDF, lent, non conforme à Acrobat, invisible pour l'utilisateur (échecs silencieux), ou qui ne marcherait pas dans le Drive (sans CSP) ou dans l'appli (CSP). Un constat sans exécution = P3 max.`,
  { label: `review:${T.key}`, phase: 'Revue', schema: REVIEW_SCHEMA })

phase('Correction')
const todo = (review?.findings ?? []).filter((f) => f.severity !== 'P3' || review.findings.length < 12)
let fix = review ? 'Aucun constat.' : 'Revue interrompue — relancer.'
if (todo.length) {
  fix = await agent(`${CONTEXT}

=== MISSION : CORRIGER le chantier ${T.key} — ${T.title} selon la revue adversariale ===
Rapport du constructeur :
${report}

Constats du relecteur (revérifie chacun ; corrige tous les P0/P1 confirmés et les P2/P3 raisonnables ; justifie ce que tu écartes) :
${JSON.stringify(todo, null, 1)}

Même protocole anti-coupure (journal ${PROGRESS}, commits WIP). Termine par tests + vérification sous CSP + commit. Rapport précis.`,
    { label: `fix:${T.key}`, phase: 'Correction' })
}
return { key: T.key, report, review, fix }
