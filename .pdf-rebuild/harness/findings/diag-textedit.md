# FINDINGS — domaine textedit (Modifier le texte et les images)
# Chaque constat : id, sévérité, titre, repro, preuve, cause, correction. (reprise après interruption ; constats rejoués)

## textedit-01 — P0 — Chromium/Edge (CTM global non encadré) : la modification « native » écrit le texte minuscule, retourné, hors de sa place ; le paragraphe d'origine disparaît
- Repro : `cd diag/textedit && npx tsx --import ./register.mjs 09-edge.mts` (cas edge-title : « trimestriel »→« trimestre » dans le titre de edge-web.pdf p1) ; rendu : out/edge-compare-p1.png (milieu).
- Preuve : report native=1 ; opérateur ré-émis `AAAAAA+Georgia-Bold@21.997 ctm=[0.24,0,0,-0.24,0,841.92] origine=(12.2,660.6) taille effective=5.28` alors que le bloc est à y≈751..774 ; capture : le titre a disparu, un texte de 5 pt en miroir vertical apparaît dans la marge gauche.
- Cause : ops/textedit.ts:250-280 — le texte est ajouté APRÈS le contenu d'origine (l.300 `next.push(...emitted)`) sous le CTM courant ; Skia pose un `cm 0.24 0 0 -0.24 0 841.92` au niveau racine, jamais dépilé (pas de q/Q). Le `q…Q` ajouté ne remet pas la CTM à l'identité.
- Correction : encadrer le contenu d'origine dans `q … Q` avant d'ajouter le texte ré-émis (comme pdf-lib le fait pour ses ajouts), ou préfixer un `cm` inverse du CTM en vigueur à la fin du flux ; test de non-régression sur un PDF Chrome.

## textedit-02 — P0 — Tout caractère absent du sous-ensemble de LA police du premier fragment fait basculer TOUT le paragraphe en Helvetica (police, graisse, couleur perdues)
- Repro : `npx tsx --import ./register.mjs 02-word-edit.mts` (word-contrat p1, bloc B2 : « 10 000 € »→« 25 000 € ») et 04-native-rate.mts / 05-why-subst.mts.
- Preuve : report `{native:0, substituted:1}` pour un simple changement de chiffres ; police ajoutée `Helvetica` ; 04-native-rate : 9 blocs sur 20 de word-contrat basculent en substitution (tous les paragraphes de corps) ; 05-why-subst : F1 (Type0 Aptos) n'encode pas « f », qui est porté par F2 (TrueType Aptos, même famille). Edge : « rouge »→« rouge vif » → Helvetica, gras/italique/rouge perdus (out/edge-compare-p1.png droite).
- Cause : ops/textedit.ts:240-248 — une seule ressource `first.state.font` est retenue pour tout le bloc ; `wrapNative` renvoie null au premier caractère non encodable (l.83-84) → chemin de repli `fontBook.get(fontFamily)` (l.309) = police standard 14.
- Correction : encodage caractère par caractère sur l'ensemble des polices de la page de la même famille (F1+F2 Word = Aptos) ; sinon embarquer une police système proche (Acrobat utilise la police système installée) ; ne jamais réécrire tout le bloc pour un caractère.

## textedit-03 — P0 — Reflux cassé : les retours à la ligne d'origine sont conservés PUIS re-césurés → lignes orphelines, paragraphe 83 % plus haut, 3 lignes écrites sous le bas de la page (perte de texte)
- Repro : `npx tsx --import ./register.mjs 03-word-analyse.mts` après 02-word-edit.mts.
- Preuve : bloc B2 original 24 lignes (y 678.8→264.5) ; ré-émis 44 lignes de 678.8 à -49.6 ; lignes « Le présent contrat est conclu entre la société Exemple SAS, » / « et le » / « Prestataire… » ; `!!! 3 lignes ré-émises SOUS le bas de la page (y<0)`. Le texte déborde sur les paragraphes suivants (Article 2) puis hors page.
- Cause : ContentEditLayer.tsx:83 (`original/text` = block.text avec un `\n` par ligne visuelle, core/text.ts groupBlocks) + textedit.ts:94 et painter wrapText qui traitent chaque `\n` comme fin de paragraphe ; aucune contrainte de hauteur du bloc (textedit.ts:264-277, 314-324), aucun contrôle de débordement.
- Correction : joindre les lignes d'un même paragraphe par des espaces (ne garder que les vraies fins de paragraphe), refluer dans la largeur du bloc, et soit agrandir le bloc en repoussant (Acrobat), soit au minimum avertir/réduire le corps quand ça déborde ; jamais écrire hors de la CropBox sans avertir.

