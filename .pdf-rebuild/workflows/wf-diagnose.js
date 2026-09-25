export const meta = {
  name: 'pdf-diagnose',
  description: 'Diagnostic exhaustif et prouvé du module PDF Elium (12 domaines) vs Acrobat, puis vérification adversariale',
  phases: [
    { title: 'Diagnostic', detail: '12 domaines, preuves exécutées sur un corpus réel sous la CSP de l’appli de bureau' },
    { title: 'Vérification', detail: 'un vérificateur indépendant par domaine rejoue chaque constat P0/P1' },
    { title: 'Complétude', detail: 'critique : ce qui n’a pas été couvert' },
  ],
}

const HARNESS = 'C:\\Users\\ludov\\AppData\\Local\\Temp\\claude\\C--Users-ludov-Downloads-elium-main\\72cb6376-9846-4238-a19b-d350714b8a76\\scratchpad\\harness'
const REPO = 'C:\\Users\\ludov\\Downloads\\elium-main\\elium-main'

const COMMON = `Tu fais partie d'un diagnostic du module PDF de l'application Elium (suite bureautique locale chiffrée, React + pdf.js 6.2 + pdf-lib 1.17).
L'utilisateur se plaint : « les fonctionnalités PDF ne sont pas performantes, ne fonctionnent quasiment jamais et/ou ne sont pas à la hauteur d'Adobe ». On va TOUT retravailler ; ton rôle est de produire la liste PROUVÉE de ce qui ne va pas dans ton domaine, et l'écart avec Adobe Acrobat Pro.

LIS D'ABORD : ${HARNESS}\\README-HARNESS.md (banc d'essai, serveurs, corpus, règles absolues — respecte-les strictement : dépôt en LECTURE SEULE, jamais les PDF personnels de l'utilisateur, ne jamais supprimer les jonctions ws/ et node_modules/).
Dépôt : ${REPO}. Travaille dans ${HARNESS}\\diag\\<ton-domaine>\\.

Déjà connu (inutile de le redémontrer, mais cite-le si cela impacte ton domaine) : sous la CSP de bureau (port 3210) toutes les miniatures <img src="data:"> sont bloquées ; pdf.js est ouvert sans wasmUrl/cMapUrl/standardFontDataUrl/iccUrl (engine.ts:177) → JPEG2000 blanc ; le zoom « Largeur » passe à 1000 % sur mixed-geometry.pdf ; les 1000 pages d'edge-1000pages.pdf sont toutes montées dans le DOM (28 000 nœuds).

REPRISE (important) : une première tentative a été interrompue par une limite de facturation. Si ton dossier ${HARNESS}\diag\<ton-domaine>\ existe déjà, il contient les scripts de ton prédécesseur et un fichier _salvage-notes.md (ses notes + sorties courtes de scripts) : LIS-LES D'ABORD, réutilise/relance ses scripts au lieu de tout réécrire, et ne crois pas ses conclusions sans les rejouer.
RÉSILIENCE : dès qu'un constat est établi, AJOUTE-le immédiatement (append) dans ${HARNESS}\diag\<ton-domaine>\FINDINGS.md (id, sévérité, titre, repro, preuve, cause, correction) — si tu es interrompu, ce fichier sera la seule trace. Ta sortie structurée finale doit reprendre tout FINDINGS.md.
ÉCONOMIE : pas d'exploration gratuite ; lis le code ciblé, écris des scripts courts, ne relance pas 10 fois la même mesure.

MÉTHODE EXIGÉE :
1. Lis le code de ton domaine (cite fichier:ligne).
2. EXERCE réellement chaque fonctionnalité : via Playwright sur http://127.0.0.1:3210/ (conditions réelles de l'utilisateur) — et 3211 pour comparaison si un échec pourrait venir de la CSP — et/ou via des scripts Node (tsx) appelant le code de production sur le corpus. Vérifie le RÉSULTAT (fichier téléchargé rouvert avec pdf.js/pdf-lib, texte extrait, rendu regardé en capture d'écran), pas seulement « pas d'exception ».
3. Mesure les performances quand c'est pertinent (ms, Mo, nœuds DOM, longues tâches > 50 ms via PerformanceObserver 'longtask').
4. Compare à Acrobat Pro fonctionnalité par fonctionnalité.

Sévérités : P0 = cassé/inutilisable dans les conditions réelles, perte/corruption de données, faille ; P1 = marche partiellement, résultat faux dans un cas courant, performance gravement insuffisante ; P2 = bug mineur ou écart de parité sur un cas moins courant ; P3 = finition.
Chaque constat DOIT avoir : une repro exacte (script sauvegardé dans ton dossier diag + commande), la preuve observée (sortie réelle, chiffres), la cause racine (fichier:ligne) et une piste de correction concrète. Un constat sans preuve exécutée doit être marqué evidenceType="code-reading" et ne peut pas dépasser P2.
Rédige titres/textes en français. Sois exhaustif : mieux vaut 25 constats précis que 8 vagues. Termine par ta synthèse du domaine.`

const FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    domain: { type: 'string' },
    summary: { type: 'string', description: 'Synthèse du domaine en 5-10 phrases : ce qui marche, ce qui est cassé, l’écart Acrobat' },
    parity: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          feature: { type: 'string' },
          acrobat: { type: 'string', description: 'Ce que fait Acrobat Pro' },
          status: { type: 'string', enum: ['ok', 'partial', 'broken', 'missing'] },
          note: { type: 'string' },
        },
        required: ['feature', 'status', 'note'],
      },
    },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'ex. viewer-01' },
          title: { type: 'string' },
          severity: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] },
          kind: { type: 'string', enum: ['bug', 'perf', 'parity-gap', 'ux', 'security', 'data-loss', 'desktop-env'] },
          evidenceType: { type: 'string', enum: ['executed', 'code-reading'] },
          repro: { type: 'string', description: 'Chemin du script + commande exacte + étapes' },
          evidence: { type: 'string', description: 'Sortie réelle observée, chiffres' },
          rootCause: { type: 'string', description: 'fichier:ligne + explication' },
          fix: { type: 'string', description: 'Piste de correction concrète' },
        },
        required: ['id', 'title', 'severity', 'kind', 'evidenceType', 'repro', 'evidence', 'rootCause', 'fix'],
      },
    },
    perfMetrics: { type: 'string', description: 'Mesures chiffrées relevées (le cas échéant)' },
  },
  required: ['domain', 'summary', 'parity', 'findings'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          verdict: { type: 'string', enum: ['confirmed', 'refuted', 'unclear'] },
          severity: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'], description: 'Sévérité corrigée si besoin' },
          note: { type: 'string', description: 'Ce que tu as rejoué et observé' },
        },
        required: ['id', 'verdict', 'severity', 'note'],
      },
    },
    missed: {
      type: 'array',
      description: 'Défauts importants découverts en rejouant et absents de la liste',
      items: {
        type: 'object',
        properties: { title: { type: 'string' }, severity: { type: 'string' }, evidence: { type: 'string' }, rootCause: { type: 'string' } },
        required: ['title', 'severity', 'evidence'],
      },
    },
  },
  required: ['verdicts', 'missed'],
}

const RESUME2 = `\n\nREPRISE N°3 : deux tentatives ont déjà été interrompues. Dans ton dossier diag il peut y avoir FINDINGS.md (constats déjà établis par la 2e tentative : repars-en, revérifie vite ceux qui te semblent douteux, complète), _salvage-notes.md et _salvage-notes-2.md (notes des tentatives 1 et 2). Ne refais pas ce qui est déjà prouvé ; concentre-toi sur ce qui manque, puis produis la sortie structurée complète.`

