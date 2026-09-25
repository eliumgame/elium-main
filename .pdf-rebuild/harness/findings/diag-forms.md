# FINDINGS — domaine forms (Formulaires : remplissage et préparation)
# Chaque constat : id, sévérité, titre, repro, preuve, cause, correction. Mis à jour au fil de l'eau.

## forms-01 — P0 bug — Impossible de saisir quoi que ce soit dans un champ texte d'un formulaire existant (maxLength=0)
- Repro : `node 02-fill-ui.mjs http://127.0.0.1:3210/` (et 04-text-input-debug.mjs, 3211 idem) ; Node : `node --import tsx --import ./register.mjs 01b-maxlen-node.mts`
- Preuve : après `fill("Dupont")` et frappe clavier réelle `type("Lyon")`, `inputValue()` = "" ; les 8 champs texte de form-acro.pdf portent `maxlength="0"`. Export → pdf-lib : `identite.nom … V= -` (aucune valeur), pdf.js getFieldObjects `""` pour les 8 champs texte. Node : `/MaxLen absent` dans le fichier mais `pdf.js maxLen = 0` → `readFields.maxLen = 0`. Avec `--patch-maxlen` (retrait de l'attribut), la saisie et l'export fonctionnent.
- Cause : pdf.js 6 renvoie `maxLen: 0` quand `/MaxLen` est absent ; ops/forms.ts:127 `maxLen: a.maxLen ?? null` conserve 0 ; ui/FormLayer.tsx:161 et :171 `maxLength={b.maxLen ?? undefined}` → `maxLength=0` → le navigateur refuse tout caractère. Tout champ texte sans MaxLen (= quasi tous les formulaires du monde) est inéditable.
- Correction : `maxLen: a.maxLen && a.maxLen > 0 ? a.maxLen : null` dans readFields ; test e2e qui tape réellement dans un champ.

## forms-02 — P1 ux — Les champs ne sont pas remplissables à l'ouverture : il faut trouver « Formulaires → Remplir »
- Repro : `node 02-fill-ui.mjs http://127.0.0.1:3210/` (ligne « controls in VIEW mode »)
- Preuve : `controls in VIEW mode: 0` sur form-acro.pdf ouvert ; les contrôles n'apparaissent qu'après onglet Formulaires + bouton Remplir. Aucune bannière « ce document contient des champs ».
- Cause : ui/PdfWorkspace.tsx:2236 `{(mode === "form" || mode === "fields") && <FormLayer…/>}` ; mode initial "view" (PdfWorkspace.tsx ~l.646) ; aucun passage auto en mode form quand `info.hasAcroForm`.
- Correction : monter FormLayer dès l'ouverture quand hasAcroForm (comme Acrobat/Edge/Chrome), bannière « Remplir et signer » + bouton « Surligner les champs ».

## forms-03 — P1 bug — En quittant le mode « Remplir », les valeurs saisies disparaissent de l'affichage
- Repro : `node 16-view-after-fill.mjs` (partie a) → out/16a-view-after-fill.png
- Preuve : nom="Dupont" saisi + case cochée, re-clic « Remplir » → 0 contrôle, la page rendue montre le champ Nom VIDE et la case DÉCOCHÉE (apparences d'origine du fichier). Les valeurs ne sont visibles qu'en mode Remplir ou après export.
- Cause : le canevas est rendu avec les /AP du fichier source (PdfWorkspace.tsx:2200 `annotationMode={state.importedAnnots ? 0 : 1}` = ENABLE) et les valeurs de `state.formValues` ne sont peintes nulle part hors FormLayer (monté seulement en mode form, :2236).
- Correction : garder FormLayer monté en permanence (lecture seule hors remplissage) ou passer les valeurs à pdf.js via `annotationStorage` (render avec `annotationMode: ENABLE_STORAGE` + `doc.annotationStorage.setValue(id,{value})`) pour que le rendu reflète l'état courant.

## forms-04 — P1 bug — Double affichage : l'ancienne valeur du fichier reste peinte sous le contrôle HTML (texte illisible)
- Repro : `node 16-view-after-fill.mjs` (partie b) → out/16b-edit-prefilled.png (réouverture d'un PDF rempli par l'appli, nom changé en « Martin »)
- Preuve : capture : « Martin » superposé à « Dupont » (rendu « Mapont »), et tous les autres champs déjà remplis apparaissent en double décalé (« 12 rue de l'Église » dédoublé, « 69001 » baveux) ; sur form-acro.pdf vierge, la liste « langues » montre à la fois le <select> HTML et les 4 options peintes (out/02-csp-filled.png).
- Cause : PdfWorkspace.tsx:2200 rend les widgets (AnnotationMode.ENABLE) sous FormLayer, dont le fond est semi-transparent (pdf.css `.pdfx-field { background: rgba(191,219,254,0.38) }`) et la police ≠ Helvetica du /AP.
- Correction : en mode remplissage rendre le canevas en `AnnotationMode.DISPLAY` sans widgets (ou `ENABLE_FORMS` + annotationLayer pdf.js, qui masque l'AP sous chaque champ HTML), ou fond opaque ; idéalement utiliser l'AnnotationLayer de pdf.js (renderForms:true) qui gère déjà ce cas.

## forms-05 — P1 bug — Liste à sélection multiple (multiSelect) réduite à une liste déroulante mono-valeur
- Repro : `node 02-fill-ui.mjs http://127.0.0.1:3210/ --patch-maxlen` (lignes inventory « langues » et « langues selected in UI ») ; capture out/02-csp-filled.png
- Preuve : champ `langues` (pdf.js `multiSelect:true`, combo:false) rendu en `<select>` sans attribut `multiple` (`"multiple":false`) ; `selectOption(["Français","Espagnol"])` → sélection `["Français"]` seulement ; export : `langues V= (Français)` unique. Visuellement la liste est dessinée comme un combo par-dessus la liste peinte du fichier.
- Cause : ui/FormLayer.tsx:129-144 même rendu `<select>` pour dropdown et listbox, sans `multiple`/`size` ; `FormValue` (model/types.ts) = string|boolean, pas de tableau ; ops/forms.ts:199-201 `field.select(val)` mono-valeur ; readFields:90 ne garde que `fv[0]`.
- Correction : `FormValue` accepte `string[]` ; `<select multiple size={n}>` pour listbox ; `PDFOptionList.select(values, true)` ; readFields conserve le tableau.

## forms-06 — P1 parity-gap — Aucune action JavaScript de formulaire n'est exécutée (format, frappe, validation, calcul)
- Repro : `npx tsx gen-acrolike.mts` puis `node 07-acrolike-ui.mjs` et `npx tsx 08-verify-acrolike.mts` (champs AFNumber_Keystroke/Format, AFDate_KeystrokeEx, AFRange_Validate, AFSimple_Calculate + /CO)
- Preuve : après frappe : `{"montant_ht":"12a34.5","tva":"100","total_ttc":"","date_naissance":"31/02/2026","age":"150"}` ; Acrobat : lettres refusées, « 1 234,50 EUR », total « 1 334,50 EUR » calculé, date 31/02 refusée, âge 150 refusé. Export : total_ttc `V= -`, montant `V=12a34.5`. Rendu out/08-acrolike-filled-render.png : Total TTC vide.
- Cause : ops/forms.ts RawWidget ignore `actions` (pdf.js les expose : `a.actions` K/F/V/C) ; aucune implémentation AFNumber/AFDate/AFSimple_Calculate ni ordre de calcul /CO ; pdf.js scripting (`pdf.sandbox`) non utilisé.
- Correction : implémenter en TS (sans eval) le sous-ensemble AForm standard (AFNumber_*, AFPercent_*, AFDate_*, AFSpecial_*, AFRange_Validate, AFSimple_Calculate + /CO) — couvre >90 % des formulaires administratifs ; ou brancher le sandbox QuickJS de pdf.js (pdf.sandbox.mjs, déjà dans node_modules) sous CSP 'wasm-unsafe-eval'.

## forms-07 — P2 bug — Champ caché (/F Hidden) affiché et modifiable
- Repro : `node 07-acrolike-ui.mjs` (ligne « cache (hidden F=2) rendered as control: true »)
- Preuve : le widget `cache` (F=2 Hidden, valeur « secret ») est rendu comme un input éditable montrant « secret » (capture out/07-acrolike-typed.png) ; pdf.js/Acrobat ne l'affichent pas (render out/08-acrolike-filled-render.png : vide).
- Cause : ops/forms.ts:103-139 `readFields` ignore `a.hidden` (présent dans RawWidget:37 mais jamais lu) ; FormLayer ne filtre pas.
- Correction : `if (a.hidden) return;` (ou rendre display:none) dans readFields.

## forms-08 — P2 parity-gap — Boutons poussoirs (ResetForm, JavaScript, SubmitForm) ignorés
- Repro : `node 07-acrolike-ui.mjs` (ligne « buttons rendered: 0 »)
- Preuve : `reset_btn` (/A ResetForm) et `js_btn` (/A JavaScript) : 0 contrôle, cliquer dessus ne fait rien ; ils ne sont visibles que peints dans le canevas.
- Cause : ui/FormLayer.tsx:153 `if (b.kind === "button") return null;`
- Correction : rendre un <button> par widget Btn poussoir ; exécuter au minimum ResetForm (avec /Fields et /Flags), SubmitForm (proposer export FDF/XFDF), et les JS AForm connus.

## forms-09 — P2 bug — Liste déroulante à valeurs d'export ≠ libellés : l'apparence enregistrée montre le code, et le champ devient « modifiable »
- Repro : `node 07-acrolike-ui.mjs` (choix « Suisse », valeur d'export CH) puis `npx tsx 08-verify-acrolike.mts` et `node 06-render.mjs out/07-acrolike-filled.pdf out/08-acrolike-filled-render.png`
- Preuve : rendu enregistré : « Pays : CH » au lieu de « Suisse » ; drapeaux `pays Ff=131072` → `Ff=393216` (bit Edit ajouté silencieusement).
- Cause : ops/forms.ts:199-201 `field.select(val)` avec la valeur d'export ; pdf-lib ne connaît que les libellés → valeur inconnue ⇒ `enableEditing()` implicite et apparence dessinée avec le texte brut.
- Correction : écrire /V = export mais générer l'AP avec le libellé correspondant (/Opt [export display]) ; ne jamais changer Ff.

## forms-10 — P2 bug — Taille de police « Auto » (0 Tf) : texte géant à l'écran et taille figée à l'enregistrement
- Repro : `node 07-acrolike-ui.mjs` (inventaire, commentaire `fontSize:"56.42px"` à 100 %) ; `npx tsx 08-verify-acrolike.mts`
- Preuve : multiligne auto-size affiché en 56 px (capture 07-acrolike-typed.png : « e à la ligne. » géant, texte hors cadre) ; à l'export les DA `/Helv 0 Tf 0 g` deviennent `0 g /Helvetica 15 Tf`, `/Helvetica 26 Tf` (code), `/Helvetica 22 Tf` (commentaire) : l'auto-ajustement est perdu pour les éditions suivantes (Acrobat conserve 0 Tf). Sur form-acro (DA 78 pt), le multiligne tronque « Deuxième ligne — avec œ et € ».
- Cause : ui/FormLayer.tsx:94 `fontSize = (b.fontSize ?? b.rect.h * 0.62) * scale` (62 % de la hauteur, même pour un multiligne de 90 pt) ; ops/forms.ts:211 `form.updateFieldAppearances(font)` réécrit le /DA avec une taille fixe.
- Correction : auto = ~12 pt pour multiligne / ajustement à la largeur pour mono-ligne ; générer l'AP sans réécrire /DA (ou restaurer le /DA d'origine après génération).

## forms-11 — P2 bug — Champ sur page tournée (/Rotate 90) : saisie horizontale dans une boîte verticale de 21 px
- Repro : `node 07-acrolike-ui.mjs` (ligne page2_champ)
- Preuve : `page2_champ … {"w":21,"h":201,"transform":"none"}` : la boîte est placée correctement mais le contrôle n'est pas tourné, le texte tapé s'écrit horizontalement dans 21 px de large.
- Cause : ui/FormLayer.tsx:53-63 `place()` ne convertit que les coins (psToView) sans `transform: rotate()` du contenu.
- Correction : positionner dans l'espace non tourné puis appliquer `transform: rotate(${rotation}deg)` sur le contrôle (comme l'annotationLayer pdf.js).

## forms-12 — P1 bug — « Réinitialiser » ne réinitialise rien sur un formulaire déjà rempli (ni à l'écran, ni dans le fichier exporté)
- Repro : `node 09-reset-flatten.mjs http://127.0.0.1:3210/ A` puis `npx tsx 03-verify-saved.mts out/09-A-reset.pdf` ; scénario B pour /DV
- Preuve : A : valeurs avant = après réinitialisation (`identite.nom":"Dupont"…` identiques) alors que le toast dit « Formulaire réinitialisé. » ; l'export 09-A-reset.pdf contient toujours `identite.nom = "Dupont"`, `prénom = "Élodie"`… B : `nom` revient à « Valeur initiale » (/V du fichier) au lieu de « Défaut » (/DV), comme le ferait Acrobat.
- Cause : model/doc.ts:483-485 `resetForm` vide seulement `state.formValues` ; FormLayer.tsx:93 retombe alors sur `b.value` = /V du fichier ; ops/forms.ts:177-179 `fillForm` ne touche qu'aux champs présents dans `values` ; `defaultFieldValue` (/DV) jamais lu (RawWidget:33 déclaré, inutilisé).
- Correction : `resetForm` doit écrire pour CHAQUE champ du document sa valeur /DV (ou vide/Off) dans formValues, pour que l'affichage et l'export l'appliquent.

## forms-13 — P1 bug — « Aplatir » échoue dès qu'un champ de signature vide est présent (cas courant) et affiche un message trompeur
- Repro : `node 09-reset-flatten.mjs http://127.0.0.1:3210/ C` puis `npx tsx 10-verify-flatten.mts out/09-C-flatten.pdf` ; `node 06-render.mjs out/09-C-flatten.pdf out/10-C-flatten-render.png 1 1`
- Preuve : toasts « PDF exporté 1 page » + « Aplatissement du formulaire impossible. » ; fichier : `fieldsLeft: 1, widgetsLeft: 1, containsSignatureField: true` — aplatissement partiel (12 champs aplatis, la signature interactive reste) ; si le champ signature était en tête de /Fields, rien ne serait aplati.
- Cause : ops/forms.ts:219-226 `flattenForm` = `doc.getForm().flatten()` ; pdf-lib lève « Failed to extract appearance ref » sur un /Sig sans /AP (form-acro : `signature_demandeur hasAP:false`) ; le correctif existant (forms.ts:400-411) ne protège que les signatures CRÉÉES par l'appli, pas celles du fichier.
- Correction : aplatir champ par champ en sautant/supprimant les widgets sans /AP (ou leur fabriquer un /AP vide avant `flatten()`), et remonter la liste réelle des champs non aplatis.

## forms-14 — P1 data-loss — L'aplatissement imprime le contenu des champs CACHÉS
- Repro : `node 09-reset-flatten.mjs http://127.0.0.1:3210/ D` puis `npx tsx 10-verify-flatten.mts out/09-D-flatten.pdf` ; `node 06-render.mjs out/09-D-flatten.pdf out/10-D-flatten-render.png 1 1`
- Preuve : `containsSecret: true` — la valeur « secret » du champ caché (/F 2) devient du texte de page visible et imprimé (capture 10-D-flatten-render.png, ligne « (champ caché) : secret »). Acrobat n'aplatit pas les widgets masqués.
- Cause : ops/forms.ts:221 `form.flatten()` de pdf-lib ignore le drapeau Hidden/NoView des widgets.
- Correction : avant flatten, supprimer (sans dessiner) les widgets dont /F a Hidden (2) ou NoView (32), et ceux sans Print (4) pour un aplatissement « impression ».

## forms-15 — P2 ux — L'option « Aplatir » reste collée : l'export suivant aplatit encore le formulaire
- Repro : `node 09-reset-flatten.mjs http://127.0.0.1:3210/ C` (ligne « C next Ctrl+S »)
- Preuve : après un « Aplatir », un simple Ctrl+S rouvre la boîte d'export avec « Aplatir les champs de formulaire » toujours coché (`still checked: true`) → l'utilisateur perd l'interactivité sans l'avoir redemandé.
- Cause : ui/PdfWorkspace.tsx:1250-1253 `setBuildOptions((o) => ({ ...o, flattenForms: true }))` jamais remis à false après l'export.
- Correction : option ponctuelle (passée à l'export puis réinitialisée), comme `applyRedactions`.

## forms-16 — P1 bug — « Exporter » (FDF) et « CSV » sortent un fichier VIDE pour un formulaire déjà rempli
- Repro : `node 12-data-io.mjs http://127.0.0.1:3210/` (étape 1) sur out/02-csp-patched-filled.pdf (13 champs remplis)
- Preuve : FDF : `/Fields [  ]` ; CSV : `"Champ;Valeur"` (en-tête seul). Seuls les champs modifiés dans la session sont exportés (étape 1b : 3 lignes).
- Cause : ui/PdfWorkspace.tsx:1232-1245 `toFdf(state.formValues…)` / `toCsv(state.formValues)` : `formValues` ne contient que les modifications, pas les valeurs lues du fichier (FieldBox.value de FormLayer, jamais remontées — `onFields` est un no-op PdfWorkspace.tsx:2249).
- Correction : fusionner valeurs du fichier (readFields sur toutes les pages, ou `engine.raw.getFieldObjects()`) + modifications avant export.

## forms-17 — P1 bug — FDF exporté illisible par Acrobat pour tout texte accentué (UTF-8 brut dans des chaînes PDF)
- Repro : `node 12-data-io.mjs` (étape 1b) puis `npx tsx 13b-fdf-decode.mts`
- Preuve : octets de « Hélène » = `48 c3 a9 6c c3 a8 6e 65` ; décodé comme le fait un lecteur PDF (PDFDocEncoding) : champ `"identite.prÃ©nom"` valeur `"HÃ©lÃ¨ne"` → Acrobat ne retrouve pas le champ (nom altéré) et importerait du charabia. Le radio est écrit `/V (Madame)` (chaîne) au lieu d'un nom `/Madame`.
- Cause : ops/forms.ts:460-475 `toFdf` insère la chaîne JS telle quelle, puis `downloadBlob` (export/exporters.ts:1030) l'encode en UTF-8 ; pas de UTF-16BE+BOM ni de hex ; noms à points non hiérarchisés (/Kids).
- Correction : écrire les chaînes non-ASCII en `<FEFF…>` (UTF-16BE hex), les valeurs de boutons en noms PDF, et produire des octets (Uint8Array) plutôt qu'une chaîne JS.

## forms-18 — P1 bug — Import FDF d'Acrobat : « 5 champ(s) importé(s) » mais aucune valeur correcte appliquée
- Repro : `node 12-data-io.mjs` (étape 2, fichier out/12-acrobat-style.fdf : hiérarchie /Kids + UTF-16BE + /V nom) ; `npx tsx 13-fdf-parse.mts`
- Preuve : toast « 5 champ(s) importé(s). » mais nom reste « Dupont » (FDF : Martin), radio civilite non cochée (index -1, FDF : /Madame) ; `fromFdf` renvoie `{"civilite":true,"nom":"Martin","pr�nom":"��\u0000J\u0000…","ville":"��\u0000B…"}` : noms sans parent (« nom » au lieu de « identite.nom »), UTF-16 non décodé, radio converti en booléen, liste multiple `/V [(Anglais)(Allemand)]` ignorée.
- Cause : ops/forms.ts:478-489 `fromFdf` = une regex plate (pas de /Kids, pas de hex <…>, pas d'UTF-16, `/Nom` → booléen) ; l'UI lit le fichier en UTF-8 (`file.text()`, PdfWorkspace.tsx:1573) ce qui détruit les octets binaires.
- Correction : lire en octets et parser le FDF avec le parseur d'objets de pdf-lib (PDFParser) ; reconstituer les noms complets via /Kids ; mapper /V nom → valeur d'export radio/case ; ne compter que les champs réellement trouvés dans le document.

## forms-19 — P1 bug — Import XFDF de données de formulaire impossible (aiguillé vers l'import de commentaires)
- Repro : `node 12-data-io.mjs` (étape 3, out/12-formdata.xfdf avec `<fields>`)
- Preuve : toast « Aucun commentaire lisible dans ce fichier. » ; valeurs inchangées (`identite.nom` reste « Dupont », XFDF : Durand). L'export de données ne propose pas non plus XFDF (format par défaut d'Acrobat), seulement FDF/CSV.
- Cause : ui/PdfWorkspace.tsx:1577-1587 tout fichier `.xfdf` ou contenant `<xfdf` part dans `fromXfdf` (ops/xfdf.ts, annotations uniquement) ; « Importer » (données) et « Importer commentaires » partagent le même `<input>` (PdfWorkspace.tsx:1122-1124).
- Correction : parser `<fields><field name><value>` (noms imbriqués) dans ops/xfdf.ts, distinguer données/commentaires ; ajouter l'export XFDF des données.

## forms-20 — P2 bug — CSV des données sans BOM UTF-8 : accents cassés à l'ouverture dans Excel ; format non fusionnable
- Repro : `node 12-data-io.mjs` puis `xxd out/12-touched.csv | head -3`
- Preuve : le fichier commence par `43 68 61 6d 70` (« Champ ») sans `EF BB BF` ; « Hélène » = `c3 a9…` → Excel FR (ANSI par défaut) affiche « HÃ©lÃ¨ne ». Structure « Champ;Valeur » une ligne par champ : impossible d'agréger plusieurs formulaires (Acrobat : une ligne d'en-tête = noms de champs, une ligne par formulaire, + « Fusionner des fichiers de données dans une feuille de calcul »). Pas d'import CSV/TXT.
- Cause : ops/forms.ts:492-499 `toCsv` ; PdfWorkspace.tsx:1239-1245.
- Correction : préfixer `﻿`, format en colonnes (en-tête = noms), option tabulation, export multi-fichiers.

## forms-21 — P1 data-loss — Un seul caractère hors WinAnsi (Ł, ő, 東…) efface l'apparence de TOUS les champs suivants, sans avertissement
- Repro : `node --import tsx --import ./register.mjs 11-unicode.mts` puis `node 06-render.mjs out/11-unicode.pdf out/11-unicode-render.png 1 1`
- Preuve : `report: { fieldsFilled: 7, warnings: [] }` ; /V corrects mais /AP : adresse « ul. Łódzka 5 » → "", ville « Kraków » → "", courriel « a@b.c » → "", date « 01/01/2026 » → "" (pur ASCII !). Rendu : seuls Nom et Prénom sont visibles, tout le reste est vide. NeedAppearances absent ⇒ tout lecteur, l'impression et l'aplatissement montrent un formulaire vide.
- Cause : ops/save.ts:266-268 `fillForm(doc, values, font)` avec `fonts.standard()` (Helvetica WinAnsi) ; ops/forms.ts:210-215 `form.updateFieldAppearances(font)` lève sur le premier glyphe non encodable et le `catch {}` « best-effort » abandonne la génération pour tous les champs restants.
- Correction : générer l'apparence champ par champ (try/catch par champ) ; embarquer une police Unicode (Noto Sans sous-ensemble via fontkit) quand une valeur sort de WinAnsi ; à défaut poser `NeedAppearances true` et remonter un avertissement.

## forms-22 — P0 bug — Les outils « Créer des champs » (Texte, Case, Radio, Liste, Signature) ne créent rien
- Repro : `npx tsx gen-paperform.mts` puis `node 14-prepare-ui.mjs http://127.0.0.1:3210/` (lignes « (c) outil … »)
- Preuve : chaque outil passe bien à l'état actif (`actif=1`) mais glisser un rectangle puis cliquer sur la page : `champs 7 → 7` pour les 5 outils. Le panneau Champs indique pourtant « Choisissez un outil de champ pour en dessiner un ». Aucun outil Liste à choix multiple / bouton / date / nombre dans le ruban.
- Cause : ui/AnnotLayer.tsx:126-131 exclut explicitement `field:*` du dessin (`!p.tool.startsWith("field:")`) et aucun autre composant ne gère ces outils : `D.addField` n'est appelé que par `detectFields` (PdfWorkspace.tsx:1421). Ribbon.tsx:499-529 n'expose pas `field:listbox` (défini dans model/types.ts:468).
- Correction : gérer le glisser-déposer des outils field:* (rectangle → `D.addField` avec kind, nom unique, options par défaut), puis ouvrir la fiche de propriétés.

## forms-23 — P1 parity-gap — Champs proposés/créés : ni déplacement, ni redimensionnement, ni propriétés (nom, obligatoire, lecture seule, format, calcul, options de liste, info-bulle)
- Repro : `node 14-prepare-ui.mjs` (lignes « (d) »)
- Preuve : glisser le 1er champ de +100,+60 px : position `{"x":640,"y":274}` → `{"x":640,"y":274}` (inchangée) ; double-clic → 0 boîte de dialogue. Le panneau « Champs » ne permet que « aller à » et « supprimer ». En mode « fields » les champs sont de simples `<input>` remplissables.
- Cause : `D.updateField` (model/doc.ts:491) n'est appelé nulle part dans ui/ ; ui/Inspector.tsx ne contient aucune section champ ; en mode "fields" c'est FormLayer (remplissage) qui est monté (PdfWorkspace.tsx:2236), pas un calque d'édition. Les attributs `required/readOnly/maxLen/options/tooltip/tabIndex` de CreatedField (types.ts:219-235) ne sont donc jamais renseignés. Aucun modèle pour format/validation/calcul.
- Correction : calque d'édition de champs (sélection, poignées, déplacement, alignement/duplication), Inspector « Propriétés du champ » (Général/Apparence/Options/Format/Validation/Calcul, comme Acrobat).

## forms-24 — P1 parity-gap — « Préparer un formulaire » ne permet pas de modifier les champs EXISTANTS du PDF
- Repro : `node 23-fields-panel.mjs http://127.0.0.1:3210/`
- Preuve : panneau Champs sur form-acro.pdf (13 champs) = `"Champs0Aucun champ créé.Choisissez un outil de champ pour en dessiner un."` ; ui/Sidebar.tsx:678-708 n'itère que `p.fields` = `state.createdFields` ; aucune opération de renommage/suppression/déplacement d'un champ AcroForm existant dans ops/forms.ts.
- Cause : l'architecture ne modélise que les champs créés ; les champs du fichier ne sont que lus (readFields) pour remplissage.
- Correction : charger les champs existants dans le modèle éditable (id = ref objet), avec opérations pdf-lib (removeField, setRectangle, flags) à l'export.

## forms-25 — P1 bug — Détection automatique : 1 champ sur un contrat Word de 7 pages, 7/13 sur un formulaire papier, champs posés SUR les libellés
- Repro : `node 14-prepare-ui.mjs` puis `npx tsx 17-dump-lib.mts out/14-paperform-prepared.pdf` ; capture out/14-b-paperform-detect.png
- Preuve : word-contrat p.1 « Aucun champ détecté », p.7 un seul champ nommé `Fait_à_Lyon_le_23_septembre_2026_Signatu` ; la détection ne porte que sur la page courante. paper-form : 7 champs, tous `text` ; manqués : Téléphone et Courriel (cadres), 3 cases à cocher, 2e champ « le : », zone Observations (champ fin de 18 pt à côté du libellé au lieu du cadre de 90 pt), Signature = champ TEXTE hors du cadre. Les lignes à soulignés donnent un champ qui recouvre le libellé : `Nom rect=50,734,217,18` (x=50 = début de « Nom : »), `Fait_à_le rect=50,404,236,18` (fusionne 2 champs).
- Cause : ops/forms.ts:244-280 `suggestFields` : heuristique texte uniquement (ligne finissant par « : » ou ≥ 4 « _ »), rect = toute la ligne pour les soulignés (:276), aucune analyse des tracés vectoriels (cadres, filets, carrés), aucune typologie (case/date/signature) ; PdfWorkspace.tsx:1402-1406 page courante seulement.
- Correction : détection sur tout le document ; découper les runs d'underscores dans la ligne (position du 1er « _ ») ; analyser les opérateurs `re`/`l` du flux de contenu pour cadres et cases ; typer par mots-clés (date, signature, oui/non) ; nommer d'après le libellé seul.

## forms-26 — P1 data-loss — Remplir un formulaire déjà signé puis enregistrer détruit la signature, sans aucun avertissement
- Repro : `node --import tsx --import ./register.mjs 20-fill-signed.mts` puis `npx tsx 20b-sig-left.mts`
- Preuve : 1) form-acro signé dans `signature_demandeur` : `valid:true, digest:true`, `engine.info.signed = true` ; 2) remplissage de `identite.nom` + export (buildPdf, chemin Ctrl+S) : fichier réécrit 51 188 → 13 633 octets, préfixe signé non conservé, le /V garde `ByteRange [0 16944 49714 1474]` qui pointe au-delà de la fin du fichier ⇒ signature cassée ; `verifyPdfSignatures` de l'appli ne la trouve même plus (`[]`, dictionnaire compressé en flux d'objets). Aucun dialogue : `exportPdf` (PdfWorkspace.tsx:763) ne teste pas `engine.info.signed` (seuls les chemins de signature :846/:896 appellent `confirmResign`).
- Cause : ops/save.ts:354 `doc.save({ useObjectStreams: true … })` = réécriture complète, jamais de mise à jour incrémentale.
- Correction : pour un document signé, enregistrer les modifications de champs en mise à jour incrémentale (ajout d'objets + nouvelle xref après %%EOF, en respectant /DocMDP /FieldMDP) ; au minimum avertir et refuser par défaut.

## forms-27 — P2 parity-gap — Champ de signature vide : ni cliquable ni focalisable en mode Remplir
- Repro : `node 19-perf-fill.mjs http://127.0.0.1:3210/` (dernière ligne)
- Preuve : clic sur `signature_demandeur` → `dialogues ouverts : 0`, `tabIndex: -1` (hors ordre de tabulation). Acrobat : clic → « Signer » (tracer/importer/certificat) directement dans le champ.
- Cause : ui/FormLayer.tsx:146-151 simple `<div>` « Signature » sans gestionnaire ; la signature passe par le ruban Protéger, déconnectée du champ.
- Correction : bouton focalisable qui ouvre le dialogue de signature pré-ciblé sur ce champ (pades.ts sait déjà réutiliser un /Sig existant via fieldName).

## forms-28 — P2 bug — Propriétés de champ créées perdues à l'export : info-bulle, doublon de nom silencieux, liste toujours « modifiable »
- Repro : `node --import tsx --import ./register.mjs 18-create-all-kinds.mts`
- Preuve : `report: created=9/10 … warnings=[]` : le 2e champ nommé `t_oblig` est jeté sans avertissement ; `t_oblig … TU=-` alors que tooltip="Texte obligatoire" ; `dd PDFDropdown Ff=[Edit(combo)]` alors qu'aucune édition n'était demandée. (Le reste — Required, ReadOnly, MaxLen, Multiline, défauts, radio à 2 boutons, signature, aplatissement — est correct au niveau ops.)
- Cause : ops/forms.ts:317-368 ne pose `/TU` que pour la signature (:444) ; :351 `field.enableEditing()` inconditionnel ; :382-384 `catch {}` avale l'erreur de nom en double.
- Correction : poser TU pour tous les types ; Edit seulement si demandé ; remonter les champs non créés dans `report.warnings`.

## forms-29 — P1 data-loss — Cases « Oui / Non » de même nom : cocher « Non » coche les deux et enregistre « Oui »
- Repro : `npx tsx gen-cbgroup.mts` ; `node 22-cbgroup-ui.mjs http://127.0.0.1:3210/` ; `npx tsx 17-dump-lib.mts out/22-cbgroup-filled.pdf` ; `node --import tsx --import ./register.mjs 15-reopen-values.mts out/22-cbgroup-filled.pdf`
- Preuve : un champ `reponse` à 2 widgets (états Oui / Non). Clic sur « Non » : `Oui coché = true  Non coché = true`. Fichier enregistré : `V=/Oui` ; à la réouverture : widget Oui coché, widget Non décoché → la réponse enregistrée est l'INVERSE de celle de l'utilisateur. Acrobat : les deux cases se comportent comme des boutons radio (V = /Non).
- Cause : ui/FormLayer.tsx:104-114 valeur booléenne par NOM (`checked={value === true}`, `onChange(name, checked)`) sans tenir compte de `exportValue` du widget ; ops/forms.ts:184-186 `field.check()` de pdf-lib choisit la valeur « on » du 1er widget.
- Correction : valeur de case = valeur d'export du widget coché (string) ; `checked = value === b.exportValue` ; à l'écriture poser /V = cette valeur et /AS de chaque widget (on/Off) à la main.

## forms-30 — P1 bug — « Aplatir » totalement impossible dès qu'une valeur contient un caractère hors WinAnsi (ł, ń, ő…)
- Repro : `node --import tsx --import ./register.mjs 11b-unicode-flatten.mts`
- Preuve : nom « Wałęsa », ville « Gdańsk » + flattenForms → `warnings: ["Aplatissement du formulaire impossible."]`, `champs restants : 13` (rien n'est aplati) ; l'UI affiche pourtant aussi « PDF exporté ».
- Cause : ops/forms.ts:221 `getForm().flatten()` appelle `updateFieldAppearances()` avec la police par défaut Helvetica (WinAnsi) → exception globale (même racine que forms-21).
- Correction : `flatten({ updateFieldAppearances: false })` après avoir généré les apparences champ par champ avec une police Unicode embarquée.

## forms-31 — P2 parity-gap — Pas de « Remplir et signer » pour les formulaires non interactifs (bouton Remplir grisé)
- Repro : `node 14-prepare-ui.mjs` (ligne « (a) bouton Remplir désactivé sur un PDF sans formulaire : true »)
- Preuve : sur word-contrat.pdf, « Remplir » est désactivé (« Ce document n'a pas de formulaire ») ; aucun outil coche/croix/point/date/initiales comme la barre « Remplir et signer » d'Acrobat (il faut passer par Commenter → texte libre).
- Cause : ui/Ribbon.tsx:487-495 `disabled={!p.hasForm}` ; pas de mode de remplissage libre.
- Correction : mode « Remplir et signer » : texte libre aligné sur les lignes, symboles ✓ ✗ ●, date du jour, initiales, avec détection de cases (réutiliser suggestFields).

## forms-32 — P3 ux — Champs obligatoires jamais vérifiés (fonction `missingRequired` morte)
- Repro : lecture de code ; `node 07-acrolike-ui.mjs` exporte avec « obligatoire » vide sans aucun message.
- Preuve : `grep -rn missingRequired web-studio/src` → uniquement sa définition (ops/forms.ts:150) ; export OK sans alerte.
- Cause : fonction jamais appelée depuis l'UI.
- Correction : avant export/envoi, lister les champs obligatoires vides et proposer d'y aller (Acrobat le fait à l'envoi/SubmitForm).

## forms-33 — P2 parity-gap — Formulaires XFA non remplissables (lecture seule)
- Repro : lecture de code (pas de XFA dans le corpus).
- Preuve : core/engine.ts:257 `isXfa`, badge PdfWorkspace.tsx:1857 « XFA — lecture seule » ; `getDocument` (engine.ts:806) sans `enableXfa`.
- Cause : XFA non pris en charge ; pdf.js sait rendre/remplir l'XFA (enableXfa + XfaLayer).
- Correction : activer enableXfa et le calque XFA de pdf.js pour au moins le remplissage ; à défaut, remplir la partie AcroForm des formulaires hybrides.

## forms-34 — P3 ux — Rendu des contrôles : peigne (comb), couleurs /MK, police Auto et libellé « Signature » géant non respectés
- Repro : `node 07-acrolike-ui.mjs` (capture out/07-acrolike-typed.png) ; `node 02-fill-ui.mjs` (inventaire : signature `fontSize:"65.1469px"`)
- Preuve : le champ en peigne `code` (MaxLen 5 + Comb) est un input ordinaire « ABCDE » tassé à gauche alors que l'AP enregistré répartit « A B C D E » ; toutes les couleurs de fond/bordure du PDF sont remplacées par le bleu Elium ; libellé « Signature » en 65 px qui déborde du cadre.
- Cause : ui/FormLayer.tsx:94-101 style unique (`fontSize = rect.h*0.62*scale`, classe `.pdfx-field`), aucun usage de `comb`, `backgroundColor`, `borderColor`, `fontColor` exposés par pdf.js.
- Correction : letter-spacing = largeur/MaxLen pour comb ; reprendre couleurs/police de `defaultAppearanceData` et `/MK`.

## forms-35 — P3 ux — Chaque simple focus d'un champ empile une entrée d'annulation et vide le « Rétablir »
- Repro : lecture de code.
- Preuve : ui/FormLayer.tsx:100 `onFocus: p.onBeginChange` → PdfWorkspace.tsx:2247 `checkpoint` → ui/state (useUndoable) `checkpoint` pousse l'état courant et `future: []`. Parcourir 13 champs au clavier sans rien taper = 13 annulations « vides » à cliquer ; un focus après un Annuler efface la pile Rétablir.
- Cause : checkpoint au focus au lieu du premier changement.
- Correction : checkpoint paresseux au premier `onChange` de la session d'édition du champ.

## Mesures de performance (big-form.pdf 40 p. × 25 champs = 1000 champs, `node 19-perf-fill.mjs`)
- ouverture 1511 ms ; entrée en mode Remplir 245 ms (1000 contrôles, 2474 nœuds DOM, 1 longtask 109 ms) ; 20 frappes 478 ms sans longtask ; export 40 p. 2,5 s (dialogue compris) ; détection paper-form 788 ms. Tabulation inter-pages OK (p1.l25 → p2.l1, défilement suivi). → la performance du remplissage n'est PAS le problème ; la justesse l'est.

## forms-36 — P1 data-loss — Supprimer ou dupliquer une page corrompt le formulaire : champ orphelin, aplatissement impossible, copie figée
- Repro : `node --import tsx --import ./register.mjs 24-page-ops-fields.mts` (acrolike.pdf, 2 p., code de production buildPdf + D.deletePages / D.duplicatePages)
- Preuve : (a) page 2 supprimée : `champs=17 orphelins=["page2_champ(PAGE-ABSENTE)"]`, pdf.js `page2_champ page:-1` — le champ reste dans /Fields avec un widget pointant vers une page qui n'existe plus ; (b) même chose + Aplatir : `warnings: ["Aplatissement du formulaire impossible."]`, 1 champ restant ; (c) page 1 dupliquée puis « nom »=Martin : page 1 `nom.AP="Martin"`, page 2 (copie) `nom.AP="Valeur initiale" nom∈/Fields=false` — les 18 widgets copiés ne sont rattachés à aucun champ (non remplissables dans Acrobat, valeur périmée à l'impression). Aucun avertissement.
- Cause : ops/save.ts:106-138 reconstruit l'arbre des pages (removePage/addPage, `copyPages(doc,[from])` pour les doublons) sans jamais toucher /AcroForm /Fields : les widgets des pages retirées restent référencés, ceux des copies ne sont pas enregistrés ; pdf-lib `flatten()` lève alors « Could not find page for PDFRef » (même `catch` muet que forms-13).
- Correction : après l'étape 1, retirer de /Fields (et des /Kids) les widgets dont /P n'est plus dans l'arbre ; pour une page dupliquée, rattacher chaque widget copié au champ d'origine (ajout dans /Kids du parent, valeur partagée — comportement Acrobat) ou le renommer (`nom#1`) et l'ajouter à /Fields.

## forms-37 — P2 bug — Ordre de tabulation : /Tabs de la page ignoré, on suit l'ordre de stockage des widgets
- Repro : `npx tsx gen-taborder.mts` puis `node 25-tab-order-R.mjs http://127.0.0.1:3210/`
- Preuve : page `/Tabs /R` (ordre des lignes imposé), widgets stockés de bas en haut : ordre DOM des contrôles `quatre → trois → deux → un` ; Tab depuis « un » (1er champ visuel) : `un → BODY → BUTTON` — on sort du formulaire au lieu d'aller à « deux ». Acrobat : un → deux → trois → quatre.
- Cause : ui/FormLayer.tsx:65-92 rend les contrôles dans l'ordre de `engine.annotations()` (= /Annots) sans tabIndex ; ni /Tabs (R/C/S) ni l'ordre de structure ne sont lus (core/engine ne les expose pas).
- Correction : lire /Tabs de la page ; pour /R trier par (y décroissant, x), /C par (x, y), /S par l'ordre de l'arbre de structure ; poser tabIndex en conséquence, et proposer l'édition de l'ordre dans « Préparer un formulaire ».

## forms-35 (complément exécuté) — `node 25-tab-order-R.mjs` : 5 clics dans des champs SANS rien taper → bouton Annuler actif, `clics Annuler « vides » nécessaires pour épuiser la pile : 5`.

## forms-38 — P2 bug — « Détecter » sur un formulaire existant empile des doublons par-dessus les vrais champs (et recommence à chaque clic)
- Repro : `node 26-detect-on-form.mjs http://127.0.0.1:3210/` puis `npx tsx 17-dump-lib.mts out/26-detect-on-form.pdf`
- Preuve : form-acro (13 champs) → « 8 champ(s) proposé(s) », chacun recouvrant un champ existant (`Nom→identite.nom (69 %)`, `Code_postal→identite.code_postal (84 %)`, `Date_JJMMAAAA→date (50 %)`…) ; 2e clic → 16 champs créés (`Nom_2`, `Prénom_2`…) exactement superposés aux premiers ; l'export contient 29 champs dont 16 parasites superposés sur la page.
- Cause : ui/PdfWorkspace.tsx:1402-1433 `detectFields` ne consulte ni les widgets existants (engine.annotations) ni les champs déjà créés ; `D.uniqueFieldName` (model/doc.ts:500) ne regarde que `createdFields`.
- Correction : exclure les suggestions dont le rectangle recoupe un widget existant ou déjà créé (IoU > 0,2) ; sur un PDF qui a déjà un AcroForm, ouvrir « Préparer » sur les champs existants au lieu de relancer la détection (comportement Acrobat).

## forms-39 — P2 data-loss — Un champ créé portant le nom d'un champ existant du fichier disparaît à l'export, sans avertissement
- Repro : `node --import tsx --import ./register.mjs 27-name-collision.mts`
- Preuve : 3 champs créés sur form-acro (`motif`, `identite`, `nouveau`) → `report: {"fieldsCreated":1,"warnings":[]}` ; fichier : 14 champs, `motif×1` (l'original), `identite×0` (nœud parent), seul `nouveau` est créé. Dans l'UI le champ est pourtant affiché dans le panneau Champs et le calque.
- Cause : model/doc.ts:500-506 `uniqueFieldName` ne connaît que `state.createdFields` ; ops/forms.ts:318 `createTextField(name)` lève « field already exists » et ops/forms.ts:382-384 `catch {}` l'avale ; ops/save.ts:258-263 n'avertit que si l'appel entier échoue.
- Correction : nommer contre l'union (champs du fichier + créés, noms complets et nœuds parents) ; compter et lister les champs non créés dans `report.warnings`.

## forms-40 — P2 desktop-env — « Imprimer » un formulaire rempli sous la CSP de bureau : l'iframe d'impression est bloquée, une nouvelle fenêtre s'ouvre à la place
- Repro : `node 28-print-csp.mjs http://127.0.0.1:3210/` (et 3211 pour comparaison)
- Preuve : 3210 : `violations CSP : ["frame-src blob"]`, iframe = `chrome-error://chromewebdata/`, puis `nouvelles fenêtres : ["blob:http://127.0.0.1:3210/…"]` (aucune boîte d'impression directe) ; 3211 : iframe blob chargée, aucune fenêtre. De plus le PDF imprimé est construit avec `flattenForms: true` (PdfWorkspace.tsx:977-983) : il hérite de forms-13 (signature vide → aplatissement partiel), forms-14 (champs cachés imprimés), forms-21/30 (champs vides dès qu'un caractère hors WinAnsi) et forms-36 (page supprimée → aplatissement impossible).
- Cause : ui/PdfWorkspace.tsx:972-1000 `printDocument` ouvre le PDF dans une iframe `blob:` ; la CSP du lanceur (`default-src 'self'`, pas de `frame-src blob:`) l'interdit ; le repli `window.open(url)` ouvre une fenêtre séparée.
- Correction : ajouter `frame-src 'self' blob:` à la CSP du lanceur (installer/elium_launcher.py) ou imprimer via le rendu pdf.js dans la page (canvas → @media print) ; aplatir pour l'impression via le correctif de forms-13/14/21.

## forms-41 — P3 parity-gap (code-reading) — Liste déroulante « modifiable » (Ff Edit) sans saisie libre ; bouton radio impossible à décocher
- Repro : lecture de code (ui/FormLayer.tsx:116-144).
- Preuve : les listes déroulantes sont toujours un `<select>` (aucune saisie de valeur hors liste, alors que l'appli pose elle-même Edit sur chaque liste créée — forms-28) ; les radios sont des `<input type=radio>` natifs : une fois cochés, impossible de revenir à « aucun » (Acrobat le permet si NoToggleToOff n'est pas posé). RawWidget (ops/forms.ts:27-52) ne lit ni Edit, ni NoToggleToOff, ni RadiosInUnison.
- Correction : `<input list=…>` + `<datalist>` pour les combos éditables ; gestion du clic sur radio coché → valeur Off si NoToggleToOff absent.

## Notes de rejeu (session 3, 2026-09-24)
- Tous les scripts 02, 03, 04 (3211), 07/08, 09/10, 11/11b, 12/13/13b, 14/17, 15, 16, 18, 19, 20/20b, 21, 22, 23 ont été relancés : sorties dans `replay/*.log` ; résultats identiques aux constats ci-dessus (tailles au près : 20-signed 51188 → 13630 ; perf 19 : ouverture 855 ms, mode Remplir 395 ms + longtask 158 ms, 20 frappes 814 ms sans longtask, export 2877 ms).
- Précision forms-10 : le DA 78 pt du champ « motif » vient du fichier du corpus (généré par pdf-lib), pas de l'appli ; le vrai défaut de forms-10 est la gestion de la taille Auto (0 Tf) démontrée sur acrolike.pdf.
- Lignes corrigées : mode initial `useState<Mode>("view")` = PdfWorkspace.tsx:188 ; `getDocument` = core/engine.ts:177 ; import FDF/XFDF = PdfWorkspace.tsx:1570-1593 ; export FDF/CSV = :1232-1245.
