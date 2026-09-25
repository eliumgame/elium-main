# FINDINGS — domaine organize (reprise, constats REJOUÉS)
Scripts : dossier courant. Node : `cd diag/organize && npx tsx --import ./register.mjs <script>.mts`. Playwright : `node <script>.mjs`.

## organize-01 — P1 — Les signets pointent vers de mauvaises pages après toute suppression/insertion/déplacement/exclusion de page
- repro : `npx tsx --import ./register.mjs 01-bookmarks-after-organize.mts` (word-contrat.pdf, transitions model/doc.ts de prod + buildPdf)
- preuve : aucune modif 8/8 corrects ; supprimer p.1 → 0/8 ; inverser → 1/8 ; déplacer p.7 en tête → 0/8 ; page blanche en tête → 0/8 ; exclure p.2 → 2/8 (« Article 3 → p.2 (titre réellement p.3) » etc.)
- cause : les signets stockent un n° de page SOURCE (PdfWorkspace.tsx:309 outlineToBookmarks, model/types Bookmark.page) ; save.ts:303 toOutlineEntries traite `page-1` comme index de SORTIE ; `D.remapBookmarkPages` (model/doc.ts:544) existe mais n'est JAMAIS appelé (grep : 0 appel).
- correction : faire porter aux signets un `pageId` (comme les annotations) et résoudre l'index de sortie via `byPageId` dans buildPdf ; supprimer/orpheliner les signets des pages supprimées ; à défaut appeler remapBookmarkPages dans chaque transition de pages.

## organize-02 — P1 — Étiquettes de page écrites fausses dans le PDF : « 1 » devient « 11 », « ii » devient « ii1 »
- repro : `npx tsx --import ./register.mjs 03-page-labels.mts`
- preuve : UI ["i","ii","1",…] → PDF relu par pdf.js getPageLabels ["i1","ii1","11","21",…] ; décimal 1..7 → ["11","21",…,"71"] ; « Annexe-A » → « Annexe-A1 » ; préfixe seul « Pièce » ×7 → « Pièce1…Pièce7 ».
- cause : ops/organize.ts:447-453 writePageLabels écrit l'étiquette déjà calculée comme PRÉFIXE `/P` ET ajoute `/S /D /St 1` → le lecteur concatène préfixe + numéro décimal ; et une plage par page au lieu d'une plage par style.
- correction : conserver dans le modèle (style, préfixe, début) par plage et écrire `{S:/r|/R|/a|/A|/D, P:prefix, St:start}` au début de chaque plage ; pour le style « none » n'écrire que `/P` sans `/S`.