const DOMAINS = [
  { key: 'viewer', title: 'Ouverture, rendu et performance d’affichage',
    scope: `Fichiers : core/engine.ts, core/render.ts, ui/PageView.tsx, ui/PdfWorkspace.tsx (zone d'affichage, zoom, modes), ui/state.ts, ui/pdf.css.
À exercer sur TOUT le corpus : temps d'ouverture et de premier rendu, fluidité du défilement (longues tâches pendant un défilement continu de edge-1000pages et word-250pages), saut à la page N (temps d'affichage), zoom (préréglages, Largeur, Page entière, Ctrl+molette, zoom sur zone), modes d'affichage (une page, continu, deux pages, couverture), rotation d'affichage, qualité de rendu (netteté HiDPI deviceScaleFactor 1.25/2, texte à 400-800 %, rendu par tuiles à fort zoom ?), mémoire JS, taille du DOM, virtualisation, fidélité visuelle de chaque fichier (compare captures CSP vs sans CSP et à l'œil : polices non embarquées, CJK, transparence, dégradés), couche texte alignée sur le rendu, liens cliquables, plein écran / mode lecture, thèmes de lecture. Référence Acrobat : ouverture quasi instantanée, défilement 60 i/s sur 1000 pages, rendu progressif.` },
  { key: 'navigation', title: 'Navigation, recherche, sélection de texte',
    scope: `Fichiers : ui/Sidebar.tsx, core/search.ts, core/text.ts, parties recherche/sélection de ui/PdfWorkspace.tsx.
À exercer : miniatures (sous CSP ET sans), signets/plan (word-contrat en a — navigation correcte ?), étiquettes de page, pièces jointes, calques, recherche Ctrl+F (vitesse sur 1000 pages, surlignage de toutes les occurrences, mot entier, casse, accents/ligatures « ffi », occurrence suivante/précédente, recherche dans CJK), recherche avancée, sélection de texte à la souris (multi-colonnes edge-web, tableau, pages tournées mixed-geometry) et copie (texte copié exact ? ordre ? espaces ?), Ctrl+A, navigation clavier (PgUp/PgDn, Début/Fin, flèches, Ctrl+G/aller à la page), historique précédent/suivant (Alt+←). Référence : volet de navigation d'Acrobat.` },
  { key: 'textedit', title: 'Modification du texte et des images (« Modifier un PDF »)',
    scope: `Fichiers : ops/textedit.ts, core/contentstream.ts, core/fontmetrics.ts, ops/fonts.ts, ops/images.ts, ops/content.ts, ui/ContentEditLayer.tsx, ui/ContentEditPreview.tsx, parties « edit » de PdfWorkspace/Ribbon/Inspector.
À exercer RÉELLEMENT (Playwright, puis enregistrement et rouverture) : modifier un paragraphe existant dans word-contrat (TrueType sous-ensemble), edge-web (CID Identity-H), mixed-geometry (Helvetica non embarquée, pages tournées, CropBox décalée) ; ajouter des caractères absents du sous-ensemble (ex. « Ω », « ŷ ») ; changer police/taille/couleur/gras ; reflux dans le bloc ; déplacer/redimensionner un bloc ; ajouter une zone de texte ; remplacer/déplacer/supprimer/recadrer une image ; ajouter une image ; annuler/rétablir. Vérifie le rendu À L'ÉCRAN pendant l'édition et le PDF enregistré (texte extrait, rendu, polices). Référence : l'outil « Modifier le PDF » d'Acrobat (reflux de paragraphe, correspondance de police, détection des blocs).` },
  { key: 'annotations', title: 'Commentaires et annotations',
    scope: `Fichiers : ui/AnnotLayer.tsx, ops/annots-pdf.ts, ops/import-annots.ts, ops/xfdf.ts, ops/painter.ts, model/doc.ts, model/types.ts, ui/Inspector.tsx, parties commentaires de Sidebar/Ribbon.
À exercer : CHAQUE outil (note, surlignage, soulignement, barré, ondulé, texte libre, légende/callout, rectangle, ellipse, ligne, flèche, polygone, polyligne, crayon/encre, gomme, tampons, pièce jointe, mesures distance/périmètre/aire), styles (couleur, opacité, épaisseur), réponses, statuts, filtre/tri du volet, import des annotations existantes d'annotated.pdf (toutes visibles et éditables ?), enregistrement puis rouverture dans pdf.js (annotations présentes, /AP rendu identique ?), export/import XFDF/FDF, résumé des commentaires. Teste le surlignage sur texte multi-colonnes et pages tournées. Référence : outil Commentaire d'Acrobat.` },
  { key: 'forms', title: 'Formulaires (remplissage et préparation)',
    scope: `Fichiers : ops/forms.ts, ui/FormLayer.tsx, parties formulaires de PdfWorkspace/Ribbon/Inspector.
À exercer : remplir TOUS les champs de form-acro.pdf via l'UI (texte, multiligne, case, radio, liste déroulante, liste multi, date), ordre de tabulation, enregistrement → rouverture (valeurs ET apparences rendues par pdf.js), « Préparer un formulaire » (détection automatique sur word-contrat), création de chaque type de champ, propriétés (obligatoire, lecture seule, format date/nombre, calculs), actions JavaScript (Acrobat les exécute), réinitialisation, aplatissement, export/import FDF/XFDF/CSV, champ de signature. Référence : Remplir et signer + Préparer un formulaire d'Acrobat.` },
  { key: 'organize', title: 'Organisation des pages et décoration',
    scope: `Fichiers : ops/organize.ts, ops/decorate.ts, ui/Organize.tsx, dialogues associés (ui/dialogs.tsx), parties organiser de PdfWorkspace.
À exercer : insérer (page vierge, depuis un fichier, depuis une image), supprimer, faire pivoter, réordonner par glisser-déposer, extraire, fractionner (par pages, taille, signets), fusionner plusieurs fichiers, remplacer des pages, recadrer (aperçu), étiquettes de page, en-tête/pied de page, filigrane, arrière-plan, numérotation Bates. Après chaque opération + enregistrement : signets, liens internes, annotations et champs de formulaire survivent-ils et pointent-ils au bon endroit ? Performance de la vue Organiser sur edge-1000pages (vignettes, glisser). Référence : Organiser les pages d'Acrobat.` },
  { key: 'save', title: 'Enregistrement, fidélité et persistance',
    scope: `Fichiers : ops/save.ts, model/persist.ts, ops/optimize.ts, App.tsx (exportPdf / exportAppElium / ouverture .elium PDF), ui/PdfWorkspace.tsx (flux Enregistrer/Exporter), ui/dialogs.tsx SaveDialog.
À exercer sur CHAQUE fichier du corpus : ouvrir → enregistrer sans modification (et après une seule annotation) → comparer à la source : nombre de pages, texte extrait identique, polices, images non ré-encodées, liens, signets, structure balisée (StructTreeRoot/MarkInfo), métadonnées XMP, pièces jointes, calques, taille de fichier, durée d'enregistrement, ouverture sans avertissement par pdf.js. Enregistrement incrémental (Acrobat l'utilise pour préserver les signatures) : un PDF signé reste-t-il valide après ajout d'un commentaire ? Persistance .elium (serialize/deserialize, taille pour edge-1000pages, base64 ?, mémoire), flux UX Enregistrer vs Exporter, « enregistrer sous », perte de travail à la fermeture (brouillon ?). Référence : Enregistrer / Enregistrer sous d'Acrobat.` },
  { key: 'security', title: 'Protection, suppression définitive (caviardage), assainissement',
    scope: `Fichiers : ops/security.ts, ops/redact.ts, dialogues Protect/RedactSearch, parties sécurité de PdfWorkspace.
À exercer : protéger (mot de passe d'ouverture, permissions), retirer la protection (encrypted-aes256-pwd-test avec « test », encrypted-owner-only avec « owner » et sans), respect des permissions dans l'UI pour owner-only, caviardage (texte sélectionné, zone, recherche de motifs type e-mail/téléphone/IBAN) → appliquer → vérifier que le texte a VRAIMENT disparu (extraction pdf.js + pdf-lib, copier-coller), images coupées, métadonnées ; « Supprimer les informations masquées »/assainir (métadonnées, JavaScript, pièces jointes, calques masqués, commentaires, texte caché). Chiffrement AES-256 produit : s'ouvre-t-il correctement (pdf.js) ? Référence : Protéger / Caviarder d'Acrobat.` },
  { key: 'signature', title: 'Remplir et signer, signatures numériques',
    scope: `Fichiers : ops/sign.ts, ops/pades.ts, ops/self-cert.ts, SignatureDialog (ui/dialogs.tsx), parties signature de PdfWorkspace, src/pdf/pades.test.ts.
À exercer : signature manuscrite (dessinée, tapée, image importée), initiales, date, coche/croix, placement et redimensionnement, enregistrement → rendu ; signature PAdES auto-signée et .p12 (visible), vérification des signatures (volet), signature du champ préparé de form-acro.pdf, signer puis ajouter un commentaire (la signature reste-t-elle valide ?), document certifié. IMPORTANT : la signature PAdES actuelle est reconnue par Adobe — ne la dénigre pas sans preuve ; signale uniquement ce qui est réellement cassé ou manquant (horodatage, LTV, validation de chaîne...). Référence : Remplir et signer + Certificats d'Acrobat.` },
  { key: 'convert', title: 'Conversion, export, OCR, comparaison, optimisation, impression',
    scope: `Fichiers : ops/export.ts, ops/compare.ts, ops/ocr.ts, ops/optimize.ts, parties export/impression de PdfWorkspace, dialogues associés.
À exercer : export Word .docx de word-contrat et edge-web (ouvre le .docx : paragraphes, tableaux, images, polices, mise en page — compare à ce que ferait Acrobat), HTML, texte, images par page (PNG/JPEG), extraction d'images, tableaux → CSV/Excel, PDF depuis images, comparaison de deux versions, OCR de scan-jpeg (SOUS LA CSP de bureau : fonctionne-t-il ? d'où viennent les modèles ? texte reconnu exact ? couche texte invisible correcte ?), optimisation (réduction de taille sur scan-jpeg et edge-1000pages, fidélité), impression (bouton Imprimer sous CSP : que se passe-t-il ?). Référence : Exporter un PDF, Numériser et OCR, Comparer, Compresser, Imprimer d'Acrobat.` },
  { key: 'ux', title: 'Expérience utilisateur et parité d’interface avec Acrobat',
    scope: `Fichiers : ui/Ribbon.tsx, ui/PdfWorkspace.tsx, ui/Sidebar.tsx, ui/Inspector.tsx, ui/dialogs.tsx, ui/pdf.css, ui/state.ts.
À exercer (captures d'écran à 1366×768 et 1920×1080, regarde-les réellement) : premier écran et ouverture d'un fichier (glisser-déposer, fichiers récents), découvrabilité des outils (Acrobat : volet « Tous les outils », barre d'outils rapide), organisation du ruban, menus contextuels (clic droit sur page / texte / annotation), raccourcis clavier standard d'Acrobat (liste-les et teste chacun : Ctrl+O/S/P/F/Z/Y/+/-/0/1/2, Ctrl+Maj+H...), annuler/rétablir sur toutes les opérations, messages d'erreur, états d'attente, toasts, plusieurs documents ouverts (onglets), mode sombre, accessibilité de base (focus clavier, libellés). Relève tout ce qui rend l'outil déroutant, lent ou « pas fini » comparé à Acrobat.` },
  { key: 'architecture', title: 'Architecture, robustesse, fuites, couverture de tests, parité Drive',
    scope: `Fichiers : tout src/pdf/ (surtout ui/PdfWorkspace.tsx 2800 lignes), App.tsx (intégration), vite.config.ts, web-studio/tests/pdf-*.test.ts, src/drive-cloud/ui/DriveBrowser.tsx (ligne ~125 : que fait le Drive d'un PDF ?).
À mesurer/prouver : coût des re-rendus React (défilement, saisie dans une annotation — mesure via longtask/Performance), fuites mémoire (ouvrir/fermer 10 documents successivement : heap, workers pdf.js, canvases, URL blob révoquées ?), courses asynchrones (ouvrir B pendant le chargement de A), erreurs avalées (catch {} silencieux — liste-les), taille des chunks du module PDF dans web-studio/dist/assets et temps de chargement du module, couverture de tests réelle (quelles opérations n'ont aucun test sur un vrai PDF), dette structurelle. Règle produit « parité double plateforme » : toute fonctionnalité doit exister dans la suite locale ET le Drive cloud — le Drive peut-il ouvrir/éditer un PDF ? Propose l'architecture cible (découpage du monolithe, store, worker, virtualisation) avec justification.` },
]