## textedit-04 — P1 — Caractères hors WinAnsi (Ω, ŷ, œ, —) supprimés ou dégradés SANS avertissement
- Repro : 02-word-edit.mts cas add-omega (en-tête « Exemple SAS — Confidentiel Ω ŷ Ÿ ») ; 09-edge.mts cas edge-b1.
- Preuve : texte extrait « Exemple SAS - / Confidentiel   Ÿ » : Ω=false ŷ=false, « — » devient « - » ; edge : « œuvre, cœur » → « oeuvre, coeur », « — » → « - » ; `report.warnings=[]`, aucun toast.
- Cause : ops/textedit.ts:310 `sanitiseForFont(f.edit.text, unicode)` (ops/fonts.ts) sur une police standard 14 WinAnsi ; le rapport ne compte qu'un `substituted` sans liste des caractères perdus.
- Correction : embarquer une police Unicode (sous-ensemble fontkit d'une police système/Noto) pour le repli ; si impossible, avertir en listant les caractères supprimés et bloquer la validation.

## textedit-05 — P1 — Détection de blocs : titre + intertitre fusionnés, un corps unique appliqué → la hiérarchie typographique est détruite à la moindre retouche
- Repro : `npx tsx --import ./register.mjs 01-blocks.mts word-contrat.pdf 0` puis 02-word-edit.mts (cas title-edit « services »→« conseil ») ; rendu `node render.mjs out/word-title-edit.pdf 1 out/word-title-edit-p1.png` ; comparaison out/word-title-pagenum-compare.png.
- Preuve : bloc B1 = « Contrat de prestation de services\nArticle 1 — Objet et modalités » (2 paragraphes, corps d'origine 20,04 et 15,96) ; ré-émis tous deux en `Aptos Display@18` → titre rapetissé, intertitre grossi (visible sur la capture). De même B2 = 24 lignes couvrant 3 paragraphes (427 pt de haut).
- Cause : core/text.ts groupBlocks (seuils d'interligne trop permissifs, pas de rupture sur changement de corps) ; TextBlock ne garde qu'un `fontSize` moyen (ContentEditLayer.tsx:86) ; textedit.ts:243 applique un corps unique.
- Correction : couper les blocs sur changement de corps/police/graisse et sur espacement inter-paragraphe ; conserver des « runs » stylés par ligne dans ContentEdit (police, corps, couleur par segment) et ne réécrire que les runs modifiés.

## textedit-06 — P1 — Un bloc court (numéro de page, cellule) est re-césuré à sa largeur d'origine : « Page 1 sur 7 » s'écrit un mot par ligne et sort de la page
- Repro : `npx tsx --import ./register.mjs 07-invisible.mts` ; rendu out/word-pagenum-p1.png (bas de page).
- Preuve : bloc « 1 » (largeur 6,4 pt) → 4 lignes « Page » y=38.6 / « 1 » 24.2 / « sur » 9.8 / « 7 » y=-4.6 (hors page) ; extraction : « Page 1 sur 7 » introuvable ; capture : mots empilés verticalement jusqu'au bord.
- Cause : ops/textedit.ts:248 `wrapNative(font, edit.text, size, box.w)` avec box.w = largeur du texte d'origine (pas de la colonne) ; aucun élargissement du cadre, pas de contrôle de sortie de page.
- Correction : pour un bloc d'une ligne, ne pas envelopper (laisser croître à droite/à gauche selon l'alignement), ou calculer la largeur disponible jusqu'au bord de la colonne/page ; laisser l'utilisateur redimensionner le cadre (inexistant, cf. textedit-12).

## textedit-07 — P1 — Ligne de tableau fusionnée en un seul bloc : modifier une cellule écrase les colonnes (« Audit sécurité 1 4 500,00 € » collé dans la 1re cellule)
- Repro : `npx tsx --import ./register.mjs 08-table.mts` ; capture out/word-table-row-p2-crop.png.
- Preuve : bloc B3 runs "Audit"@x75, "1"@x226, "4 500,00 €"@x377 fusionnés ; ré-émis en une seule ligne à x=74.7 ; capture : colonnes Quantité et Montant vides, tout le contenu dans la cellule Désignation.
- Cause : core/text.ts groupLines/groupBlocks ne coupe pas sur les grands écarts horizontaux ; textedit.ts:264-277 ré-écrit chaque ligne d'un seul Tm à box.x.
- Correction : couper les runs séparés par un écart > ~2 em (ou par des filets de tableau) en blocs distincts, comme Acrobat qui crée un bloc par cellule.

## textedit-08 — P1 — Pages /Rotate 90/270 : la zone d'édition n'est pas tournée — texte horizontal dans une colonne de 37 px, illisible
- Repro : `node 14-ui-rotated.mjs` (CSP 3210, mixed-geometry.pdf, zoom page entière) ; capture out/rot-p3-active.png.
- Preuve : p3 (/Rotate 90) textarea 37×420 px, scrollH 501 > clientH 418 ; p6 (/Rotate 270) 24×251 px ; capture : « Text / e / édita / ble » un fragment de mot par ligne, à côté du texte tourné de la page.
- Cause : ContentEditLayer.tsx:65-75 `place()` ne fait que la boîte englobante tournée ; la textarea (l.112-122) n'a aucun `transform: rotate()` ; idem ContentEditPreview.tsx:45-69 (aperçu écrit horizontalement sur une page tournée).
- Correction : poser la zone dans le repère non tourné (largeur/hauteur du bloc) et appliquer `transform: rotate(<rotation>deg)` avec `transform-origin` adéquat, comme pdf.js le fait pour sa couche texte.

## textedit-09 — P1 — Annuler/Rétablir : un simple clic sur un paragraphe crée une étape d'annulation vide et détruit la pile « Rétablir »
- Repro : `node 13-ui-actions.mjs` (CSP 3210, mixed-geometry.pdf) section B.
- Preuve : modification → Ctrl+Z (changed 0) → Ctrl+Y (changed 1) OK ; mais Ctrl+Z puis simple clic sur un autre bloc + Échap puis Ctrl+Y → `redoAfterMereClick: {changed:0, preview:0}` : la modification annulée est irrécupérable.
- Cause : ContentEditLayer.tsx:146 `p.onBeginChange()` (= `checkpoint`, PdfWorkspace.tsx:2232) appelé au CLIC, avant toute frappe ; ui/useUndoable.ts:36-37 `checkpoint` empile l'état et vide `future`. Échap (l.131-133) ne retire pas l'étape.
- Correction : ne faire le checkpoint qu'au premier `onChange` réel (ou au commit si texte ≠ original), et ne pas vider `future` pour un checkpoint sans changement.

## textedit-10 — P1 — Impossible de déplacer ou redimensionner un bloc de texte (aucune poignée, glisser sans effet)
- Repro : `node 13-ui-actions.mjs` section D.
- Preuve : `drag: {before:[71,695], after:[71,695], handles:0}`.
- Cause : ContentEditLayer.tsx:106-151 : le bloc n'est qu'un bouton `onClick` ; ContentEdit (model/types.ts:247-266) n'a pas de rect cible distinct de la position d'origine ; textedit.ts réécrit toujours dans `edit.rect`.
- Correction : ajouter `targetRect` au modèle + poignées de déplacement/redimensionnement (Acrobat : cadre du bloc déplaçable, largeur modifiable → reflux).

## textedit-11 — P1 — Aucune commande de police/corps/couleur/gras/italique/alignement pour le texte existant
- Repro : `node 13-ui-actions.mjs` section E (liste `editTabCommands`) ; lecture ContentEditLayer.tsx:157-178.
- Preuve : commandes de l'onglet Modifier en mode édition : « Réécrire le texte du PDF, Image, Machine à écrire, Masquer (blanc), Créer un lien, Filigrane… » — aucun sélecteur de police/taille/couleur ; la barre du bloc actif ne propose que « Supprimer » et « Rétablir ». Les champs `color` et `fontResource` de ContentEdit ne sont jamais renseignés par l'UI (grep : aucun appelant).
- Cause : ContentEditLayer.tsx:77-94 `commit()` recopie les attributs détectés du bloc sans possibilité de les modifier ; l'Inspecteur n'est affiché qu'en mode "view" (PdfWorkspace.tsx:2301).
- Correction : panneau « Format » (police de la page/système, corps, couleur, G/I/S, alignement, interligne) branché sur ContentEdit, avec aperçu ; mise en forme par sélection de caractères comme Acrobat.

## textedit-12 — P0 — « Modifier > Image » : sous la CSP de bureau, l'image choisie n'est JAMAIS posée (échec silencieux)
- Repro : `node 17-ui-image.mjs http://127.0.0.1:3210/ csp` puis `node 17-ui-image.mjs http://127.0.0.1:3211/ nocsp`.
- Preuve : 3210 → sélecteur de fichier ouvert, fichier choisi, `status "0 annotation"`, export `exportedAnnots: []`, console « Loading the image 'data:…' violates … default-src 'self' » ; 3211 → « 1 annotation », export `["/Stamp"]`, image visible (out/img-nocsp-p1.png vs out/img-csp-p1.png).
- Cause : ui/PdfWorkspace.tsx:1530-1550 : la taille est lue via `new Image(); img.src = dataURL` ; la CSP (`default-src 'self'`, pas de `img-src data: blob:`) bloque l'URL data: ; pas de `onerror` → aucune annotation, aucun message. Même motif dans ops/images.ts:37-44 (`imageSize`) et 47-56 (`toPngDataUrl`, utilisé à l'export pour WebP/GIF/JPEG CMJN).
- Correction : ajouter `img-src 'self' data: blob:` à la CSP de installer/elium_launcher.py ; indépendamment, lire les dimensions via `createImageBitmap(file)` (non soumis à img-src) ou en décodant l'en-tête PNG/JPEG, et gérer `onerror` avec un toast.

## textedit-13 — P1 — Images EXISTANTES du PDF : aucune interface pour les remplacer, déplacer, redimensionner, recadrer ou supprimer
- Repro : `node 13-ui-actions.mjs` (champ `imageTargetsInEditLayer`) ; `grep -rn upsertImageEdit ws/src` .
- Preuve : `imageTargetsInEditLayer: 0` en mode Modifier le texte ; `upsertImageEdit` (model/doc.ts:467) n'a AUCUN appelant dans l'UI ; `applyImageEdits` (ops/textedit.ts:355-397, testé seulement en unitaire) n'est donc jamais alimenté. Le modèle ImageEdit (types.ts:269-277) ne connaît que delete/replace — ni déplacement, ni recadrage, ni rotation.
- Cause : fonctionnalité non branchée : ContentEditLayer ne détecte que le texte (walkPlacements n'est utilisé que par la rédaction).
- Correction : détecter les XObjects image (walkPlacements + CTM → rectangle page) dans la couche d'édition, les rendre sélectionnables avec poignées ; étendre ImageEdit (matrice cible, clip de recadrage, rotation, remplacement) et réécrire le `cm` précédant le `Do`.

## textedit-14 — P1 — En mode « Modifier le texte », les outils Image et Machine à écrire du même onglet ne font rien
- Repro : `node 13-ui-actions.mjs` section E.
- Preuve : après « Modifier le texte » puis clic sur « Image » et clic sur la page : `imageToolInEditMode_fileChooser: false`, classe `pdfx--mode-editText` conservée.
- Cause : ui/PdfWorkspace.tsx:579-588 `pickTool` ne quitte pas le mode editText ; l'AnnotLayer qui gère ces outils n'est monté qu'en `mode === "view"` (l.2254).
- Correction : `pickTool` repasse en mode "view" (ou l'éditeur de contenu gère lui-même « Ajouter du texte / une image », comme la barre « Modifier le PDF » d'Acrobat).

## textedit-15 — P2 — « Ajouter du texte » = annotation FreeText (pas du contenu de page) ; Ω/ŷ supprimés et « — » dégradé dans l'apparence
- Repro : `node 15-ui-add.mjs` (3210) puis `npx tsx 18-freetext-inspect.mts out/add-ui-export-csp.pdf` et `node rpdfjs.mjs out/add-ui-export-csp.pdf 1 out/add-pdfjs-p1.png 1`.
- Preuve : saisie « Texte ajouté Ω ŷ — fin » → `/FreeText` (Contents complet) mais flux d'apparence `<546578746520616A6F7574E92020202D2066696E>` = « Texte ajouté   - fin » (rendu pdf.js out/add-pdfjs-crop.png) ; texte absent du contenu de page (extraction pdf.js inchangée). Rouvert dans Elium (out/add-typewriter-crop.png) le texte apparaît comme un rectangle plein sombre (import d'annotations, domaine annotations).
- Cause : outil typewriter (ops/annots-pdf.ts FreeText via FontBook standard WinAnsi + sanitiseForFont) ; aucun « ajout de texte » dans le flux de contenu.
- Correction : proposer l'ajout de texte réel dans le contenu (même chemin que textedit, police Unicode embarquée) ; à défaut, apparence FreeText avec police Unicode embarquée.

## textedit-16 — P0 — Texte sur deux colonnes (edge-web) : les colonnes sont fusionnées en un bloc ; changer UN mot réécrit tout l'article en pleine largeur, lignes entrelacées et mots collés
- Repro : `npx tsx --import ./register.mjs 19-edge-columns.mts` puis `node rpdfjs.mjs out/edge-columns.pdf 1 out/edge-columns-p1.png 1`.
- Preuve : B2 rect w=492.7 (les 2 colonnes), 35 « lignes » du type « Lorem ipsum dolor sit amet, consecteturadipiscing elit… » (ligne gauche + ligne droite concaténées) ; « Lorem »→« LOREM » ⇒ report subst=1, 35 lignes ré-émises toutes à x=51 en Helvetica ; « consecteturadipiscing » src=0 → out=2 ; capture : article illisible pleine largeur, texte justifié perdu, première ligne collée au dégradé.
- Cause : core/text.ts groupLines fusionne les runs de même ligne de base sans tenir compte de l'écart de gouttière ; groupBlocks (l.247-254) accepte alors les lignes qui se recouvrent ; textedit.ts réécrit le bloc entier.
- Correction : segmenter les lignes sur les écarts horizontaux > ~1,5 em (gouttière) avant groupBlocks ; détecter les colonnes (projection X) ; ne jamais concaténer deux runs sans espace.

## textedit-17 — P0 — Modification perdue en silence : texte dans un Form XObject → l'écran montre la modification, l'export annonce « PDF exporté », le fichier est inchangé
- Repro : `npx tsx --import ./register.mjs 20-synthetic.mts` (cas a : word-contrat p1 incorporée via pdf-lib embedPage, courant pour les PDF imposés/tamponnés/fusionnés).
- Preuve : 6 blocs détectés et éditables ; « services »→« conseil » ⇒ `report native=0 subst=0 skipped=1 warnings=[]` ; texte du PDF exporté : « prestation de conseil » = false, « services » = true.
- Cause : ops/textedit.ts:135 `walkText(ops)` ne parcourt que le flux de la page, pas les XObjects `Do` ; l.162-165 `report.skipped++` sans avertissement ; ui/PdfWorkspace.tsx:778-787 le toast n'affiche que `textBlocksNative` : `textBlocksSkipped` et `textBlocksSubstituted` ne sont JAMAIS montrés (vérifié aussi en UI : toasts « PDF exporté · 7 pages » seulement, 10-ui-word.mjs).
- Correction : descendre dans les Form XObjects (réécrire une copie du XObject propre à la page) ; en tout état de cause, avertissement bloquant « N paragraphe(s) n'ont pas pu être modifiés » + liste des substitutions de police.

## textedit-18 — P1 — Texte tourné (Tm 90°) : réécrit horizontalement en Helvetica, un fragment par ligne (« Te / xt / e / vertical / m / o / dif / ié »)
- Repro : `npx tsx --import ./register.mjs 20-synthetic.mts` (cas b, PDF synthétique out/synth-rotated.pdf).
- Preuve : bloc tourné rect w=14.8 h=132.6 ; ré-émis 8 opérateurs `Helvetica@14 tm=[1,0,0,1,28.24,y]` de y=421 à 303 ; report subst=1 (Times → Helvetica).
- Cause : ops/textedit.ts:244-248 : si `rotated`, le chemin natif est sauté ; le repli (l.305-331) ignore l'angle et enveloppe dans la largeur de la boîte englobante (14,8 pt).
- Correction : ré-émettre avec la matrice de texte d'origine (rotation conservée) et mesurer dans le repère du texte.

## textedit-19 — P1 — Style détecté faux : gras/italique jamais reconnus, famille réduite à « serif/sans-serif » → substitution en Helvetica même pour une police serif, aperçu en Arial
- Repro : `npx tsx --import ./register.mjs 01-blocks.mts edge-web.pdf 0` (titre Georgia-Bold) et 09-edge.mts cas edge-title-new.
- Preuve : titre « Rapport trimestriel » police AAAAAA+Georgia-Bold → bloc `fam=serif bold=false fontName=g_d0_f1` ; réécrit en `Helvetica@21.997` (ni serif ni gras) ; textarea d'édition : `font "Arial, Helvetica, sans-serif", weight 400` (10-ui-word.mjs, sur Aptos).
- Cause : core/text.ts:123-124 teste /bold|italic/ sur `it.fontName` = nom interne pdf.js (« g_d0_f1 ») et non le BaseFont ; l.122 `fontFamily = style.fontFamily` générique ; ui/fonts.ts pdfFamilyOf("serif") inconnu → "helvetica" ; fontCss(inconnu) → Arial.
- Correction : lire le BaseFont/FontDescriptor (Flags, FontWeight, ItalicAngle) via pdf-lib ou `page.commonObjs` ; mapper serif→Times, mono→Courier ; utiliser la police embarquée de la page pour l'aperçu (FontFace depuis le programme de police).

## textedit-20 — P2 — PDF balisé : le texte ré-émis perd son MCID (structure/accessibilité cassée)
- Repro : `npx tsx --import ./register.mjs 20-synthetic.mts` (cas c, sur out/word-title-edit.pdf).
- Preuve : original « Contrat de prestation de services » mcid=p3R_mc0, « Article 1… » mcid=p3R_mc1 ; après modification : mcid=AUCUN pour les deux.
- Cause : ops/textedit.ts:300 ajoute le texte en fin de flux, hors des BDC/EMC d'origine (les séquences marquées restent vides).
- Correction : ré-émettre à l'emplacement du premier opérateur supprimé (dans le même BDC /MCID), comme Acrobat qui conserve les balises.

### Addendum textedit-02 (cause précise sur Word)
- `npx tsx --import ./register.mjs 25-ligatures.mts` : F1 (BCDEEE+Aptos) n'a pas de glyphe « f » isolé, seulement la ligature CID 433→"fi" ; `encode("f")=null`, `encode("fi")=null` (encodeur caractère par caractère, fontmetrics.ts:510-519, ignore les correspondances multi-caractères). ⇒ tout paragraphe français contenant « f » (confidentialité, fin…) passe en Helvetica. Corriger : encodage glouton par la plus longue séquence de la table inverse (ligatures), puis repli par caractère sur les autres polices de la page.

## textedit-21 — P1 — Chemin natif avec police TrueType simple sous-ensemble : l'encodeur accepte des glyphes absents → texte ajouté illisible/invisible
- Repro : `npx tsx --import ./register.mjs 26-simplefont-missing.mts` puis `26b-simplefont-render.mts` et `node rpdfjs.mjs out/word-p7-simplefont.pdf 7 out/word-p7-simplefont.png 3` (crop out/word-p7-simplefont-crop.png).
- Preuve : word-contrat p7 bloc « 1 » → « 1 Zut » : report natif, police F2 BCDFEE+Aptos FirstChar=32 LastChar=49 (sous-ensemble " 1") ; « Zut » (codes 90,117,116) écrit hors sous-ensemble ; extraction « Zut » = false ; rendu : « tı » au lieu de « Zut ».
- Cause : core/fontmetrics.ts:410-414 table inverse construite sur les 256 codes de l'encodage de base (WinAnsi), sans vérifier FirstChar/LastChar/Widths>0 ni la présence du glyphe dans le programme de police ; encode (l.441-449) accepte donc tout WinAnsi.
- Correction : n'accepter qu'un code présent dans [FirstChar,LastChar] avec largeur > 0 ET glyphe présent (cmap/post du FontFile2) ; sinon repli.

## textedit-22 — P1 — Mode « Modifier le texte » sur gros document : couche montée sur TOUTES les pages (1000), 16 s de calcul, clic → zone d'édition en 0,5 s
- Repro : `node 12-ui-perf.mjs edge-1000pages.pdf` (CSP 3210) ; `node 12-ui-perf.mjs word-250pages.pdf`.
- Preuve (rejoué) : edge-1000pages : 1er bloc p1 en 560 ms, 3000 blocs stabilisés à 16 185 ms, `layers: 1000`, DOM 28 384→33 371 nœuds, tas 58→117 Mo, clic→textarea 508 ms, tâches longues max 213 ms. word-250pages (tentative précédente) : 500 blocs en 2 221 ms, 251 couches.
- Cause : ui/PdfWorkspace.tsx:2223-2234 monte ContentEditLayer pour chaque page de `visiblePages = pages` (l.1841) ; ContentEditLayer.tsx:38-59 lance `engine.text()` + groupBlocks sans condition de visibilité ; le clic appelle `checkpoint` (setState global → re-rendu des 1000 PageView).
- Correction : ne monter la couche d'édition que pour les pages visibles (±1) via l'IntersectionObserver de PageView ; calcul des blocs paresseux et mis en cache par page ; checkpoint différé (cf. textedit-09).

## textedit-23 — P2 — La zone d'édition ne s'agrandit pas : le texte d'origine y est déjà tronqué et l'aperçu déborde du cadre
- Repro : `node 21-ui-wysiwyg.mjs` (CSP 3210, mixed-geometry p1) ; capture out/wys-mixed-compare.png.
- Preuve : textarea avant toute frappe `scrollHeight 47 > clientHeight 30` (2 lignes, une seule visible entière) ; après allongement 62/30 ; l'aperçu fait 4 lignes et dépasse de 30 px sous le cadre « modifié ». (Le fichier exporté a bien 4 lignes = cohérent avec l'aperçu dans ce cas Helvetica.) Sur word-contrat B2 : textarea scrollH 1308 > clientH 751 (10-ui-word.mjs).
- Cause : ContentEditLayer.tsx:65-75 taille fixe = rect d'origine ; police d'aperçu Arial ≠ police du PDF (fontCss, cf. textedit-19) ; pas d'auto-hauteur.
- Correction : auto-hauteur de la zone (et du cadre) au fil de la frappe, police réelle de la page pour la mesure.

