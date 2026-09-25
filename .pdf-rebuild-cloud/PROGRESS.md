# Refonte PDF : journal des sessions cloud

Tenu à part de `.pdf-rebuild/`, qui n'existe que sur le poste Windows. Ce dossier n'a jamais
été poussé : ni CLOUD.md, ni PLAN.md, ni T2-progress.md, ni T2.json, ni le corpus. Un fichier
de même nom poussé ici bloquerait un `git pull` local (fichiers non suivis écrasés), d'où ce
dossier distinct.

**À faire sur le poste** : pousser `.pdf-rebuild/` (au moins PLAN.md, les *-progress.md,
workflows/args/*.json, harness/diag-results.json, et le corpus ou son script de génération),
pour que les sessions cloud suivent le même plan et testent sur le même corpus.

## Environnement cloud

- Node 26 obligatoire (`.node-version`). Avec Node 22, pdf.js 6.2 échoue : `Promise.try`,
  `Uint8Array.prototype.toHex`. On le télécharge depuis nodejs.org/dist/latest-v26.x.
- `npm ci` dans web-studio, puis `npx vitest run tests/pdf- src/pdf`.
- Tests d'interopérabilité Python : `pip install -e ".[dev]"` dans un venv (le paquet
  `cryptography` du système plante).
- Navigateur : `PW_CHROMIUM=/opt/pw-browsers/chromium`. `npx vite build`, puis
  `npx playwright test -c playwright.pdf.config.ts` lance deux projets :
  - « drive » : serveur Vite, sans CSP ;
  - « desktop » : dist/ servi par tests/support/desktop-server.py, avec la CSP lue dans la
    source de installer/elium_launcher.py.
- Seule erreur attendue dans les parcours Playwright : Google Fonts, bloqué par le proxy.

## T2 : formulaires

### Session cloud 1 (2026-09-25)

Décision : on n'utilise pas `saveDocument()` de pdf.js comme base d'enregistrement.
- pdf.js numérote ses nouveaux objets à partir du fichier d'ORIGINE. Après un premier
  enregistrement incrémental, ils entreraient en collision avec les objets déjà ajoutés
  (`disk.floor`).
- Le modèle (`state.formValues`) contient déjà toutes les valeurs, y compris les champs
  calculés par JavaScript, synchronisés depuis annotationStorage à l'étape 1.
- `SaveInput.base` reste pris en charge : les apparences sont alors complétées.

Fait :
- `ops/formpdf.ts` `writeFieldValues` : écriture bas niveau de /V, /AS et /I, uniquement
  pour les champs qui changent (un enregistrement incrémental sans modification ajoute 0 objet).
  Corrige deux défauts de pdf-lib :
  - `PDFDropdown.select("CH")` rendait le champ modifiable, car il compare avec les libellés ;
  - `PDFCheckBox.check()` ignorait les valeurs d'export distinctes de cases partageant un nom.
  Radio avec /Opt : correspondance valeur → état du i-ème widget (§12.7.4.2.3). /RV retiré
  quand le texte change.
- Branché dans `ops/save.ts` (étape 5) : `completeFieldAppearances` redessine les champs
  touchés avec une police Unicode (Liberation Sans en sous-ensemble). Si le fichier avait
  /NeedAppearances, tous les champs texte ou liste sont redessinés, puis le drapeau est
  retiré. La /DA d'origine n'est pas modifiée.
- Aplatissement : `flattenFields` (§12.5.5) remplace `PDFForm.flatten()`. Les widgets masqués
  ou non imprimables sont retirés sans être dessinés ; l'aplatissement ne s'interrompt plus sur
  un champ sans apparence.
- Champ mot de passe : puces dans l'apparence (jamais la valeur en clair une fois aplati).
- Tests : `tests/pdf-formpdf.test.ts`, 11 tests. Unicode relu par pdf.js dans le contenu
  aplati, libellé affiché plutôt que le code d'export, puces, champ masqué, /NeedAppearances,
  enregistrement incrémental sans objet ajouté.
- Suite PDF : 325/325.

À valider plus tard dans Acrobat, sur le poste :
- un formulaire rempli avec « Wałęsa / Łódź » puis enregistré : pas de demande
  d'enregistrement à l'ouverture, affichage correct ;
- le même formulaire aplati : texte net, positions identiques, y compris sur une page pivotée.

Reste T2 : JavaScript de formulaire (actions de calcul, format et validation à l'ouverture et à
l'enregistrement), préparation de formulaire complète (créer, déplacer, propriétés, ordre de
tabulation), import/export FDF/XFDF/CSV (vérifier ops/xfdf.ts et forms.ts toFdf/fromFdf),
champs obligatoires avant enregistrement, XFA (détection et message), puis relecture
adversariale.

### Session cloud 1, suite : premiers tests dans un vrai navigateur

P0 trouvé : **aucun PDF ne s'ouvrait dans Chromium 141** (« illisible ou endommagé »).
pdf.js 6.2 moderne appelle `Map.prototype.getOrInsertComputed` et `Math.sumPrecise`, absents
de Chromium. `Math.sumPrecise` sert aussi à dériver la clé AES-256 R6, donc tout PDF protégé
récent, et à reconstruire les polices Type1/CFF. Sur l'Edge du poste, `getOrInsertComputed`
existe sans doute (l'ouverture a été validée en F1), mais pas `sumPrecise`.
**À vérifier sur le poste** : ouvrir un PDF AES-256 avec la version actuelle de master.

Corrigé :
- `src/pdf/core/pdfjs.ts` est le seul point d'entrée de pdf.js. Il détecte les fonctions
  appelées sans garde et choisit le build moderne ou legacy, avec le worker, la visionneuse
  et le bac à sable assortis (`pdfjs/legacy/pdf.sandbox.min.mjs`). Sur Chromium et Edge, c'est
  en pratique le legacy (Mozilla), jusqu'à ce qu'ils aient `Math.sumPrecise`.
- vite.config : modern et legacy dans des chunks séparés, et les modules `?url` hors de ces
  chunks. Sinon les deux builds s'exécutaient au chargement, les polyfills faussaient la
  détection et le worker moderne partait. Gain : un seul build téléchargé, 433 ou 489 Ko au
  lieu de 923 Ko.
- Champs de formulaire impossibles à cliquer après une saisie sans `keyup` (collage par menu,
  saisie automatique, méthode de saisie) : la règle `.textLayer.selecting ~ .annotationLayer
  section { pointer-events: none }` ne vise plus que les liens (pdf.css).
- Lanceur : types MIME de .js, .mjs et .wasm fixés dans QuietHandler, sans passer par le
  registre Windows. Test : tests/python/test_launcher.py.
- La cause d'un échec d'ouverture est écrite dans la console (`[pdf] ouverture impossible`).

Tests navigateur : tests/pdf-forms.spec.ts, dans les deux projets. Le formulaire de commande
(tests/fixtures/pdf-form-fixtures.ts) vérifie :
- AFSimple_Calculate, AFNumber_Format et AFNumber_Keystroke dans le bac à sable QuickJS sous
  la CSP du bureau ;
- une valeur Unicode, puis Ctrl+S en téléchargement ;
- le fichier relu avec pdf-lib : valeurs, code d'export CH, pas de /NeedAppearances.
Résultat : 8/8 en répétition.

### Session cloud 1, suite : validation et échange de données

- Validation : pdf.js VIDAIT un champ dont la valeur est refusée par son script (par exemple
  AFRange_Validate). On garde maintenant la dernière valeur validée, comme Acrobat
  (`event.rc = false`). La valeur refusée n'atteint pas non plus le fichier. Voir
  core/forms/scripting.ts `isRejection`.
- Échange de données : ops/formdata.ts, nouveau module qui remplace toFdf/fromFdf/toCsv de
  forms.ts.
  - FDF façon Acrobat : hiérarchie /Kids, UTF-16, noms pour les cases, tableaux ; lecture
    par un mini-analyseur d'objets PDF (références, octal, #xx).
  - XFDF `<fields>`, texte tabulé d'Acrobat, CSV avec BOM.
  - Export de TOUS les champs (on n'exportait que les champs modifiés). Import mis en
    correspondance par type, champs inconnus ou refusés signalés.
  - Ruban : FDF, XFDF, Importer, CSV, Texte.
- P1 corrigé : « Réinitialiser » après le choix d'une liste déroulante VIDAIT tout le calque
  de formulaire de la page. `storageEntries` écrivait `{ value: null }`, et pdf.js fait
  `storedData.value.includes(…)`. On écrit maintenant des tableaux, ce qui évite aussi que
  « CH » sélectionne « C ».
- Champs créés : /T et /TU en UTF-16 si besoin (`PDFString.of` tronquait au-delà de U+00FF).
- Tests : pdf-formdata (10), pdf-form-values (4), tests de pdf-review portés, et
  pdf-forms.spec (3 parcours × 2 projets).

À valider dans Acrobat : importer dans Acrobat le .fdf et le .xfdf exportés par Elium, puis
l'inverse (export Acrobat → import Elium).

Reste T2 (mis à jour plus bas) :
- alertes des scripts dans une boîte Elium plutôt que `window.alert` (reporté à T10) ;
- XFA (message clair, remplissage AcroForm de secours) ;
- champs obligatoires signalés avant « Envoyer » ou à l'enregistrement ;
- relecture adversariale.

### Session cloud 1, suite : « Préparer un formulaire »

Constat : les outils de création du ruban (Texte, Case, Radio, Liste, Signature) ne faisaient
RIEN, aucun calque ne gérait le tracé. Les champs du fichier n'étaient pas modifiables.

Fait (étapes A à D) :
- A. Modèle `FieldProps`, `FieldEdit` et `state.fieldEdits` ; ops/formedit.ts
  (`setFieldProps`, `applyFieldEdits` : déplacement, suppression d'un champ ou d'un widget,
  renommage dans l'arbre des noms, propriétés) ; core/forms/afscripts.ts (scripts AF* dans
  les deux sens) ; createFields réécrit (libellés des listes, non modifiables par défaut,
  /DV, défaut Unicode, /TU aussi sur les widgets pour pdf.js).
- B. ui/PrepareLayer.tsx : tracer, ou cliquer pour la taille par défaut ; sélection avec Maj ;
  déplacer ; 8 poignées ; flèches (Maj : 10 pt) ; Suppr ; Entrée ou double-clic pour les
  propriétés. Tient compte de la rotation. Bouton « Préparer » dans le ruban ; un outil de
  champ fait entrer dans le mode.
- C. ui/FieldProperties.tsx : onglets Général, Aspect, Options, Format, Validation, Calcul.
  Propriétés relues depuis pdf.js (`fieldFlags`, `annotationFlags`, actions) ; seules les
  modifications sont écrites.
- D. En sortant de « Préparer », les champs sont intégrés au document (recomposition comme
  l'OCR, état de la session gardé) : pdf.js les remplit avec scripts et formats.
- Défaut corrigé au passage : avec l'outil Sélection (V), les champs n'étaient plus
  cliquables (le calque d'annotations passait au-dessus).
- Ancien ui/FormLayer.tsx supprimé (calque de remplissage maison, remplacé par pdf.js en F1).
- Tests : pdf-formedit (11), pdf-afscripts (6), parcours navigateur « préparer ».

Limites connues, à reprendre :
- Après la recomposition, l'historique d'annulation repart de zéro (comme l'OCR).
- L'ordre de tabulation (/Tabs, ordre des /Annots) n'est pas encore réglable.
- Pas encore de boutons d'action (envoyer, réinitialiser, imprimer), de copier-coller ni de
  duplication de champs, de sélection au lasso ni de magnétisme.

Reste T2 :
- ordre de tabulation, boutons d'action, duplication et « placer plusieurs » (Acrobat) ;
- alertes des scripts dans une boîte Elium (reporté à T10) ;
- XFA : message clair et remplissage AcroForm de secours ;
- champs obligatoires signalés avant l'enregistrement ;
- relecture adversariale de T2.

### Session cloud 1, suite : XFA

- P0 corrigé : `PDFDocument.getForm()` de pdf-lib SUPPRIME le XFA à chaque appel. Tout
  enregistrement touchant un champ détruisait un formulaire XFA dynamique, qui devenait
  illisible dans Acrobat. ops/pdfform.ts `formOf()` accède au formulaire sans cet effet ;
  tous les appels de ops/ l'utilisent.
- ops/xfa.ts : XFA hybride (champs AcroForm présents) rempli → partie XFA retirée pour
  qu'Acrobat affiche les valeurs, avec un avertissement dans le rapport. XFA dynamique :
  jamais touché, y compris à l'aplatissement.
- Interface : badge et bandeau distinguent hybride (remplissable) et dynamique (lecture
  seule, Acrobat requis).
- Tests : pdf-xfa (3).
- Pour plus tard : remplir un XFA dynamique demanderait le calque XFA de pdf.js
  (`enableXfa`) et `saveDocument` pour les datasets.

### Session cloud 1, suite : relecture adversariale T2 et premier correctif T3

Relecture en deux passes par des agents indépendants, chaque défaut reproduit :
- écriture des formulaires : 17 défauts, dont 2 P0 (renommage vers une autre branche qui
  perdait type et valeur ; collisions dans l'arbre des noms). Tous corrigés, tests :
  tests/pdf-form-review.test.ts ;
- interface : 10 défauts, dont 1 P0 (Suppr en mode Préparer supprimait aussi les
  annotations sélectionnées avant). Corrigés 1, 3 à 10, tests navigateur « préparer :
  relecture ». Le 2 n'est corrigé qu'en partie : le mode demandé est rétabli, mais
  l'historique d'annulation repart toujours de zéro après intégration des champs.

Aussi corrigé (T3, premier point du diagnostic) : le texte écrit dans les pages
(paragraphe modifié, commentaire texte libre, filigrane, en-tête et pied, calque OCR)
perdait tout ce qui sort de WinAnsi (« Łódź » devenait « ód »), et sanitiseForFont
remplaçait à tort les tirets et guillemets typographiques. `FontBook.forText` choisit une
police Unicode (Liberation Sans) si nécessaire ; tests/pdf-unicode-text.test.ts.

Limites connues, à reprendre :
- historique d'annulation perdu à la sortie de « Préparer » ;
- polices Unicode de secours : Sans seulement (Liberation Serif et Mono à embarquer) ;
- en mode Préparer, l'export des données utilise encore les anciens noms des champs
  renommés ;
- un champ placé d'un clic sur une page pivotée a la bonne taille à l'écran, mais son
  texte n'est pas redressé (/MK /R à écrire).

Suite : T3, édition de texte et d'images.
- Diagnostic à faire sur des PDF Chrome/Edge : détection des blocs, reflux, alignement,
  aperçu à l'écran différent du fichier (coupures de ligne).
- Polices Serif et Mono.

## T3 : édition de texte et d'images

### Session cloud 1, tranche 1

Diagnostic fait sur un corpus Chromium généré (titres, paragraphes, deux colonnes,
tableau, liste, centré/droite ; Arial et Times). Script :
scratchpad/t3/make.mjs, non versionné ; à régénérer au besoin avec page.pdf().

Corrigé :
- Deux colonnes fusionnées ligne à ligne, et tableau en un seul bloc :
  - `groupLines` coupe une ligne de base aux écarts de plus d'environ 1 em (y compris les
    espaces synthétiques larges de pdf.js entre les cellules) ;
  - `groupBlocks` est sensible aux colonnes (une ligne rejoint le bloc ouvert au-dessus
    d'elle qui la recouvre) et sépare le bloc quand l'interligne s'ouvre ou quand une ligne
    en gras suit du texte normal.
- Texte justifié : il était détecté « gauche ».
- Gras et italique n'étaient JAMAIS détectés : pdf.js ne donne qu'un identifiant de
  police (« g_d0_f2 »). `PdfEngine.fonts()` et `pageFontFacts` lisent les vraies polices.
  Aussi utilisé pour l'export Word.
- Famille de la police de substitution déduite du vrai nom (`familyOf`), et Liberation
  Serif et Mono embarquées (src/pdf/assets/fonts, SIL OFL) : un paragraphe en Times reste
  en police à empattements.
- Aperçu : c'est maintenant le RENDU RÉEL de la page réécrite par le code de
  l'enregistrement (ops/editpreview.ts), et non plus du HTML approximatif. L'écran montre
  les mêmes coupures de ligne et les mêmes polices que le fichier.
- Tests : pdf-text-blocks (6), pdf-unicode-text (5).

Reste T3 :
- Liste : un seul bloc (comme Acrobat, à affiner).
- Tableau : un bloc par colonne.
- Mise en forme dans l'éditeur (gras, italique, taille, couleur, alignement), police
  d'origine réutilisée quand elle couvre le texte, sinon sous-ensemble.
- Déplacer ou redimensionner un bloc de texte ; ajouter du texte.
- Images : ajouter, déplacer, redimensionner, remplacer, rogner, supprimer (vérifier
  l'existant).
- Pages Edge ou « Microsoft Print to PDF » (texte minuscule ou en miroir d'après le
  diagnostic) : pas reproduit avec Chromium, corpus du poste nécessaire.

### Session cloud 1, tranche 2 : éditeur de texte et images

Fait :
- Éditeur de texte : barre de mise en forme (police, taille, gras, italique, couleur,
  alignement), déplacement par poignée, largeur, « Ajouter du texte » dans le contenu
  de la page (pas un commentaire). Test navigateur pdf-textedit.spec.ts (Drive + bureau).
- Images du contenu de la page, en mode « Modifier le texte » (ImageEditLayer.tsx) :
  - cadre sur chaque image que la page dessine elle-même (pas celles des XObjects de
    formulaire, pas les images en ligne) ;
  - sélection, déplacement, redimensionnement par les coins (proportions gardées, Maj pour
    libérer), flèches (1 pt, Maj 10 pt), Suppr ;
  - Remplacer… (garde la largeur du cadre, avec les proportions de la nouvelle image),
    Supprimer, Rétablir ;
  - « Ajouter une image » (ruban Modifier) : l'image va DANS le contenu de la page.
    L'ancien outil « Image » (tampon, annotation) reste, en petit bouton.
  - Aperçu : la page reconstruite par le code de l'enregistrement, comme pour le texte.
- Écriture (textedit.ts, applyImageEdits) : suppression du `Do`, remplacement par un
  nouveau XObject, déplacement par `q, CTM⁻¹, M, CTM, Do, Q` (une image tournée ou en miroir
  le reste), ajout en fin de contenu.
- Corrigé : ce qui est ajouté en fin de contenu héritait d'un `cm` laissé en vigueur par le
  flux de la page (Chromium/Skia) : image ajoutée réduite à 24 % et déplacée. Le contenu
  d'origine est maintenant isolé dans `q … Q` quand il ne se termine pas dans l'état par
  défaut (`leavesDefaultState`) ; même protection pour le texte réécrit.
- Tests : pdf-image-edit (8), pdf-imageedit.spec.ts (2 × Drive + bureau). Suite complète
  1909/1909.

À vérifier dans Acrobat sur le poste :
- une image déplacée, redimensionnée, remplacée et ajoutée (fichier Chromium ou Word) :
  position identique à l'écran d'Elium ;
- l'image remplacée garde la transparence d'un PNG.

- « Rogner » : les coins choisissent la partie visible (chemin de découpe `re W n` dans le
  fichier), « Annuler le rognage ». Tests unitaires (2) et navigateur (Drive + bureau).

- Corrigé : une image que le fichier découpe déjà (Word et Acrobat découpent les images à
  leur cadre) DISPARAISSAIT une fois déplacée : la découpe d'origine restait en vigueur à
  l'endroit du `Do`. Maintenant, à l'endroit du `Do` :
  - toute la pile d'état est refermée, l'image est dessinée dans l'état par défaut (même
    place dans l'ordre de dessin), puis l'état attendu par la suite est reconstruit
    (`stateBefore` : opérateurs d'état et découpes des niveaux encore ouverts) ;
  - la découpe du fichier est lue (`walkPlacements` suit les découpes, `clipCrop`) et
    devient le rognage de l'image dans l'éditeur ; « Annuler le rognage » la retire.
  Tests : 3 de plus dans pdf-image-edit ; suite complète 1914/1914.

Reste T3 :
- Découpe non rectangulaire (image dans un cercle) : ramenée à son rectangle englobant
  si l'image est déplacée.
- Images dans les XObjects de formulaire et images en ligne (BI).
- Liste : un seul bloc ; tableau : un bloc par colonne.
- Réutiliser le sous-ensemble de la police d'origine quand il couvre le nouveau texte
  (aujourd'hui : police d'origine si elle encode tout, sinon Liberation).
- Pages Edge ou « Microsoft Print to PDF » : corpus du poste nécessaire.
- L'historique d'annulation est remis à zéro en quittant « Préparer un formulaire » (T2).

## T4 : commentaires

### Audit (session cloud 1)

Plan, par ordre d'impact (preuves fichier:ligne dans l'audit) :
1. Un enregistrement SANS modification supprime les Popups et les réponses des annotations
   non modélisées (Caret, FileAttachment…) et laisse des /Popup orphelins
   (import-annots.ts stripImportedAnnots).
2. Membres de groupe /IRT /RT /Group (« Remplacer le texte ») et réponses aux réponses :
   retirés du modèle puis du fichier.
3. FreeText : la couleur du texte est écrite dans /C, que l'import (et Acrobat) lit comme
   fond.
4. Statut de révision non compatible Acrobat : pas de réponse d'état /State, /StateModel
   seul sur le parent ; jamais importé.
5. Une annotation importée puis modifiée perd /AP, /NM, /RC, /Popup, /Name, les bits /F,
   /Measure et les données de caviardage.
6. « Déverrouiller » ne peut jamais marcher (updateAnnots saute les verrouillées) ;
   le verrou est contournable par updateAnnot.
7. L'outil Aire produit une annotation vide (dans BOX_TOOLS).
8. Le bouton Tampon ne fait rien ; pas de bibliothèque de tampons, ni de tampons
   dynamiques ou personnalisés.
9. Pages tournées : texte, notes et tampons diffèrent entre l'écran et le fichier ; les
   tampons tournés sont coupés.
10. /Rect gonflé sans /RD : les formes et les légendes grandissent à chaque aller-retour.
11. XFDF : statut jamais relu, origine du CropBox ignorée, terminaisons de ligne fausses,
    opacité 0 → 1, pas de fusion par nom ; commentaires FDF absents.
12. Manquants : Caret et modifications de texte, pièce jointe, icônes de note, réglage de
    l'auteur, styles par outil mémorisés, filtres type/page/coche, synthèse PDF et
    impression avec commentaires, modifier ou supprimer une réponse.

### Session cloud 1 : T4, points 1 et 2 corrigés

- Une seule règle décide ce que le modèle reprend d'un fichier (`ownedAnnotations`,
  import-annots.ts), partagée par l'import, l'enregistrement et le masque du lecteur :
  - un commentaire d'un type modélisé qui ne répond à rien ;
  - une réponse /Text (/RT /R) dont le fil remonte à un tel commentaire (les réponses aux
    réponses rejoignent le fil au lieu d'être perdues) ;
  - la fenêtre contextuelle de tout ce qui est repris.
  Tout le reste reste dans le fichier tel quel et est dessiné par pdf.js : Caret, pièce
  jointe, membres de groupe /RT /Group (« Remplacer le texte » d'Acrobat), réponses à ce
  qui n'est pas repris, et leurs fenêtres contextuelles.
- Un enregistrement sans modification ne supprime plus rien.
- Ce qui dépend d'un commentaire réécrit (le Caret groupé avec un barré) est rattaché au
  nouvel objet ; si le commentaire est supprimé, le Caret part avec lui, comme dans
  Acrobat.
- Tests : pdf-annot-ownership (6, qui échouent sans le correctif). Suite complète
  1920/1920 ; specs PDF navigateur 26/26.
- À vérifier dans Acrobat sur le poste : ouvrir un PDF avec « Remplacer le texte », une
  pièce jointe et un fil de réponses, enregistrer dans Elium sans rien modifier, puis
  en modifiant le barré : tout doit rester visible et lié dans Acrobat.

### Session cloud 1 : T4, points 3, 4, 6, 7 et 8

- FreeText (point 3) : /C = couleur du CADRE (absent si transparent), couleur du texte
  dans /DA avec une police que tout lecteur connaît (/Helv, /TiRo, /Cour), /DS ajouté ;
  machine à écrire écrite et relue avec /IT FreeTextTypeWriter.
- Statut de révision (point 4) : écrit comme Acrobat, en réponse d'état
  (/IRT, /StateModel (Review), /State (Accepted…)), relu à l'import (le statut du
  commentaire est sa dernière action). L'inspecteur passe maintenant par la même action
  que le panneau (la réponse est ajoutée au fil).
- Verrou (point 6) : un commentaire verrouillé ne prend plus aucune modification sauf
  son déverrouillage, qui marche enfin (y compris pour un commentaire importé).
- Surface (point 7) : dessinée point par point comme un polygone (l'annotation était
  vide).
- Tampons (point 8) : bibliothèque (model/stamps.ts, menu du bouton Tampon) :
  - les 14 tampons standard d'Acrobat, avec leur /Name ;
  - 5 tampons dynamiques (auteur, date et heure figés à la pose, comme Acrobat) ;
  - tampons personnalisés à partir d'une image, mémorisés dans ce navigateur
    (localStorage, 12 au plus, oubli possible).
  Un tampon relu d'un fichier (d'Acrobat ou d'Elium) retrouve son entrée. /Name et /Subj
  sont lus par pdf-lib (`resolveAnnotExtras`) : pdf.js ne les donne pas pour les tampons.
- Tests : pdf-annot-ownership (10), pdf-comments.spec.ts (2, Drive + bureau). Suite
  complète 1924/1924 ; specs PDF navigateur 30/30.
- À vérifier dans Acrobat : un tampon dynamique et un tampon standard d'Elium (libellé,
  2e ligne) ; une zone de texte transparente et une sur fond jaune ; le statut
  « Accepté » visible dans le panneau Commentaires d'Acrobat.

### Session cloud 1 : T4, point 5

- Une annotation importée puis modifiée garde ce que le modèle ne modifie pas (lu par
  pdf-lib, `resolveAnnotExtras`, maintenant dès qu'il y a des annotations à importer) :
  /NM, les bits /F autres que Masqué/Verrouillé (NePasImprimer, NoZoom, NoRotate,
  ReadOnly…), /Open de la fenêtre, /RC (texte riche, tant que le texte n'a pas changé),
  l'icône de la note (/Name : Key, Help…), et pour un caviardage, /OverlayText et /IC.
- Tests : 2 de plus dans pdf-annot-ownership. Suite complète 1926/1926 ; specs PDF 30/30.

### Session cloud 1 : T4, point 10

- Les formes et les légendes ne grandissent plus à chaque aller-retour :
  - /RD écrit pour les carrés, cercles, zones de texte et légendes (la boîte de la forme
    dans le /Rect élargi pour le trait) et relu à l'import ;
  - plus d'élargissement pour ce qui n'a pas de trait (tampons, images, notes, liens,
    texte sans bordure).
- Aussi corrigé : pdf.js ne transmet jamais /IT. Une légende revenait en simple zone de
  texte sans sa ligne, et les mesures distance, aire et périmètre revenaient en simples
  formes. /IT, /CL et /LE sont lus par pdf-lib.
- Test : trois enregistrements puis réouvertures, boîtes et ligne de légende identiques.
  Suite complète 1927/1927 ; specs PDF 30/30.

### Session cloud 1 : T4, point 9

- Pages tournées (/Rotate 90, 180, 270) : les zones de texte, machines à écrire, cadres de
  légende, notes, tampons, images et signatures sont peints tournés contre la page
  (`upright`), donc droits à la lecture, comme à l'écran d'Elium et comme dans Acrobat.
  Cela vaut pour l'apparence et pour l'aplatissement ; /Rotate est écrit pour Acrobat. La
  ligne d'une légende reste dans l'espace de la page.
- Un tampon tourné sur lui-même n'est plus coupé : son /Rect contient ses coins tournés.
- Tests : 4 (échouent sans le correctif). Suite complète 1931/1931 ; specs PDF 30/30.
- À vérifier dans Acrobat : une page paysage tournée à 90° avec une zone de texte et un
  tampon d'Elium, qui doivent être droits ; puis modifier la zone dans Acrobat, qui doit
  rester droite.

### Session cloud 1 : T4, point 11 (XFDF)

- XFDF réécrit selon la spécification XFDF 3.0 d'Adobe et ce qu'Acrobat écrit :
  - statut en réponse d'état (`state` / `statemodel`), relu, avec aussi l'ancien
    `<elium:status>` ;
  - origine du CropBox dans les deux sens ;
  - toutes les terminaisons de ligne aux deux bouts (head, tail) ;
  - opacité et épaisseur 0 conservées ;
  - zones de texte : `color` = fond, texte dans `defaultappearance`, justification,
    légende (`callout`, intent), machine à écrire ;
  - mesures (intent Dimension), nuage, pointillés, caviardages (overlay-text,
    interior-color), icône de note, /Open, tampons (icon = /Name de la bibliothèque,
    rotation), drapeaux (masqué, verrouillé, noprint…), texte riche, fuseau horaire des
    dates ;
  - les membres de groupe (« Remplacer le texte ») ne sont plus pris pour des
    réponses ; les réponses aux réponses rejoignent le fil.
- Réimporter les mêmes commentaires les met à jour au lieu de les dupliquer (par `name`,
  ou par le /NM du fichier d'origine).
- Tests : pdf-xfdf (10). Suite complète 1941/1941 ; specs PDF 30/30.
- À vérifier dans Acrobat : exporter les commentaires d'Elium en XFDF puis « Importer les
  commentaires » dans Acrobat, et l'inverse.

### Session cloud 1 : T4, point 11 (FDF de commentaires) et un correctif formulaires

- Commentaires en FDF (ops/fdfcomments.ts), le format natif d'« Exporter les
  commentaires » d'Acrobat :
  - export (bouton « Exporter FDF ») : les annotations sont écrites par le code de
    l'enregistrement (apparences, /RD, réponses, états) puis sérialisées en FDF, avec
    /Page à la place de /P ;
  - import (« Importer » accepte un FDF, qui peut porter des champs ET des
    commentaires) : les annotations sont posées sur des pages vides de la taille du
    document, puis lues comme un PDF ouvert. Elles reçoivent de nouveaux id, et le /NM
    sert à les reconnaître à une réimportation.
  Tests : pdf-fdf-comments (2), spec navigateur (export puis import, Drive + bureau).
- Corrigé : l'icône d'une note avec apparence était perdue à l'import (pdf.js remplace
  /Name par « NoIcon »).
- Corrigé (formulaires, trouvé en chassant un test instable) : ce qui était tapé dans un
  champ à script de frappe (AFNumber_Keystroke…) AVANT que le moteur de scripts soit
  chargé disparaissait (pdf.js annule la frappe et attend la réponse du moteur), puis
  une valeur vide était validée : total faux. Tant que le moteur charge, la réponse est
  calculée localement (sans filtrage), et même si la frappe arrive avec la valeur
  d'avant la réponse précédente, aucun caractère n'est perdu. Seules les validations
  attendent le moteur. Un événement parti vers un moteur reconstruit entre-temps est
  renvoyé au nouveau au lieu d'être perdu. Test déterministe (moteur retardé de 3 s),
  qui échoue sans le correctif.
- Suite complète 1943/1943 ; specs PDF 34/34 ; stress 40/40 à 4 workers.
- À vérifier dans Acrobat : exporter en FDF depuis Elium puis « Importer les
  commentaires » dans Acrobat, et un FDF de commentaires d'Acrobat importé dans Elium.

### Session cloud 1 : T4, point 12 (1re partie)

- Panneau Commentaires :
  - coche d'Acrobat par commentaire, écrite en réponse d'état /StateModel (Marked),
    relue du PDF et du XFDF, hors du fil ;
  - filtres par type, par page et par coche, en plus d'auteur, statut et recherche. Le
    panneau utilise `filterComments` au lieu d'une copie ; les zones blanchies n'y
    figurent plus ;
  - réponse modifiable (double-clic) et supprimable (×).
- Icône des notes : les 7 icônes de la norme (Commentaire, Note, Aide, Insertion, Clé,
  Nouveau paragraphe, Paragraphe), au choix dans l'inspecteur, dessinées pareil à l'écran
  et dans le fichier (model/noteicons.ts), /Name écrit et relu.
- Tests : 3 unitaires, 1 XFDF, 1 navigateur. Suite complète 1947/1947 ; specs PDF 36/36.

### Session cloud 1 : T4, point 12 (2e partie)

- Auteur des commentaires : bouton « Auteur » (ruban Commenter, Révision), l'équivalent
  de Préférences → Identité dans Acrobat. Mémorisé dans ce navigateur (ui/prefs.ts) ;
  « Moi » tant que rien n'est choisi.
- Propriétés mémorisées par outil, comme la barre de propriétés d'Acrobat : une couleur,
  une épaisseur ou une police choisie outil en main (sans sélection) reste à cet outil,
  y compris dans un autre document. L'inspecteur a « Par défaut » : les prochains
  commentaires de ce type prennent l'aspect du commentaire sélectionné.
- Test navigateur (Drive + bureau). Suite complète 1947/1947 ; specs PDF 38/38.

### Session cloud 1 : T4, point 12 (3e partie) : modifications de texte

- « Insérer du texte au curseur » et « Remplacer le texte » (ruban Commenter, Texte),
  comme Acrobat :
  - insertion : un Caret au point d'insertion, portant le texte à insérer ;
  - remplacement : la sélection barrée, plus un Caret juste après avec le nouveau texte.
    Le barré est membre du groupe du Caret (/IRT, /RT /Group, /IT /StrikeOutTextEdit),
    donc un seul commentaire au panneau (« Remplacement de texte »), supprimé d'un bloc.
  Relu du PDF (une paire Acrobat devient la même paire modifiable) et en XFDF ;
  réimporter garde le lien du groupe.
- Corrigé : tout barré, surlignage, etc. avait un /Rect élargi de 8 pt de chaque côté (les
  terminaisons de ligne absentes étaient prises pour présentes).
- Tests : 1 PDF, 2 XFDF, 1 navigateur. Suite complète 1950/1950 ; specs PDF 40/40.
- À vérifier dans Acrobat : un « Remplacer le texte » fait dans Elium doit apparaître
  dans Acrobat comme le sien (un seul commentaire, texte de remplacement au survol du
  barré), et l'inverse.

### Session cloud 1 : T4, point 12 (4e partie) : pièces jointes

- « Joindre un fichier » (ruban Commenter, Notes) : on choisit le fichier (50 Mo au plus),
  puis on clique sur la page. Le fichier est intégré au PDF (/FS → /EF, flux
  EmbeddedFile avec type MIME, taille et date), avec les icônes de la norme (Punaise,
  Trombone, Graphique, Étiquette) dessinées pareil à l'écran et dans le fichier.
  Double-clic pour enregistrer le fichier.
- Relu à l'ouverture (fichier, nom, description, icône : pdf.js 6 ne donne plus le
  contenu, pdf-lib le lit) et en XFDF (`<fileattachment>` avec `<data encoding="hex">`,
  comme Acrobat).
- Tests : 1 unitaire (octets identiques, pdf.js la reconnaît), 1 XFDF, 1 navigateur.
  Suite complète 1952/1952 ; specs PDF 42/42.
- À vérifier dans Acrobat : une pièce jointe posée dans Elium s'ouvre dans Acrobat
  (panneau Pièces jointes et double-clic sur l'icône).

### Session cloud 1 : T4, point 12 (fin) : synthèse des commentaires

- « Synthèse » produit maintenant un PDF, comme « Résumer les commentaires » d'Acrobat
  (disposition « Document et commentaires avec lignes de connexion ») :
  - chaque page commentée réduite à gauche, avec un repère numéroté par commentaire ;
  - à droite, la liste : type, auteur, date, statut, coche, texte, réponses ;
    « Remplacement de texte » et « Insérer » pour les modifications de texte, le nom du
    fichier pour une pièce jointe ;
  - des lignes relient chaque repère à son entrée ;
  - feuilles « (suite) » si la liste déborde, polices Unicode.
  « Imprimer la synthèse » l'imprime ; l'impression normale imprime déjà le document avec
  ses commentaires.
- Tests : pdf-summary (3). Suite complète 1955/1955 ; specs PDF 42/42 ; budget du bundle
  respecté.

T4 : tous les points de l'audit sont traités. Limites connues : la gomme efface
l'annotation entière (pas un morceau de trait) ; pas de tampons dynamiques
personnalisables (champs de formulaire dans le tampon) ; les enregistrements audio
d'Acrobat (Sound) restent intacts dans le fichier, mais ne sont ni lus ni créés.

## T5 : organisation des pages

### Audit (session cloud 1), par ordre d'impact
1. Étiquettes de page écrites fausses pour tous les styles (« 11 », « iv1 ») ; les
   étiquettes du fichier ne sont jamais lues ni retirées.
2. Le clavier global de l'organiseur supprime des pages sur Retour arrière tapé dans un
   dialogue.
3. Les pages supprimées restent dans le fichier (références des widgets, liens, signets,
   destinations nommées) : fuite de contenu et champs orphelins.
4. Les pages « exclues » sont supprimées pour de bon et forcent une réécriture complète.
5. L'extraction prend les mauvaises pages quand des pages sont exclues.
6. Signets jamais recalés après un réordonnancement, une suppression ou une insertion.
7. « Avant la page 1 » insère à la fin.
8. Insertion de PDF ou d'images seulement à la fin ; un PDF inséré perd ses champs et
   ses signets ; images forcées en A4 portrait ; pas de presse-papiers.
9. Bouton « Redimensionner » inerte ; pas de remplacement, de déplacement vers N, ni de
   rotation paire/impaire/180°.
10. Rognage en espace non tourné ; décalage possible des annotations ; pas de rognage
    automatique des marges.
11. Découpage : téléchargements multiples sans zip, découpage par taille en O(n²) ;
    fichiers dérivés sans AcroForm, signets ni métadonnées.
12. Glisser-déposer : pas de dépôt en fin, pas de côté d'insertion, pas de setData
    (Firefox) ; pas de sélection au lasso ; en-têtes/pieds ignorent la rotation et ne
    s'enlèvent pas ; Bates disparaît si l'en-tête n'a pas {bates}.

### Session cloud 1 : T5, point 1 (étiquettes de page)
- Chaque page étiquetée porte sa définition (style, préfixe, numéro) ; à l'enregistrement,
  les plages /PageLabels sont reconstruites pour l'ordre final (nouvelle plage à chaque
  changement de style, de préfixe ou de numérotation). Avant : « iv » écrit en préfixe
  suivi de « 1 » → « iv1 ».
- Les étiquettes du fichier sont lues (arbre de nombres, /Kids compris) et suivent leurs
  pages déplacées ou supprimées ; un fichier non touché garde les siennes.
- Tests : pdf-page-labels (3, lus par pdf.js).

### Session cloud 1 : relecture adversariale de T4, 11 défauts corrigés
- HAUTE : l'export XFDF collait le /RC brut, avec son prologue XML ; le fichier était
  invalide pour presque tous les commentaires Acrobat, et injectable. Le /RC est
  maintenant relu comme XML, inséré seulement s'il est bien formé, prologue retiré.
- HAUTE : un groupe (barré et Caret) importé par FDF perdait son lien ou s'accrochait au
  mauvais commentaire. Les liens suivent désormais les nouveaux id.
- HAUTE : l'id pdf.js « 12R » voyageait comme /NM ou nom XFDF, et une fusion remplaçait
  un commentaire sans rapport d'un autre document. Chaque commentaire importé reçoit un
  vrai /NM unique ; un id pdf.js n'est jamais exporté, jamais pris comme id à l'import,
  jamais rapproché d'un nom (ops/annotids.ts).
- Coordonnées XFDF/FDF décalées sur une page rognée dans Elium.
- `fringe` (le /RD du XFDF) lu, et écrit pour les légendes.
- Pièces jointes de plus de 4 Mo : ni décodées à l'ouverture ni copiées dans l'état ;
  leur /FS d'origine est réutilisé à l'enregistrement.
- Lien de groupe vers un Caret situé sur une autre page (`linkGroups`, une passe sur tout
  le document).
- Type MIME des pièces jointes validé ; synthèse : sauts de ligne \r d'Acrobat ; FDF sans
  liens ni zones blanchies, avec les marques de caviardage ; réponse d'état sans texte
  conservée ; commentaires de code à jour.
- Tests : 10 de plus. Suite complète 1968/1968 ; specs PDF 42/42.