phase('Diagnostic')
const results = await pipeline(
  DOMAINS,
  (d) => agent(`${COMMON}${['textedit', 'forms'].includes(d.key) ? '' : RESUME2}\n\n=== TON DOMAINE : ${d.key} — ${d.title} ===\n${d.scope}\n\nTon dossier de travail : ${HARNESS}\\diag\\${d.key}\\ . Mets domain="${d.key}" et des id "${d.key}-NN".`,
    { label: `diag:${d.key}`, phase: 'Diagnostic', schema: FINDINGS_SCHEMA }),
  async (diag, d) => {
    if (!diag) return null
    const hi = diag.findings.filter((f) => f.severity === 'P0' || f.severity === 'P1')
    if (!hi.length) return { ...diag, verification: { verdicts: [], missed: [] } }
    const verification = await agent(`${COMMON}\n\n=== RÔLE : VÉRIFICATEUR ADVERSARIAL du domaine ${d.key} — ${d.title} ===
Un autre agent a produit les constats P0/P1 ci-dessous. Pour CHACUN, rejoue la repro toi-même (écris tes propres scripts dans ${HARNESS}\\diag\\${d.key}-verify\\ — tu peux t'inspirer des siens mais exécute-les), et tente de le RÉFUTER : bug réellement dans le code de production (pas dans le script de test) ? reproductible ? sévérité juste ? cause racine exacte ? Par défaut, si tu ne parviens pas à reproduire, verdict="refuted" ; si ambigu, "unclear". Corrige la sévérité si elle est exagérée ou sous-estimée. Signale dans "missed" tout défaut important découvert en chemin.

Constats à vérifier :
${JSON.stringify(hi, null, 1)}`,
      { label: `verify:${d.key}`, phase: 'Vérification', schema: VERDICT_SCHEMA })
    return { ...diag, verification }
  },
)