## textedit-24 — P2 — Alignement justifié perdu à la réécriture (et paragraphe rallongé d'une ligne)
- Repro : `npx tsx --import ./register.mjs 23-justify.mts` (edge-web p1 B3, align=justify).
- Preuve : lignes ré-émises finissant à x=504.3 / 490.2 / 403.4 pour un bord droit à 543.7 ; aucun Tw/TJ ré-émis ; 2 lignes → 3 lignes (Helvetica, substitution).
- Cause : ops/textedit.ts:272-273 et 316-322 : « justify » traité comme « left » ; pas de Tw/espacement calculé.
- Correction : pour align=justify, répartir l'écart (Tw pour polices 1 octet, TJ pour CID) sauf dernière ligne.

## textedit-25 — P1 — « Masquer (blanc) » (onglet Modifier > Contenu) laisse le texte masqué extractible et copiable dans le PDF exporté
- Repro : `npx tsx --import ./register.mjs 27-whiteout.mts`.
- Preuve : blanc posé sur le paragraphe B1 de mixed-geometry p1 → `flattened=1`, texte masqué encore extractible = true (« Texte éditable : « Où êtes-vous ? »… » toujours dans l'extraction pdf.js).
- Cause : whiteout aplati en simple rectangle blanc peint par-dessus (ops/annots-pdf.ts:153 & 542-543) ; aucune suppression dans le flux (contrairement à applyRedactions) et aucun avertissement.
- Correction : faire du « Masquer » une vraie suppression (réutiliser applyRedactions sans remplissage noir) ou avertir explicitement que le texte reste présent.

## textedit-26 — P0 — PDF protégé (AES-256) : modifier le texte puis exporter produit un fichier IMPOSSIBLE À ROUVRIR ; la modification est ignorée sans avertissement
- Repro UI (CSP 3210, sans saisie de mot de passe) : `node 10-ui-word.mjs http://127.0.0.1:3210/ encrypted-owner-only.pdf trimestriel annuel enc-owner` puis `npx tsx --import ./register.mjs 29-check-enc-ui.mts`. Repro Node : `28-encrypted.mts` (aussi avec le fichier à mot de passe « test ») et témoin `28b-encrypted-noedit.mts`.
- Preuve : UI : bloc modifié (badge « modifié », statut « 1 paragraphe(s) modifié(s) »), toast « PDF exporté · 3 pages » sans avertissement ; réouverture du fichier exporté : `PdfPasswordRequired: Ce PDF est protégé par un mot de passe` (l'original s'ouvre sans mot de passe). Node : `skipped=1 warnings=[]` ; avec « test » : `Mot de passe incorrect` à la réouverture. Témoin sans aucune modification : même corruption → le défaut est dans l'export, mais il rend l'édition de texte inutilisable sur tout PDF chiffré.
- Cause : ui/PdfWorkspace.tsx:296 `bytesRef.current = raw.slice()` conserve les octets CHIFFRÉS après ouverture avec mot de passe ; ops/save.ts:76/100-104 attend des octets déchiffrés mais charge avec `ignoreEncryption: true` → flux restés chiffrés (pdf.js : « Unknown compression method in flate stream ») et /Encrypt incohérent ; textedit ne trouve aucun glyphe (skipped).
- Correction : déchiffrer à l'ouverture (removeProtection avec le mot de passe saisi, ou mot de passe utilisateur vide pour « owner-only ») avant de stocker bytesRef ; ré-appliquer la protection à l'export si demandé ; refuser l'export avec erreur explicite sinon.

### Addendum textedit-01 (rejoué dans l'UI réelle, CSP 3210)
- `node 10-ui-word.mjs http://127.0.0.1:3210/ edge-web.pdf trimestriel trimestre edge-native` puis `npx tsx --import ./register.mjs 22b-ctm.mts out/edge-native-ui-export.pdf` et `node rpdfjs.mjs out/edge-native-ui-export.pdf 1 out/edge-native-ui-p1.png 1` : ré-émis `ctm=[0.24,0,0,-0.24,0,841.92] eff=5.28 origine=(12.2,660.6)` ; toast « PDF exporté · 3 pages · 1 paragraphe(s) réécrits » (succès annoncé) ; rendu out/edge-native-ui-crop.png : titre disparu, micro-texte en miroir dans le dégradé.

### Addendum textedit-08 (aperçu après validation)
- `node 31-ui-rot-preview.mjs` : sur p3 (/Rotate 90) l'aperçu du paragraphe modifié est un span 31×463 px, `transform: none`, un fragment de mot par ligne (out/rot-p3-preview.png) — alors que l'export, lui, est correct (11-mixed.mts : positions identiques à l'original).

## textedit-27 — P2 — Pas de « Rechercher et remplacer » dans le texte du PDF ni de correcteur orthographique en édition
- Repro : `grep -rn "Remplacer\|spellcheck" ws/src/pdf/ui/*.tsx` → aucun résultat ; la recherche (Ctrl+F) ne propose que la recherche.
- Preuve : lecture de code (aucune commande de remplacement, textarea sans `spellCheck`/langue).
- Cause : non implémenté.
- Correction : remplacement par occurrence/tout, s'appuyant sur les ContentEdit par bloc (Acrobat : Rechercher > Remplacer par, en mode Modifier le PDF).

## textedit-28 — P2 — Soulignés, couleurs de lien et styles par mot ne suivent pas le texte réécrit
- Repro : `npx tsx --import ./register.mjs 09-edge.mts` (cas edge-b1 « rouge »→« rouge vif ») ; comparaison zoomée out/edge-b1-underline-compare.png (haut = original, bas = exporté).
- Preuve : les filets de soulignement (tracés vectoriels) restent à leur ancienne abscisse et coupent désormais « lign », « en h », « ttps://ex » ; « Gras » n'est plus gras, « italique » plus italique, « rouge vif » et le lien ne sont plus colorés (une seule couleur `first.state.fill` pour tout le bloc).
- Cause : ops/textedit.ts:245 couleur unique ; les chemins de soulignement et l'annotation /Link ne sont ni détectés ni déplacés ; pas de runs stylés (cf. textedit-05).
- Correction : modèle de runs stylés (police, couleur, décorations) par segment ; associer les filets horizontaux sous la ligne de base aux runs et les régénérer ; recalculer le /Rect des liens couvrant le bloc.

## (3e reprise) Rejoués : 02-word-edit.mts et 20-synthetic.mts redonnent les mêmes chiffres (B2 subst=1 Helvetica ; XObject skipped=1 ; texte tourné 8 fragments ; MCID perdu).

## Constat positif (pas un défaut) — « Supprimer » un paragraphe est fiable dans le pipeline d'export
- Repro : `npx tsx --import ./register.mjs 32-delete-collateral.mts` (log out/32-delete.log).
- Preuve : 46 blocs (word-contrat p1-3, edge-web p1-3 dont CJK/arabe, mixed-geometry p1-7 tournées/CropBox/UserUnit) supprimés un par un : restes=0, dégâts collatéraux=0, skipped=0 pour les 46.

## textedit-29 — P0 — Paragraphe CJK / arabe : ajouter UN caractère absent du sous-ensemble EFFACE tout le paragraphe (1/45 et 0/13 caractères conservés), sans avertissement
- Repro : `npx tsx --import ./register.mjs 33-cjk-arabic.mts` (edge-web.pdf p2 ; log out/33.log).
- Preuve : CJK « …的段落。」→「…的新段落。」 : report native=0 subst=1 warnings=[] ; ré-émis `Helvetica@10.995 " ."` ; caractères voulus présents dans le PDF exporté 1/45. Arabe ressaisi en ordre logique « هذا نص عربي جديد » : 0/13. Témoins : suppression seule (tous glyphes présents) → natif, 37/37 et 31/31. Bloc de code monospace « Bonjour »→« Salut » → Helvetica (chasse fixe perdue).
- Cause : ops/textedit.ts:248 wrapNative → null au 1er caractère non encodable → repli l.309-311 `fontBook.get(fontFamily)` = police standard 14 WinAnsi, puis `sanitiseForFont` (ops/fonts.ts:97) supprime tout ce qui n'est pas Latin-1 ; `report` ne compte qu'un « substituted » et l'UI ne l'affiche pas (PdfWorkspace.tsx:785). De plus le texte arabe détecté est en formes de présentation, ordre visuel (U+FE8E…) : l'utilisateur édite un texte inversé.
- Correction : ne JAMAIS retomber sur une police WinAnsi pour un texte hors Latin-1 : embarquer une police Unicode (Noto Sans CJK/Arabic sous-ensemble via fontkit, ou police système) ; mise en forme bidi/shaping (HarfBuzz/fontkit layout) pour l'arabe ; normaliser le texte détecté en ordre logique (NFKC + bidi) avant de l'afficher dans la zone d'édition ; bloquer la validation si des caractères seraient perdus.

## textedit-30 — P0 — Document scanné : l'appli invite à « Lancer l'OCR pour le rendre éditable », mais sous la CSP de bureau l'OCR échoue en 144 ms (worker blob: bloqué) → modifier un scan est impossible
- Repro : `node 34-ui-ocr-edit.mjs http://127.0.0.1:3210/ ocr-csp` (scan-jpeg.pdf, OCR page 1, ruban Convertir > OCR > Lancer).
- Preuve : mode Modifier le texte avant OCR : « Aucun texte modifiable détecté sur cette page (document scanné ?). Lancez l'OCR pour le rendre éditable. » ; OCR : toast « La reconnaissance a échoué. » après 144 ms ; console : « Creating a worker from 'blob:http://127.0.0.1:3210/…' violates the following Content Security Policy directive: "script-src 'self' 'wasm-unsafe-eval'" » (+ image data: bloquée). Sur 3211 (sans CSP) l'OCR aboutit (voir textedit-31).
- Cause : ops/ocr.ts:106 `createWorker(langs, 1, { langPath, logger })` sans `workerPath`/`corePath`/`workerBlobURL:false` → tesseract.js crée son worker depuis une URL blob: ; installer/elium_launcher.py:600-609 n'autorise ni `worker-src blob:` ni `img-src data: blob:` ; le catch de PdfWorkspace.tsx:2564-2566 avale l'erreur (message générique).
- Correction : servir worker.min.js + tesseract-core*.wasm depuis 'self' et passer `workerPath`, `corePath`, `workerBlobURL: false` ; ajouter `worker-src 'self' blob:` et `img-src 'self' data: blob:` à la CSP ; afficher la cause réelle de l'échec ; test e2e sous la CSP de bureau.

## textedit-31 — P1 — Aperçu à l'écran après modification : couleur forcée gris foncé, Arial normal, débordement sur le dégradé voisin (titre bleu Georgia gras → Arial gris)
- Repro : `node 35-ui-escape-preview.mjs` (CSP 3210, edge-web.pdf p1 : « rouge »→« rouge vif » et « trimestriel »→« annuel », Tab pour valider, retour en lecture) ; comparaison out/prev-edge-compare.png (haut = avant, bas = aperçu).
- Preuve : spans d'aperçu `color rgb(17, 24, 39)`, `font "Arial, Helvetica, sans-serif"`, `weight 400`, masque `rgb(255,255,255)` pour les deux blocs ; capture : le titre bleu gras serif devient gris Arial maigre ; gras/italique/souligné/rouge/lien disparaissent ; la ligne modifiée passe de 2 à 3 lignes (scrollH 40 > boîte 27 px) et « 12,50 € — œuvre… » est peinte PAR-DESSUS le haut du dégradé. (Contrôle : Échap annule bien la saisie — changedBadges 0.)
- Cause : ui/ContentEditPreview.tsx:65 `color: e.color ?? "#111827"` alors que ContentEditLayer.commit (l.77-94) ne renseigne jamais `color` ; l.61-63 police/graisse issues de la détection générique (cf. textedit-19) ; l.49 boîte = rect d'origine sans `overflow` ni auto-hauteur ; masque blanc opaque l.51 qui efface aussi le fond réel (dégradé, trame) sous le bloc.
- Correction : capturer la couleur de remplissage et la police réelle par run à la détection (pdf.js `getTextContent({includeMarkedContent})` + `commonObjs` / opérateurs `rg`) et les stocker dans ContentEdit ; rendre l'aperçu avec la police embarquée (FontFace depuis le FontFile) ; masquer uniquement les glyphes (re-rendu de la page sans les opérateurs supprimés, comme l'export) au lieu d'un rectangle blanc.

## textedit-32 — P0 — Texte OCR d'un scan : l'écran montre un remplacement propre, mais le PDF exporté SURIMPRIME le nouveau texte sur l'image scannée inchangée (double texte illisible)
- Repro : `node 34-ui-ocr-edit.mjs http://127.0.0.1:3211/ ocr-nocsp` (OCR impossible sous 3210, cf. textedit-30) puis `node rpdfjs.mjs out/ocr-nocsp-export.pdf 1 out/ocr-export-p1.png 1.5` ; comparaison out/ocr-edit-compare.png (haut = aperçu écran, bas = PDF exporté).
- Preuve : OCR p1 : 276 mots en 2,9 s ; mode Modifier : 34 blocs dont 10 paires qui se chevauchent et 6 blocs dont le centre est recouvert par un autre bloc (non cliquables au centre — Playwright : « …editblock__hit… intercepts pointer events ») ; bloc cible = « ipsum \nUt enim ad minim veniam… » (fragment : « Lorem » est dans un autre bloc). « ipsum »→« REMPLACEMENT », toast « PDF exporté · 6 pages · 1 paragraphe(s) réécrits ». Rendu exporté : « REMPLACEMENT » en Helvetica noire imprimé par-dessus « Lorem ipsum » du scan, et la ligne « Ut enim ad minim veniam… » dédoublée (texte vectoriel décalé sur le texte image) ; à l'écran l'aperçu masquait tout en blanc et montrait un résultat net.
- Cause : ops/textedit.ts:167-231 ne retire que les glyphes invisibles (couche OCR `3 Tr`, ops/ocr.ts:201) ; la ré-émission l.251-277 (BT sans `Tr`) écrit en mode remplissage visible par-dessus l'image, qui n'est ni retouchée ni masquée ; l'aperçu (ContentEditPreview.tsx:51) pose un masque blanc qui n'existe pas à l'export. Regroupement des mots OCR : core/text.ts groupBlocks produit des blocs fragmentés et chevauchants sur du texte OCR (lignes de base irrégulières).
- Correction : pour une page image+OCR, soit conserver le mode invisible (Tr 3) ET ne pas prétendre modifier le visuel, soit faire comme Acrobat (« Modifier le PDF » sur un scan) : effacer la zone de l'image sous le bloc (remplissage par la couleur de fond échantillonnée, ou masque blanc réellement écrit à l'export, identique à l'aperçu) puis écrire le texte visible avec une police appariée ; regrouper les mots OCR par ligne/paragraphe Tesseract (hiérarchie blocks→paragraphs→lines) plutôt que par géométrie ; interdire le chevauchement des zones cliquables.

## textedit-33 — P1 — Le texte ré-émis hérite de l'état de texte laissé en fin de flux (Tr, Tc, Tw, Tz, Ts) : paragraphe corrigé INVISIBLE, espacé, condensé ou décalé
- Repro : `npx tsx --import ./register.mjs 36-textstate.mts` (PDF synthétiques pdf-lib : paragraphe A, puis une dernière ligne qui règle un état de texte sans le remettre — cas courant : `Tw` de justification LibreOffice/ReportLab, `Tc`, couche OCR tierce `3 Tr`) ; rendus pdf.js out/ts-compare.png (log out/36.log).
- Preuve : « modifier »→« corriger », tous en chemin natif : témoin largeur 229,4 pt ; `4 Tw` → Tw=4, 253,4 pt ; `1.5 Tc` → 290,9 pt (+27 %) ; `60 Tz` → 137,7 pt ; `3 Tr` → Tr=3 : le paragraphe corrigé est INVISIBLE au rendu (encore extractible) ; `6 Ts` → ligne de base relevée de 6 pt. Capture : ligne vide pour Tr3, texte lettre-espacé pour Tc, texte écrasé pour Tz.
- Cause : ops/textedit.ts:251-262 : le bloc ré-émis `q BT /F size Tf r g b rg` ne réinitialise ni Tc, Tw, Tz, TL, Ts ni Tr, et il est ajouté à la fin du flux (l.300) où l'état résiduel du dernier BT persiste (ces paramètres font partie de l'état graphique, pas de BT/ET) ; `measureNative` (l.80-89) ignore aussi Tc/Tw/Tz → césure calculée sur une largeur fausse.
- Correction : émettre explicitement `0 Tc 0 Tw 100 Tz 0 Ts 0 Tr` (ou reprendre l'état du premier glyphe d'origine, qui est celui voulu) et encadrer le contenu d'origine par `q … Q` (cf. textedit-01) ; mesurer avec Tc/Tw/Tz effectifs.