## organize-03 — P1 — Extraire / Diviser / Fusionner cassent les liens internes (tous renvoient à la 1re page ou à rien)
- repro : `node gen-rich` (out/rich.pdf : 6 pages A..F, liens A→C Dest explicite, A→E Fit, A→D GoTo, A→F destination nommée) puis `npx tsx --import ./register.mjs 02-structure-survival.mts`
- preuve : export simple/suppression/inversion : liens OK (A→C A→E A→D A→F). Fusion rich+form-acro : « A→A A→A A→A A→∅ » ; division 1-3 : « A→A A→A A→A A→∅ » (C est pourtant dans la partie).
- cause : ops/organize.ts:138,167,251 `copyPages` (pdf-lib) recopie les /Dest [pageRef …] vers des COPIES orphelines de la page cible (hors arbre des pages) et ne recopie pas /Names /Dests du catalogue → destinations nommées perdues.
- correction : après copyPages, réécrire chaque /Dest et /A /D des annotations Link (et du plan) en mappant ancienne réf. de page → nouvelle réf. copiée (ou supprimer le lien si la cible n'est pas dans le lot) ; recopier /Names/Dests filtré.

## organize-04 — P1 — Extraire/Diviser/Fusionner perdent l'AcroForm : les champs deviennent des widgets morts non remplissables
- repro : idem 02-structure-survival.mts
- preuve : « extraire C-E : widgets champ_p4@D case_p4@D | AcroForm=false getFieldObjects=[] » ; fusion rich+form-acro : 16 widgets, AcroForm=false, getFieldObjects=[] ; division 4-6 idem.
- cause : ops/organize.ts:118-153 / 166-169 / 250-253 créent un PDFDocument neuf et n'y copient que les pages ; le dictionnaire /AcroForm (Fields, DR, DA, NeedAppearances) n'est jamais recréé.
- correction : reconstruire /AcroForm dans la sortie : collecter les widgets copiés, remonter leurs /Parent jusqu'aux champs racine, les ajouter à /Fields, copier /DR /DA ; en fusion, renommer les champs homonymes (Acrobat : « nom#1 »).

## organize-05 — P1 — Extraire avec une page exclue (« Exclure de l'export ») extrait la MAUVAISE page
- repro : 02-structure-survival.mts, cas « A exclue puis extraire C »
- preuve : sélection = page C → fichier extrait contient « ordre=D ».
- cause : PdfWorkspace.tsx:1204 calcule les indices dans `pages` (pages exclues comprises) puis 1310-1311 les applique à la sortie de buildPdf, qui a retiré les pages `skipped` (save.ts:108).
- correction : calculer les indices dans `pages.filter(p => !p.skipped)` (ou mieux, extraire par pageId dans buildPdf avec un filtre `onlyPageIds`).

## organize-06 — P2 — Supprimer/dupliquer une page laisse des champs fantômes / orphelins
- repro : 02-structure-survival.mts (cas « supprimer B », « dupliquer D »)
- preuve : après suppression de B, getFieldObjects liste encore `champ_p2` (dont le seul widget a disparu) ; après duplication de D, 5 widgets mais 3 champs (les widgets copiés ne sont rattachés à aucun champ de /Fields).
- cause : save.ts:126-137 (copyPages de la page dans le même document, removePage) sans mise à jour de /AcroForm /Fields.
- correction : à l'export, purger de /Fields les champs dont aucun widget n'est sur une page de sortie ; pour une page dupliquée, créer des widgets enfants du même champ (valeur partagée, comme Acrobat) ou des champs renommés `nom#1`.

## organize-07 — P1 — En-tête / pied / filigrane mal placés sur les pages pivotées (/Rotate ou rotation faite dans Organiser)
- repro : `npx tsx --import ./register.mjs 04b-decorate-centers.mts` (centre visuel des textes ajoutés, relu par pdf.js avec le viewport /Rotate)
- preuve : mixed-geometry p3 (/Rotate 90) « HDR:milieu-droite angle=90° » et pied « bas-gauche angle=90° » ; p4 (/Rotate 180) en-tête « bas-centre angle=180° » (en bas, à l'envers) ; p6 (/Rotate 270) « milieu-gauche angle=-90° » ; filigrane angle 90/180/-90 ; word-contrat p1 pivotée 90° dans Organiser : « HDR:milieu-droite angle=90° ». Pages non pivotées : correct (haut-centre / bas-droite).
- cause : ops/decorate.ts:92,183-193 calculent x/y dans l'espace NON pivoté de la page (frame.box) sans tenir compte de /Rotate ; save.ts:207-210 applique la rotation utilisateur AVANT l'étape 6 (décoration).
- correction : composer la matrice inverse de /Rotate (comme Acrobat « relative à la page affichée ») : `cm` de rotation autour de la boîte selon page.getRotation() avant de peindre, avec W/H permutés à 90/270.

## organize-08 — P1 — Numérotation Bates silencieusement absente dès qu'un en-tête ou un pied est activé
- repro : même script (dernier bloc)
- preuve : « Bates activé + en-tête « {title} » : numéros Bates trouvés sur 0/7 pages » ; « Bates activé seul : 7/7 ».
- cause : ops/save.ts:294 `if (state.bates.enabled && !state.footer.enabled && !state.header.enabled && bates)` — le tampon Bates n'est posé que si aucune bande n'est active, même si aucune bande ne contient `{bates}`.
- correction : poser le tampon Bates sauf si une bande active contient réellement le jeton `{bates}` ; offrir position/police/taille/plage pour Bates (Acrobat) et la continuité de numérotation sur plusieurs fichiers.

## organize-09 — P2 — Texte d'en-tête/pied dégradé : « — » → « - », « œ » → « oe », CJK supprimé sans avertissement
- repro : même script ; en-tête saisi `HDR {page}/{pages} — Élève « œuvre » 日本`
- preuve : texte relu « HDR 1/7 - Élève « oeuvre » » (tiret cadratin et œ remplacés alors qu'ils existent en WinAnsi, 日本 supprimé).
- cause : ops/decorate.ts:189 `sanitiseForFont` + ops/decorate.ts:180 police standard Helvetica (WinAnsi) — pas de police Unicode embarquée pour les marques de page.
- correction : embarquer une police Unicode sous-ensemble (Noto Sans / police de l'utilisateur) quand le texte sort de WinAnsi, et ne translittérer que les caractères réellement absents ; avertir sinon.

## organize-10 — P0 — Enregistrer un PDF chiffré (même « propriétaire seul », sans mot de passe d'ouverture) après organisation produit un fichier ILLISIBLE
- repro : `npx tsx --import ./register.mjs 09-organize-encrypted.mts` (openLikeUi + supprimer dernière page + pivoter p1 + buildPdf, exactement le chemin exportPdf de PdfWorkspace)
- preuve : « encrypted-owner-only.pdf réouverture: Ce PDF est protégé par un mot de passe. » (l'original s'ouvre sans mot de passe) ; « encrypted-aes256-pwd-test.pdf réouverture: Mot de passe incorrect. » (avec le bon mot de passe `test`). pdf.js : « XRef.parse - Invalid Root reference ».
- cause : PdfWorkspace.tsx:296 garde les octets CHIFFRÉS dans bytesRef ; exportPdf (l.765) les passe à buildPdf, qui les charge avec `ignoreEncryption:true` (save.ts:100) alors que sa doc exige « sourceBytes must already be decrypted » (save.ts:76) ; pdf-lib réécrit un mélange d'objets chiffrés (anciens) et en clair (nouveaux) sous l'ancien /Encrypt → fichier corrompu. removeProtection n'est appelé que par la commande « unprotect » (l.1387).
- correction : à l'ouverture d'un PDF chiffré, déchiffrer une fois (removeProtection avec le mot de passe saisi / vide pour propriétaire seul) et stocker les octets en clair dans bytesRef ; ré-appliquer la protection d'origine à l'export si l'utilisateur ne l'a pas retirée (comme Acrobat).

## organize-11 — P0 — Fusionner / insérer un PDF chiffré donne des pages BLANCHES sans aucun avertissement
- repro : `npx tsx --import ./register.mjs 08-merge-encrypted.mts`
- preuve : word-contrat + encrypted-owner-only : `failed=[] counts=[7,3]`, texte de la page 8 = « » (0 car.) au lieu de « Rapport trimestriel — Édition Web… » ; idem avec encrypted-aes256-pwd-test (7 pages vides) ; pdf.js : « Unknown compression method in flate stream ».
- cause : ops/organize.ts:125 `PDFDocument.load(src.bytes, { ignoreEncryption: true })` copie les flux encore chiffrés ; `MergeSource.password` (l.99) n'est jamais utilisé ; l'UI (PdfWorkspace.tsx:1493) ne demande jamais de mot de passe pour les fichiers ajoutés.
- correction : détecter /Encrypt sur chaque source (inspectProtection), demander le mot de passe si besoin, déchiffrer via removeProtection avant copyPages ; sinon lister le fichier dans `failed` avec un message explicite.

## organize-12 — P1 — « Diviser par taille maximale » est quadratique : 94 s pour 1000 pages, 7,8 s pour 251 pages
- repro : `npx tsx --import ./register.mjs 06-split-perf.mts edge-1000pages.pdf maxSize 2` et `… word-250pages.pdf maxSize 1`
- preuve : « edge-1000pages.pdf (5.01 Mo) split maxSize 2 Mo → 2 parties en 94267 ms » (148 s lors de la 1re tentative, machine chargée) ; « word-250pages.pdf split maxSize 1 Mo → 1 parties en 7777 ms » ; UI figée tout ce temps (thread principal, pas de worker, pas de progression, pas d'annulation).
- cause : ops/organize.ts:230-238 reconstruit et resérialise un PDF complet (`buildSubset`) à CHAQUE page ajoutée → O(n²) copies/sérialisations.
- correction : estimer la taille par page une fois (taille des objets propres + ressources partagées dédupliquées), ou recherche dichotomique sur la frontière ; déporter dans un Worker avec barre de progression.

## organize-13 — P1 — Extraire 1 page d'un document à sommaire lié recopie TOUT le document (707 Ko pour 1 page)
- repro : `npx tsx --import ./register.mjs 07-extract-orphans.mts` (génère out/toc-120.pdf : p.1 = sommaire lié aux 119 autres pages)
- preuve : « source 120 p. = 706 Ko ; extraction de la SEULE page 1 = 707 Ko, pageCount=1, objets /Page dans le fichier = 120 » ; « liens de la page extraite : 119, cibles résolues par pdf.js = [1] » ; « division toutes les 10 pages : partie 1 = 711 Ko (au lieu de ~59 Ko) ».
- cause : ops/organize.ts:167 / 251 copyPages suit /Annots → /Dest → page cible et embarque chaque page cible (contenu, polices, images) comme objet orphelin.
- correction : avant copyPages, retirer temporairement ou réécrire les /Dest pointant hors sélection (cf. organize-03), puis restaurer ; ou copier via un copieur qui ne traverse pas les références de page.

## organize-14 — P1 — « Diviser aux signets » perd des pages : pages avant le 1er signet, signets non triés, ou après réorganisation
- repro : `npx tsx --import ./register.mjs 18-split-merge-delete.mts` (bloc [a], chemin UI : buildPdf puis splitDocument avec state.bookmarks)
- preuve : signets sur C et E → « rich-Chapitre 1=[CD] rich-Chapitre 2=[EF] — pages couvertes 4/6 » (A,B perdues) ; signets [Annexe p5, Intro p1] → 1 seul fichier [ABCDEF], la partie « Annexe » disparaît ; signets C,E puis suppression de A → « [DE] [F] — 3/5 ».
- cause : ops/organize.ts:215-224 ne trie pas `starts`, ignore les pages avant le premier signet, et `Math.max(0, to-from)` jette silencieusement les plages négatives ; PdfWorkspace.tsx:2633 passe des n° de page source non remappés (cf. organize-01) ; `level` est ignoré (seul le 1er niveau).
- correction : trier et dédupliquer les débuts, émettre une partie « début » pour les pages avant le 1er signet, résoudre les pages par pageId, gérer `level`.

## organize-15 — P1 — Fusionner / « Insérer depuis un PDF » écrase le plan (signets) du document courant
- repro : 18-split-merge-delete.mts bloc [b] (chemin onMergePick : buildPdf(courant) + mergeDocuments)
- preuve : « plan AVANT fusion : 9 entrées (Contrat de prestation | Article 1… ) » → « plan APRÈS fusion : 2 entrées : word-contrat→p1 | form-acro→p8 ».
- cause : ops/organize.ts:118-152 crée un document neuf, ne recopie aucun /Outlines des sources et n'écrit qu'une entrée par fichier ; le commentaire l.111 (« Bookmarks from each source are preserved ») est faux.
- correction : relire le plan de chaque source (pdf.js outline ou parcours pdf-lib), le décaler de l'offset de page et l'imbriquer sous l'entrée du fichier (comportement d'Acrobat « Combiner »).

## organize-16 — P2 — Supprimer des pages ne réduit pas le fichier : 10 pages gardées sur 251 = 447 Ko (52 Ko attendus)
- repro : 18-split-merge-delete.mts bloc [c]
- preuve : « word-250pages 575 Ko : 10 pages gardées sur 251 → export 10 p. = 447 Ko (extraction équivalente = 52 Ko) ; objets indirects dans l'export : 2044 ».
- cause : ops/save.ts:137 `doc.removePage` retire la page de l'arbre mais pdf-lib sérialise tous les objets du contexte (pas de ramasse-miettes) → contenus, images, polices des pages supprimées restent dans le fichier (et restent lisibles par un outil : fuite d'information si l'on supprime des pages confidentielles).
- correction : après réorganisation, copier les pages retenues dans un PDFDocument neuf (ou implémenter un GC par accessibilité depuis /Root) avant `save()`.
- preuve UI (organize-10) : `node 16-encrypted-ui.mjs 3210` → « encrypted-owner-only.pdf : export OK (toast « PDF exporté 3 pages ») ; réouverture → demande mdp=true » ; « encrypted-aes256-pwd-test.pdf … réouverture → demande mdp=true » et la saisie du bon mot de passe `test` affiche « Mot de passe incorrect. » (capture out/16-reopen-3210-encrypted-aes256-pwd-test.pdf.png). L'utilisateur reçoit un toast de SUCCÈS pour un fichier inutilisable.

## organize-17 — P1 — Taper « Retour arrière » dans un champ de dialogue ouvert depuis Organiser SUPPRIME la page sélectionnée
- repro : `node 19b-keys.mjs 3210` (rich.pdf → Organiser → clic sur la vignette 2 → bouton « Étiquettes de page » → taper « Annexe » dans Préfixe → Retour arrière) ; `node 19-ui.mjs 3210 keys` pour Ctrl+A
- preuve : « sélection « 1 sélectionnée » ; Retour arrière → champ « Annexe », pages 6→5 » (le caractère n'est PAS effacé, la page B l'est) ; Ctrl+A dans le champ → « 6 sélectionnées » (sélectionne les pages au lieu du texte).
- cause : ui/Organize.tsx:121-138 écoute `keydown` sur `window` sans tester si la cible est un INPUT/TEXTAREA/SELECT/contentEditable ni si une modale est ouverte (contrairement à PdfWorkspace.tsx:1628 qui calcule `inField`).
- correction : ignorer l'événement si `e.target` est un champ éditable ou si `document.querySelector('[aria-modal="true"]')` ; ne pas `preventDefault` dans ce cas.

## organize-18 — P2 — « Insérer une page blanche → Avant la page 1 » ajoute la page à la FIN
- repro : `node 19-ui.mjs 3210 blank` (ruban Organiser → Page blanche → Position « Avant la page », n° 1 → Insérer → Ctrl+S → Exporter ; export relu par order.mts)
- preuve : « ORDER 19-blank-before1-3210.pdf : ABCDEF· » (page blanche en 7e position au lieu de ·ABCDEF).
- cause : PdfWorkspace.tsx:2694 `pages[where === "before" ? at - 2 : at - 1]?.id ?? null` → pour at=1, index -1 → `null`, et insertBlankAfter(null) (l.1023) signifie « à la fin ».
- correction : passer un index d'insertion (0 pour « avant la page 1 ») au lieu d'un id « après ».

## organize-19 — P2 — Bouton « Redimensionner » (ruban Organiser › Géométrie) sans aucun effet
- repro : `node 19-ui.mjs 3210 resize`
- preuve : « clic « Redimensionner » → dialogues=0 ; toasts=[] (seuls les toasts d'import préexistants) ; texte page 815→815 car. » — rien ne se passe.
- cause : Ribbon.tsx:473 émet `resize`, mais PdfWorkspace.tsx `command()` n'a pas de `case "resize"` (tombe dans `default: return` l.1300) ; `scalePage` (ops/organize.ts:333) n'est appelé nulle part.
- correction : dialogue « Redimensionner les pages » (format cible, ajuster/échelle, portée) branché sur scalePage à l'export, ou retirer le bouton.

## organize-20 — P1 — Sous la CSP de bureau, la vue Organiser est aveugle ET un clic sur une page la fait pivoter
- repro : `node 19-ui.mjs 3210 image` / `insertpdf` (clic au centre de la cellule 3, resp. 2, pour la sélectionner) ; comparaison `node 19-ui.mjs 3211 image`
- preuve : capture out/19-image-org-test-image.png-3210.png : seules les étiquettes « 1 … 6 » s'affichent, aucune vignette (violations CSP « img-src data ») ; cellules réduites à 206×40 px ; l'export montre la page cliquée PIVOTÉE : « sizes=[…,"595x842r90",…] » (page C) et page B dans le scénario insertpdf ; sur :3211 le même clic sélectionne sans pivoter (sizes sans r90).
- cause : (connu) ui/Organize.tsx:71,86 vignettes en `<img src="data:…">` bloquées par `default-src 'self'` ; conséquence propre au domaine : `.pdfx-org__cellops` (Organize.tsx:261-298) recouvre alors toute la cellule effondrée et le clic de sélection tombe sur « Pivoter ».
- correction : dessiner les vignettes dans un `<canvas>` (ou blob: URL + `img-src blob:`) avec une hauteur réservée au ratio de la page ; placer les actions de cellule hors de la zone de clic principale.

## organize-21 — P1 — « Insérer depuis une image » : toujours ajoutée à la fin, vignette « Page blanche », WebP/GIF perdus à l'export sous la CSP
- repro : `node 19-ui.mjs 3210 image` et `node 19-ui.mjs 3211 image` (page C sélectionnée dans Organiser, puis bouton « Insérer une image » avec out/test-image.png puis out/test-image.webp, export)
- preuve : cellules « 1 2 3 4 5 6 7(Page blanche) » (position 7 au lieu de 4, libellé « Page blanche ») ; export :3210 PNG « ABCDEFI images/page=[…,1] » mais WebP « ABCDEF· images/page=[0,0,0,0,0,0,0] » (page vide, aucun avertissement) ; :3211 WebP « ABCDEFI … 1 » → la perte vient de la CSP.
- cause : PdfWorkspace.tsx:1562-1566 `D.insertPages(s, s.pages.length, …)` ignore la sélection ; Organize.tsx:61,89 aucune vignette si `page.from == null` ; ops/images.ts transcode WebP/GIF via `new Image()` + canvas sur une data: URL bloquée par la CSP, `images.get` renvoie null et save.ts:150-151 ignore la page silencieusement.
- correction : insérer après la dernière page sélectionnée ; vignette depuis l'image elle-même ; décoder via `createImageBitmap(blob)` (non soumis à img-src) et avertir si l'image n'a pu être intégrée.

## organize-22 — P1 — « Insérer depuis un PDF » = fusion en fin de document : ignore la position, ferme Organiser et efface l'historique d'annulation
- repro : `node 19-ui.mjs 3210 insertpdf` (Organiser, pivoter F puis sélectionner B, insérer mixed-geometry.pdf)
- preuve : « Organiser encore ouvert=false ; Annuler désactivé avant=false après=true ; export → ABCDEFmmmmmmm » (7 pages insérées en fin, pas après B ; plus aucune annulation possible).
- cause : Ribbon/Organize `insertFile` → `mergeInput` (PdfWorkspace.tsx:1113-1114) = même chemin que Fusionner : buildPdf + mergeDocuments + `openBytes` (l.1500) qui recharge tout (reset() de l'historique l.357, setMode("view") l.369) ; aucune boîte « Insérer des pages » (position, plage de pages source).
- correction : boîte de dialogue Acrobat (Emplacement : avant/après page N, première/dernière ; pages du fichier source), insertion comme pages `from` d'une seconde source dans le modèle, sans recharger ni perdre l'historique.

## organize-23 — P2 — Glisser-déposer : impossible de placer une page en dernière position
- repro : `node 19-ui.mjs 3210 drag`
- preuve : A→C « BACDEF » (insère AVANT la cible) ; A→F (dernière) « BCDEAF » ; A→bouton Ajouter « ABCDEF » (rien).
- cause : ui/Organize.tsx:247-256 dépôt uniquement SUR une cellule, interprété comme « avant cette cellule » (reorderPages(ids, i)) ; pas de zone de dépôt après la dernière cellule ni de moitié droite/gauche ; pas d'indicateur d'insertion entre vignettes.
- correction : calculer la position d'insertion selon la moitié de la cellule survolée (avant/après), accepter le dépôt sur `.pdfx-org__add`/fin de grille, afficher une barre d'insertion comme Acrobat.

## organize-24 — P1 — Filigrane, en-tête/pied et Bates invisibles à l'écran : seul l'export les montre
- repro : `node 19-ui.mjs 3210 wmview` (Filigrane → Appliquer ; En-tête → activer, centre « EN-TETE VISIBLE ? » → Appliquer ; capture de la page 1 ; export) puis `npx tsx --import ./register.mjs 19c-text.mts out/19-wm-3210.pdf`
- preuve : « la vue contient « CONFIDENTIEL »=false « EN-TETE »=false » (capture out/19-wm-view-3210.png : page nue) alors que l'export contient « … CONFIDENTIEL EN-TETE VISIBLE ? ». L'utilisateur clique « Appliquer » et rien ne change → impression que la fonction ne marche pas.
- cause : ui/PageView.tsx ne dessine aucune des marques (state.watermark/header/footer/bates ne sont lus que par ops/save.ts:287-297) ; les dialogues n'ont qu'un aperçu schématique (WatermarkDialog, l.493-517) ou aucun (HeaderFooterDialog).
- correction : calque d'aperçu dans PageView réutilisant la géométrie de decorate.ts (même calcul que l'export), et aperçu réel de la page courante dans les dialogues (comme Acrobat).

## organize-25 — P1 — Recadrer DÉPLACE toutes les annotations : le surlignage d'un relecteur se retrouve sur une autre phrase
- repro : `npx tsx --import ./register.mjs 05-crop.mts` (annotated.pdf, recadrage haut=100 gauche=100, chemin UI openLikeUi + cropPages + buildPdf) ; visuel : `node 20-crop-ui.mjs` (UI :3210, export rouvert)
- preuve : rect PDF avant → après : Highlight [70,642,400,657] → [165,537,505,562] Δ=(95,-105) ; Text Δ=(95,-103) ; FreeText [300,80,540,120] → [395,-25,645,25] (sort de la page) ; Ink Δ=(92,-108) ; Square Δ=(88,-112) ; StrikeOut Δ=(95,-105). Capture out/20-crop-reopened.png : surlignage jaune sur « Les parties conviennent… » du paragraphe suivant, carré vert descendu sur « Article 2 », texte libre devenu un bloc rouge hors page.
- cause : les annotations du modèle sont en coordonnées relatives à la boîte visible ; save.ts:207-208 applique cropPage (nouvelle CropBox) AVANT l'étape 4 (l.228-229) qui recalcule `pageFrame(page)` sur la boîte recadrée → chaque annotation est translatée de (gauche, -haut) par rapport au contenu.
- correction : écrire les annotations avec le cadre d'ORIGINE (pageFrame avant recadrage), ou compenser le décalage ; ajouter un test de non-régression « crop conserve Rect ».

## organize-26 — P2 — L'aperçu du recadrage à l'écran montre la mauvaise zone (coupe à droite/en bas au lieu d'en haut/à gauche)
- repro : `node 20-crop-ui.mjs` (captures out/20-crop-before-3210.png, 20-crop-view-3210.png, 20-crop-reopened.png)
- preuve : après « Haut 100 / Gauche 100 », la vue affiche toujours l'en-tête « Exemple SAS — Confidentiel » et la marge gauche (cadre 572×857 px, canvas 687×972 px sans décalage) ; seul le PDF exporté est réellement rogné en haut/à gauche. Même constat sur word-contrat (out/15-crop-view-3211.png, tentative précédente).
- cause : PdfWorkspace.tsx:424-432 `sizeOf` réduit la taille du cadre selon `crop` mais PageView ne décale pas le canvas de (-left, -top) : le cadre `overflow:hidden` tronque donc à droite et en bas.
- correction : translater le canvas/les calques de (-crop.left, -crop.top)·échelle, ou rendre avec un viewport pdf.js décalé ; ajouter dans CropDialog un rectangle de recadrage déplaçable sur la page (Acrobat « Définir les zones »), avec « Supprimer les marges blanches ».

## organize-27 — P2 — Recadrage d'une page /Rotate : « Haut » rogne le bord visuellement à DROITE
- repro : 05-crop.mts (2e bloc) — mixed-geometry p3 (/Rotate 90), Haut=150
- preuve : « MediaBox 612×792 → CropBox height 642 ; bord non pivoté retiré : haut(y1) » → à l'écran (/Rotate 90) c'est le bord droit qui disparaît.
- cause : ops/organize.ts:320-330 cropPage applique top/right/bottom/left dans l'espace non pivoté sans tenir compte de page.getRotation().
- correction : permuter les marges selon la rotation effective (source + utilisateur) avant de calculer la CropBox.

## organize-28 — P1 — Vue Organiser sur 1000 pages : 47 000 nœuds DOM, 14,6 s de longues tâches pour défiler, 211 Mo de tas, vignettes jamais libérées
- repro : `node 11-organize-perf.mjs 3211` (edge-1000pages.pdf ; sans CSP pour que les vignettes existent)
- preuve : « entrée Organiser 1005 ms ; cells 1000, dom 47452 ; heap 76 Mo » ; défilement 40 crans de 2500 px : « 24482 ms ; imgs 380, dataUrlMB 26.8, heapMB 211 ; longues tâches n=98 total 14650 ms max 390 ms » ; glisser p1→p3 : 921 ms dont une tâche de 475 ms ; Ctrl+A + pivoter : 315 ms de longues tâches. (1re tentative : 11,8 s de longues tâches, mêmes ordres de grandeur.)
- cause : ui/Organize.tsx:239-301 monte les 1000 cellules (pas de virtualisation) avec un IntersectionObserver chacune ; PageCard (l.69-71) rend chaque vignette sur le thread principal à `scale: 3` puis `canvas.toDataURL("image/png")` (encodage PNG synchrone, ~70 Ko de chaîne base64 par vignette) et ne la libère jamais ; tout changement de `pages` (rotation, glisser) re-rend la grille entière.
- correction : grille virtualisée (fenêtre de ~50 cellules), rendu des vignettes dans un Worker/OffscreenCanvas à la taille exacte, `ImageBitmap`/`canvas` au lieu de data: URL, cache LRU borné, `React.memo` sur les cellules.

## organize-29 — P2 — Étiquettes de page d'origine ignorées : non affichées dans Organiser et décalées après suppression
- repro : `npx tsx --import ./register.mjs 02-structure-survival.mts` (rich.pdf porte /PageLabels i, ii, 1..4) ; `node 19-ui.mjs 3210 image` (libellés des cellules)
- preuve : Organiser affiche « 1 2 3 4 5 6 » au lieu de « i ii 1 2 3 4 » ; après « supprimer B » l'export garde « étiquettes=["i","ii","1","2","3"] » → la page C (ex-« 1 ») est désormais étiquetée « ii ».
- cause : openBytes (PdfWorkspace.tsx:288-357) ne lit jamais `getPageLabels()` dans le modèle ; save.ts:308 ne réécrit /PageLabels que si un label a été posé dans Elium, sinon le /PageLabels source (indexé par position) est conservé tel quel après réorganisation.
- correction : importer les étiquettes source dans `Page.label` (ou mieux, en plages style/préfixe/début) à l'ouverture et toujours réécrire /PageLabels à l'export.

## organize-30 — P2 — En-tête/pied/filigrane non reconnus à la réouverture : les ré-appliquer les EMPILE ; aucune balise /Artifact dans un PDF balisé
- repro : `npx tsx --import ./register.mjs 21-decor-more.mts` (blocs [b] et [c])
- preuve : « après réouverture de l'export : état en-tête reconnu = false » ; « ré-appliquer le même en-tête → occurrences sur p1 = 2 » ; word-contrat balisé (StructTreeRoot) : flux ajouté « q\nq\n0.2 0.255 0.333 rg\nBT\n/Helvetica… » sans `/Artifact BDC` → l'en-tête devient du contenu non balisé (échec au contrôle d'accessibilité, lu par les lecteurs d'écran au milieu du texte).
- cause : ops/decorate.ts:129-132,198,223 ajoutent un flux brut sans marquage (Acrobat : `/Artifact <</Subtype/Header|Footer|Watermark>> BDC … EMC` + /PieceInfo pour « Mettre à jour/Supprimer ») ; rien n'est relu à l'ouverture.
- correction : encadrer chaque marque d'un contenu marqué /Artifact typé (Pagination/Header/Footer/Watermark) + dictionnaire privé, et proposer Mettre à jour / Supprimer en détectant ces marques à l'ouverture.

## organize-31 — P1 — Chaque enregistrement après une opération d'organisation fait GROSSIR les rectangles et zones de texte libre annotés (dérive cumulative)
- repro : `npx tsx --import ./register.mjs 23b-drift-all.mts` (annotated.pdf, 4 cycles ouvrir → buildPdf) ; détail du tracé : `npx tsx --import ./register.mjs 23-annot-drift.mts` (cycle = pivoter la dernière page + enregistrer)
- preuve : Square 200x80 → 224x104 → 248x128 → 272x152 → 296x176 ; FreeText 240x40 → 250x50 → 260x60 → 270x70 → 280x80 ; le CARRÉ DESSINÉ grossit aussi (apparence /AP /N : « 61.5 301.5 197 77 re » → « 49.4 289.4 221.2 101.2 re » → « 37.3 277.3 245.4 125.4 re ») ; le modèle réimporté vaut w=200 → 224.2 → 248.4. Highlight/Ink/StrikeOut stables (géométrie relue depuis QuadPoints/InkList). Rotation seule : aucun décalage propre (Δ identique au cycle sans rotation — OK).
- cause : ops/annots-pdf.ts:806-807 `inflateForStroke` : `a.lineEnd !== "none"` est vrai quand lineEnd est `undefined` (carrés, cercles, texte libre) → +9,6 pt de marge « tête de flèche » ; le /Rect gonflé est écrit sans /RD ; ops/import-annots.ts:508 `rectFrom(a.rect)` reprend ce /Rect comme géométrie de la forme → +2×marge à chaque cycle.
- correction : tester `(a.lineEnd ?? "none") !== "none"` ; écrire /RD (différence Rect − forme) et, à l'import, soustraire /RD (PDF 32000 §12.5.6.8) ; test de non-régression « ouvrir-enregistrer ×3 = identité ».

## organize-32 — P2 — Dupliquer une page fait RÉAPPARAÎTRE sur la copie une image que l'utilisateur avait supprimée
- repro : `npx tsx --import ./register.mjs 22-rotate-dup.mts` (bloc [b] : scan-jpeg p1, imageEdit « delete » puis D.duplicatePages)
- preuve : « images réellement peintes/page (pdf.js) = [0,1,1,1,1,1,1] » (attendu [0,0,1,…]) ; « imageEdits après duplication=1 » : la page originale est bien vidée, la copie montre l'image supprimée (et le contenu de l'image reste dans le fichier).
- cause : model/doc.ts:80-101 `duplicatePages` recopie annots, contentEdits et createdFields mais PAS `imageEdits` (ni l'état de caviardage appliqué).
- correction : dupliquer aussi `state.imageEdits` (nouvel id, pageId de la copie) ; test couvrant toutes les collections indexées par pageId.

## organize-33 — P2 — Dupliquer une page recopie polices et ressources : +28 Ko par copie (fichier ×5 pour 10 copies)
- repro : 22-rotate-dup.mts bloc [c] (word-contrat p1 dupliquée 10×)
- preuve : « 17 p., 350 Ko (sans duplication 71 Ko ; +28 Ko par copie) ; objets /Font=69 ».
- cause : ops/save.ts:125-128 `doc.copyPages(doc, [model.from])` à l'intérieur du même document : le copieur pdf-lib clone récursivement /Resources (polices embarquées, images) au lieu de réutiliser les mêmes références.
- correction : pour une copie dans le même document, créer un nouveau /Page qui référence le MÊME /Contents et le MÊME /Resources (seuls /Annots et les widgets doivent être clonés) — c'est ce que fait Acrobat (une copie coûte ~1 Ko).

## organize-34 — P3 — Page blanche insérée depuis Organiser toujours en A4 portrait, même entre deux pages paysage/A3
- repro : 22-rotate-dup.mts bloc [d] (chemin insertBlankAfter de la cellule « Insérer après ») 
- preuve : mixed-geometry, insertion après p2 (842x595 paysage) → nouvelle page 595x842.
- cause : ui/PdfWorkspace.tsx:1021 `insertBlankAfter(afterId, count = 1, size = PAGE_SIZES.A4)` ; Organize.tsx:176,280,309 appellent onInsertBlank sans taille.
- correction : par défaut, reprendre la taille (et l'orientation affichée) de la page de référence, comme Acrobat.

## organize-35 — P1 — « Insérer depuis un PDF » dans un gros document : 36 s pour ajouter 7 pages à un PDF de 1000 pages
- repro : `node 24-ui-more.mjs 3210 insert1000` (edge-1000pages.pdf ouvert, ruban Organiser, sélection de word-contrat.pdf dans l'entrée « Depuis un PDF ») ; coût Node équivalent : `npx tsx --import ./register.mjs 17-extract-cost.mts`
- preuve : « insertion de word-contrat (7 p.) dans edge-1000pages : 36388 ms jusqu'au toast ; longues tâches n=18 total=2144 ms max=313 ms » ; Node : « edge-1000pages (1000 p.) : buildPdf 1182 ms … insertion d'un PDF de 7 p. = buildPdf + merge 7629 ms (puis réouverture complète) ». Acrobat : insertion quasi instantanée, historique conservé.
- cause : PdfWorkspace.tsx:1484-1507 onMergePick : buildPdf du document ENTIER + mergeDocuments (copyPages des 1000 pages dans un document neuf, ops/organize.ts:118-152) + `openBytes` qui recharge pdf.js, réimporte toutes les annotations et remonte les 1000 pages (cf. organize-22).
- correction : insérer les pages comme une seconde source dans le modèle (Page.from = {source, index}) sans reconstruire ni recharger ; ne matérialiser qu'à l'export.

## organize-36 — P2 — Filigrane IMAGE : WebP/GIF perdus sans avertissement sous la CSP de bureau ; aperçu du dialogue bloqué
- repro : `node 24-ui-more.mjs 3210 wmimage` puis `node 24-ui-more.mjs 3211 wmimage` (Modifier › Filigrane › Image › Choisir… out/test-image.png puis out/test-image.webp › Appliquer › exporter)
- preuve : :3210 PNG « images/page=[1,1,1,1,1,1] » ; WebP « images/page=[0,0,0,0,0,0] » (aucun filigrane, aucun message) ; :3211 WebP « [1,1,1,1,1,1] » ; violations CSP « img-src data » (aperçu `<img src="data:">` du dialogue bloqué).
- cause : même racine que organize-21 : ops/images.ts transcode WebP/GIF par `new Image()` sur une data: URL (bloquée par `default-src 'self'`) ; decorate.ts:98-99 `if (img)` ignore silencieusement l'échec ; dialogs.tsx:406-411 stocke l'image en data: URL et l'affiche en `<img>`.
- correction : décoder via `createImageBitmap(file)` + OffscreenCanvas, conserver un Blob/ArrayBuffer plutôt qu'une data: URL, et signaler l'échec dans le rapport d'export.

## organize-37 — P3 — Barre Organiser sans sélection : « Dupliquer » double TOUT le document sans confirmation ; « Supprimer » ne fait rien sans rien dire
- repro : `node 24-ui-more.mjs 3210 dupnosel`
- preuve : « Dupliquer 6→12 pages (tout le document dupliqué, sans confirmation) ; Supprimer → 12 pages » (aucun toast).
- cause : ui/Organize.tsx:103 `targets = has ? p.selected : tous les ids` utilisé pour Pivoter/Dupliquer/Extraire/Supprimer ; model/doc.ts:67-68 deletePages renvoie l'état inchangé si tout serait supprimé.
- correction : désactiver les actions de page quand rien n'est sélectionné (Acrobat) ou demander confirmation ; message explicite « impossible de supprimer toutes les pages ».

## organize-38 — P2 — Organiser inutilisable au clavier et sans sélection au lasso (pourtant annoncée) : flèches inertes, cellules non focalisables, 4 arrêts Tab invisibles par page
- repro : `node 25-org-a11y.mjs 3211` (rich.pdf, Organiser)
- preuve : « cellules focalisables/rôle = 0/6 ; clic p1 → [1] ; Flèche droite → [1] ; Maj+Flèche droite → [1] » ; « Tab ×12 → button[Pivoter] button[Dupliquer] button[Insérer après] button[Supprimer] … » (boutons de survol invisibles, 4000 arrêts Tab sur 1000 pages) ; « lasso depuis le vide de la grille jusqu'à la cellule 3 → « 6 pages » » (rien sélectionné).
- cause : ui/Organize.tsx:239-301 cellules `<div draggable onClick>` sans tabIndex/role (option/gridcell), aucun gestionnaire de flèches dans le keydown (l.121-138) ; le commentaire l.27 « rubber-band multi-selection » n'est implémenté nulle part (aucun pointerdown/mousedown).
- correction : grille ARIA (role=listbox/grid, aria-selected, roving tabindex), flèches/Maj+flèches/Début/Fin, Ctrl+X/V pour déplacer (Acrobat : couper/coller des vignettes), lasso par pointerdown sur le fond.

## organize-39 — P3 — Vignette d'une page pivotée à 90° déborde de sa cellule et chevauche la voisine
- repro : `node 25-org-a11y.mjs 3211` (capture out/25-rot-thumb-3211.png)
- preuve : cellule x=580 w=206 ; image pivotée x=548 w=269 (déborde de 32 px à gauche et 31 px à droite, la cellule suivante commence à 804 → recouvrement visible sur la capture).
- cause : ui/Organize.tsx:86 `transform: rotate(90deg)` CSS sur une image dimensionnée en portrait, sans permuter largeur/hauteur ni réserver la place.
- correction : rendre la vignette avec la rotation (viewport pdf.js `rotation`) ou dimensionner le conteneur selon l'orientation après rotation.

## organize-40 — P1 — Extraire / Diviser / Fusionner produisent des PDF amputés : plus aucun signet, balisage d'accessibilité, langue, métadonnées ni étiquettes
- repro : `npx tsx --import ./register.mjs 26-split-meta.mts` (chemin UI : buildPdf puis extractPages / splitDocument / mergeDocuments)
- preuve : export complet word-contrat « signets=9 StructTreeRoot=true MarkInfo=true Lang=(fr) Author=… XMP=true » → « extraire p1-3 : signets=0 StructTreeRoot=false MarkInfo=false Lang=- Author=null XMP=false » ; « diviser /4 (1) » idem ; rich.pdf « Title="Document riche de test" labels=["i","ii","1"] » → extraction 3-4 « Title=null labels=null » ; fusion : « signets=2 StructTreeRoot=false … Title=null ».
- cause : ops/organize.ts:156-168 (extractPages), 245-251 (buildSubset) et 118-152 (mergeDocuments) créent un `PDFDocument.create()` vierge et n'y copient que les objets /Page : ni /Outlines filtré, ni /StructTreeRoot (+ /StructParents des pages → balises orphelines), ni /Lang, /MarkInfo, /Info, /Metadata, /PageLabels, /ViewerPreferences.
- correction : partir d'une copie du catalogue source puis élaguer (pages non retenues, signets hors sélection, sous-arbre de structure des pages retirées) plutôt que d'un document vide ; recopier Info/XMP/Lang/MarkInfo ; renuméroter /PageLabels.

## organize-41 — P2 — Fonctions Acrobat absentes : Remplacer des pages, Arrière-plan, couper/copier/coller de pages, menu contextuel des vignettes ; options de Combiner/Diviser/Extraire minimales
- repro : `node 27-commands.mjs` (inventaire des commandes visibles sur :3210 : ruban Organiser, ruban Modifier, barre d'Organiser, clic droit sur une vignette)
- preuve : « Absents : Remplacer, Arrière-plan, Presse-papiers, Copier, Coller, Couper » ; « Menu contextuel sur une vignette (clic droit) : 0 menu(s) » ; grep du module : aucune fonction de remplacement de pages ni d'arrière-plan (ops/decorate.ts:2 annonce « backgrounds » mais seul le filigrane « derrière » existe). Fusionner = sélecteur de fichiers brut (ordre imposé, pas de plages par fichier, pas de retrait) ; Diviser : 4 modes sans « nombre de fichiers », signets figés au 1er niveau (PdfWorkspace.tsx:2632 `level: 1`), ni dossier ni modèle de nom ; Extraire : un seul fichier, pas « supprimer après extraction » ni « fichiers séparés » (PdfWorkspace.tsx:1306-1312).
- cause : fonctionnalités non implémentées (ui/Ribbon.tsx:457-480, ui/Organize.tsx:141-230, ui/dialogs.tsx:1285-1373).
- correction : boîte « Remplacer des pages » (plage cible ↔ plage d'un autre PDF, en conservant annotations/champs de la cible comme Acrobat), « Arrière-plan » (couleur/fichier, plage, échelle, opacité, /Artifact Background), presse-papiers de pages (Ctrl+X/C/V, y compris entre documents), menu contextuel, dialogue Combiner avec liste ordonnable et plages.

## organize-42 — P2 — Diviser déclenche N téléchargements successifs hors geste utilisateur (pas d'archive, pas de choix de dossier)
- repro : `node 24-ui-more.mjs 3210 split` (rich.pdf, Diviser toutes les 2 pages)
- preuve : en Playwright (téléchargements auto-acceptés) « 3 téléchargement(s) reçus → rich-1-2.pdf: AB ; rich-3-4.pdf: CD ; rich-5-6.pdf: EF » (contenu correct). Dans Edge réel, les téléchargements 2..N sont lancés après un `await` (plus de geste utilisateur) → Edge applique sa règle « téléchargements automatiques multiples » (demande/bloque) ; « toutes les 1 page » sur 1000 pages = 1000 téléchargements.
- cause : PdfWorkspace.tsx:2634 `for (const part of parts) downloadBlob(...)` après `await buildPdf/splitDocument` ; export/exporters.ts:1029-1038 lien `<a download>` + `revokeObjectURL` immédiat.
- correction : produire un ZIP unique (ou File System Access API `showDirectoryPicker` / dialogue natif du lanceur) avec modèle de nommage, et barre de progression.
- evidenceType : code-reading pour le blocage Edge (le découpage lui-même est vérifié exécuté).