const done = results.filter(Boolean)
log(`${done.length}/${DOMAINS.length} domaines diagnostiqués`)

phase('Complétude')
const digest = done.map((r) => ({
  domain: r.domain,
  parity: r.parity.map((p) => `${p.status}: ${p.feature}`),
  findings: r.findings.map((f) => `${f.severity} ${f.id} ${f.title}`),
}))
const critic = await agent(`${COMMON}\n\n=== RÔLE : CRITIQUE DE COMPLÉTUDE ===
Voici la liste compacte de tous les constats et tableaux de parité produits par 12 agents. Ne refais pas leur travail. Identifie ce qui MANQUE : fonctionnalités majeures d'Acrobat Pro non évaluées, scénarios réels non testés (ex. PDF de 100 Mo, PDF corrompu/réparé, PDF/A, PDF balisé/accessibilité, XFA, JavaScript, impression, multi-documents), problèmes transverses (mêmes causes dans plusieurs domaines), et incohérences entre domaines. Tu peux exécuter quelques vérifications rapides pour étayer (dossier ${HARNESS}\\diag\\critic\\). Retourne une liste priorisée des trous de couverture et des causes racines transverses, en français, texte libre structuré.

${JSON.stringify(digest, null, 1)}`, { label: 'critic', phase: 'Complétude' })

return { results: done, critic }