## textedit-34 — P2 — Moteur d'images existantes (applyImageEdits, non branché) : remplacement déformé et « image n°0 » qui désigne un Form XObject (le tampon est supprimé au lieu de la photo)
- Repro : `npx tsx --import ./register.mjs 38-image-edits.mts` (log out/38.log ; rendu `node rpdfjs.mjs out/img-replace.pdf 3 out/img-replace-p3.png 1`).
- Preuve : (a) word-contrat p3 Image25 453,6×226,8 (ratio 2) remplacée par un PNG 100×300 (ratio 0,33) → placement après 453,6×226,8 : image étirée ×6 en largeur. (b) page « tampon (Form XObject) + photo » : placements `[/Form EmbeddedPdfPage, /Image]` ; `occurrence:0, action:"delete"` → il reste `[/Image]` : c'est le tampon qui a disparu, la photo est toujours là.
- Cause : ops/textedit.ts:364 `walkPlacements(ops).filter(p => p.name !== null)` compte TOUS les `Do` (images ET formulaires) ; l.379-380 ne remplace que le nom dans le `Do` en gardant la CTM d'origine (aucune adaptation du rapport d'aspect) ; les images situées dans des Form XObjects ne sont jamais atteintes ; model/types.ts:269-277 ne prévoit ni déplacement, ni redimensionnement, ni recadrage, ni rotation.
- Correction : filtrer sur `/Subtype /Image` (résolution des ressources) ; identifier l'image par nom de ressource + index plutôt qu'un rang global ; au remplacement, conserver le rapport d'aspect (ajuster la CTM, « ajuster/remplir » comme Acrobat) ; étendre ImageEdit {matrix, clip, rotation} et descendre dans les Form XObjects — prérequis avant de brancher une UI (textedit-13).
