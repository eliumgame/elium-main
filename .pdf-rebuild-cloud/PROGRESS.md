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

### Session cloud 1 : T5, points 2, 4, 5 et 7
- Le clavier de l'organiseur ignore ce qui est tapé dans un champ ou un dialogue
  (Retour arrière dans le dialogue de rognage supprimait les pages sélectionnées).
- Pages exclues : « Enregistrer » les garde dans le document ; seules les copies,
  impressions et extractions les laissent de côté (elles étaient supprimées pour de bon,
  contrairement à l'infobulle).
- Extraction : les indices tiennent compte des pages exclues (mauvaises pages extraites).
- « Avant la page 1 » insère bien en tête (et non à la fin).

### Session cloud 1 : T5, point 6 (signets)
- Les signets suivent leurs pages à chaque déplacement, suppression, insertion,
  duplication ou inversion (`followPages`). Un signet vers une page supprimée tombe sur la
  page suivante. À l'enregistrement, les numéros sont convertis vers l'ordre écrit (pages
  exclues retirées).
- Les signets du fichier, simplement déplacés avec leurs pages, restent ceux du fichier
  (actions comprises) au lieu d'être réécrits.
- Duplication : les modifications d'images sont copiées, les liens de groupe suivent les
  copies, et une copie ne reprend pas le /NM de l'original.

### Session cloud 1 : T5, point 3 (pages retirées et dupliquées)
- Une page retirée ne reste plus dans le fichier par ce qui pointait vers elle
  (`purgeRemovedPages`) :
  - ses widgets sortent du formulaire, et les champs sans widget disparaissent ;
  - les signets vers elle vont à la page suivante conservée ;
  - ses destinations nommées (/Dests et arbre /Names) et les liens vers elle sont
    retirés ;
  - l'action d'ouverture revient à la page 1 ;
  - l'arbre de structure lâche ses /Pg.
  Son contenu ne subsiste plus dans le fichier (test).
- Page dupliquée : ses widgets rejoignent les champs d'origine, même nom et même valeur,
  comme Acrobat (`shareCopiedFields`). Un champ fusionné avec son widget est scindé en
  champ plus deux widgets. Avant : widget orphelin, hors formulaire.
- Tests : pdf-page-refs (2, qui échouent sans le correctif). Suite complète 1972/1972 ;
  specs PDF 42/42.

### Session cloud 1 : T5, point 8 (insertion)
- « Depuis un PDF » et « Depuis une image » demandent maintenant la position (avant ou
  après la page N, à la fin), comme Acrobat. Les pages blanches ont aussi une
  orientation (portrait ou paysage).
- PDF inséré :
  - ses champs rejoignent le formulaire (/Fields, polices /DR) : ils se remplissent et
    s'enregistrent ;
  - ses signets arrivent sous un signet au nom du fichier, pointant vers les pages
    insérées (destinations explicites ou nommées) ;
  - les pages exclues du document ne sont plus perdues au passage.
- Image insérée : la page a la taille de l'image (96 ppp), ramenée au A4 si elle est plus
  grande ; avant, tout était en A4 portrait.
- Tests : 1 unitaire, 2 navigateur (Drive + bureau). Suite complète 1973/1973 ; specs PDF
  46/46.
- Reste point 8 : coller depuis le presse-papiers ; autres formats (Office, HTML, TIFF
  multipage).

### Session cloud 1 : T5, point 9
- « Faire pivoter… » : 90° à droite, 90° à gauche ou 180°, sur la sélection, toutes les
  pages, les paires, les impaires ou une plage (« 1-3, 7, 10- »).
- « Déplacer vers la page… » : avant ou après la page N, au début, à la fin.
- « Redimensionner » (le bouton était inerte) : format et orientation, contenu mis à
  l'échelle et centré, ou taille gardée (marges ajoutées ou coupées), sur une portée de
  pages. La rotation propre de la page est prise en compte, les annotations suivent. Le
  document est reconstruit puis rouvert (`recompose`), comme une insertion.
- « Remplacer » : les pages N à M par autant de pages d'un autre PDF (mot de passe
  demandé s'il le faut). Les champs de ces pages sont repris, et ce qui pointait vers les
  pages remplacées est nettoyé.
- Tests : 1 unitaire (`resizePage`), 1 navigateur enchaînant les quatre (Drive +
  bureau). Suite complète 1974/1974 ; specs PDF 48/48.

### Session cloud 1 : T5, point 10 (rognage)
- Marges données telles qu'on les voit : chaque page les convertit selon sa rotation (sur
  une page tournée, « Haut » coupait un autre bord).
- Rogner ne déplace plus les annotations : ce qui est posé sur la page (commentaires,
  modifications de texte et d'images, champs créés) suit l'origine de la page et reste au
  même endroit du contenu.
- « Détecter les marges blanches » (la page rendue, bords du contenu, 2 pt gardés), et
  « Retirer les marges blanches de chaque page », chacune les siennes.
- Tests : 2 unitaires, 1 navigateur. Suite complète OK ; specs PDF OK.

### Session cloud 1 : T5, point 11 (extraction, découpage)
- Les fichiers extraits ou découpés sont complets (`buildSubset`) :
  - métadonnées, étiquettes de page de leurs pages, champs de formulaire ;
  - les signets qui tombent dans la partie (un parent hors partie reste pour ses
    enfants) ;
  - les liens vers des pages hors partie sont retirés, puis les objets devenus
    inaccessibles aussi : le contenu d'une page voisine n'était plus entraîné par un
    lien.
- Découpage par taille : chaque page est pesée une fois, puis les parties sont remplies
  (avant : une reconstruction par page, O(n²)).
- Découpage par signets : numéros convertis vers la copie (pages exclues), et deux
  sections de même titre ne s'écrasent plus.
- Plusieurs parties : une seule archive .zip (les navigateurs bloquaient les
  téléchargements en rafale).
- Tests : 2. Suite complète 1978/1978 ; specs PDF 50/50.

### Session cloud 1 : T5, point 12 (marques de page, vue Organiser)
- Marques de page (`ops/decorate.ts`, réécrit) :
  - en-têtes, pieds de page, filigranes et numéros Bates sont placés selon la page vue :
    sur une page tournée (/Rotate), l'en-tête longe le bord du haut, à l'endroit ;
  - le contenu d'origine est fermé dans q…Q : une transformation qu'il laisse en place
    ne déplace plus les marques ;
  - les plages de pages sont calculées une fois par enregistrement ;
  - le numéro Bates apparaît dès qu'aucune bande ne contient `{bates}`, même si un
    en-tête est actif ; il a sa propre plage de pages, et la numérotation ne court que
    sur ces pages ;
  - nouveaux réglages : « Premier n° de page » pour `{page}`, et « Couleur de fond »
    (l'arrière-plan d'Acrobat, sous le contenu) ;
  - chaque marque est un artefact balisé (`/Artifact … /EliumMark`) : lecteurs d'écran
    et extraction de texte l'ignorent ;
  - « Supprimer d'abord les marques déjà présentes » retire les marques d'Elium et
    celles d'Acrobat (XObject `/ADBE_CompoundType /Private /Watermark|Header|Footer|
    Background`). Les en-têtes courants d'un traitement de texte restent.
- Vue Organiser :
  - dépôt avant ou après une page selon la moitié survolée, avec une barre dans
    l'intervalle ; dépôt possible après la dernière page ;
  - `dataTransfer.setData` au début du glisser : Firefox ne démarrait pas sans ;
  - des PDF ou des images déposés depuis l'explorateur ou le Drive sont insérés à
    l'endroit visé ;
  - sélection au lasso depuis le fond de la grille (défilement près des bords) ;
  - clavier : flèches, Début et Fin pour se déplacer ; Maj étend la plage ; Alt +
    flèches déplace les pages sélectionnées ;
  - une insertion ou un remplacement lancé depuis la vue Organiser y reste (elle se
    refermait).
- Tests : 8 unitaires (`pdf-page-marks.test.ts`), 2 navigateur (`pdf-marks.spec.ts`,
  vue Organiser). Suite complète 1986/1986 ; specs PDF 54/54 (Drive + bureau).
- À valider dans Acrobat :
  - en-tête sur une page tournée de 90° ;
  - fond de couleur ;
  - « Supprimer » d'Acrobat sur un fichier marqué par Elium (Acrobat ne reconnaît sans
    doute pas nos marques comme les siennes : à vérifier) ;
  - suppression par Elium de marques posées par Acrobat.
- Reste pour T5 : dialogue « Combiner » (liste de fichiers et ordre), insertion depuis
  le presse-papiers.

### Session cloud 1 : T5, Combiner et presse-papiers (T5 terminé hors revue)
- « Combiner des fichiers » (`ui/CombineDialog.tsx`, `mergeDocuments` réécrit) :
  - liste de PDF et d'images, ordre par glisser ou flèches, sélection de pages par
    fichier ;
  - le document ouvert est proposé en tête, avec ses modifications ;
  - un signet par fichier (réglable), avec les signets du fichier dessous, y compris
    pour une sélection de pages ;
  - champs de formulaire repris, fichiers protégés ouverts par mot de passe ;
  - le résultat s'ouvre comme un nouveau document non enregistré ;
  - accessible depuis le ruban (Organiser, Accueil : « Combiner », anciennement
    « Fusionner », qui ne faisait qu'insérer) et depuis l'accueil PDF.
- Défaut corrigé : deux fichiers ayant un champ de même nom donnaient deux champs
  homonymes. Le champ copié rejoint désormais celui qui existe (comportement
  d'Acrobat), récursivement pour les noms hiérarchiques. Cela vaut aussi pour
  « Insérer depuis un PDF ».
- Presse-papiers :
  - bouton « Presse-papiers » (Organiser > Insérer) ;
  - Ctrl+V dans la vue Organiser ;
  - images, PDF ou texte (mis en page sur A4 par `textToPdf`), insérés après la
    sélection.
- Les pages image insérées et combinées ont la même taille (`imagePageSize`).
- Tests : 3 unitaires, 3 navigateur. Suite complète 1989/1989 ; specs PDF 60/60.
- À valider dans Acrobat :
  - un fichier combiné contenant deux fois le même formulaire : un seul champ par
    nom, valeur partagée ;
  - les signets par fichier.

## T6 : navigation

### Audit (session cloud 1), par ordre d'impact
1. Replier un signet réécrit tout le sommaire : actions URI, nommées, GoToR et JS, /SE,
   zoom, position, /Fit* et état ouvert/fermé sont perdus ; /C [0 0 0] est ajouté partout.
2. Écrire les signets force /PageMode /UseOutlines.
3. Destinations de signets et de liens décalées quand l'origine du CropBox n'est pas
   0 ; la rotation est ignorée.
4. Un signet sans page (URI, nommé…) mène à la page 1.
5. L'état replié des signets (/Count négatif) est ignoré à la lecture.
6. Calques : un calque masqué par défaut ne peut jamais être affiché, et le panneau le
   coche. Manquent aussi l'imbrication, /Locked, /RBGroups, l'impression, « visibilité
   par défaut » et l'aplatissement.
7. Liens créés avec l'outil :
   - numéro de page figé : faux après réorganisation ;
   - enregistrés sans bordure, /H, /C ni zoom ;
   - créés sans action.
8. Recherche :
   - les options ne relancent pas la recherche ;
   - pas d'options mot entier ni accents ;
   - la recherche part de la page 1 ;
   - numéros de page faux après réorganisation ;
   - accents décomposés non trouvés ;
   - mots coupés en fin de ligne non trouvés.
9. Recherche lente sur 1000 pages (≈ 530 ms par frappe, sans temporisation) ; ni les
   commentaires ni les signets ne sont cherchés.
10. Pas d'historique vue précédente / suivante (Alt+← / Alt+→) ; les actions GoBack et
    GoForward sont inertes ; NextPage et PrevPage sont faux après réorganisation.
11. Case de numéro de page : les étiquettes ne sont pas acceptées, saut à chaque frappe,
    pas de validation par Entrée.
12. Édition des signets : ni glisser, ni imbrication, ni vue courante (zoom et
    position), ni texte sélectionné, ni style ou couleur, ni « tout déplier » ; « depuis
    les titres » remplace le sommaire au lieu de s'y ajouter.
13. Liens du fichier non modifiables (non importés) ; pas de destination nommée, de
    fichier ni de zoom ; pas de « Créer des liens à partir des URL ».
14. Vue initiale ignorée et non modifiable (/PageLayout, /PageMode, /OpenAction,
    /ViewerPreferences).
15. Pièces jointes : liste seule (pas d'ajout, de suppression ni de description ; noms en
    double confondus ; pièces jointes des commentaires absentes). Pas de panneau
    Destinations.

### Session cloud 1 : T6, points 1 à 5 (signets fidèles)
- Chaque signet garde sa position dans le sommaire du fichier. À l'enregistrement, il
  réutilise son élément d'origine : seul ce qui a été modifié est réécrit (titre,
  repli, style, place dans l'arbre).
- Sont conservés : actions (URI, nommées, GoToR, JavaScript), /SE, destination exacte
  (/XYZ gauche, haut, zoom ; /Fit*), et /C seulement s'il existe.
- /PageMode n'est plus forcé à /UseOutlines.
- Lecture : zoom, gauche, type d'ajustement, état replié (/Count négatif), action.
  Un signet sans page ne mène plus à la page 1 : un lien web s'ouvre après
  confirmation, une action nommée s'exécute sur l'ordre actuel des pages, les autres
  sont signalées.
- Destinations écrites et lues par rapport à l'origine du CropBox ; sur une page
  tournée, le point visé est converti selon la rotation affichée.
- Nouveau signet : la vue courante (page, point en haut à gauche, zoom), titré avec le
  texte sélectionné s'il y en a. Bouton « Définir la destination sur la vue courante ».
- Après une recomposition qui garde l'état (préparation de formulaire, OCR), les
  signets sont rattachés aux éléments du nouveau fichier.
- Couvre aussi le défaut n° 4 de la relecture T5.
- Tests : `pdf-bookmarks.test.ts` (4).

### Session cloud 1 : relecture adversariale de T5, 10 défauts corrigés
1. Fuite de contenu. Extraire, diviser, insérer ou combiner une sélection entraînait
   des pages non choisies : leur contenu entier venait par un champ partagé ou par un
   lien. Corrigé par `copyPagesMapped` :
   - un seul copieur, informé à l'avance de la copie de chaque page ;
   - les pages non copiées deviennent `null` ;
   - les widgets restés hors des pages copiées sont retirés de leurs champs.
   La duplication de page à l'enregistrement et l'aperçu d'édition l'utilisent aussi.
2. Liens entre pages : supprimés des parties extraites, ou pointant vers une copie
   orpheline après insertion. Ils sont désormais gardés et justes. Les liens vers une
   page absente sont retirés partout.
3. Caviardage et modifications de texte ou d'images décalés sur une page rognée : le
   rognage et la rotation sont maintenant appliqués avant eux. C'était une régression
   de T5.
4. Signets web transformés en « aller à la page » : corrigé par T6 (points 1 à 5).
5. « Combiner » avec le document ouvert : la plage est lue dans la numérotation
   affichée (pages exclues comprises), puis convertie vers la copie.
6. Supprimer les marques ne retire plus que la séquence /Artifact : une séquence /Span
   qui en contient une n'efface plus toute la page.
7. Découpage par taille : chaque objet est compté une fois par partie (une image
   partagée par toutes les pages ne pèse plus 20 fois).
8. Insérer garde les étiquettes des pages existantes ; les pages insérées prolongent la
   numérotation qui les précède. « Remplacer » garde les étiquettes par position.
9. Page retirée : l'arbre de structure retire ses MCID, MCR et OBJR, puis les éléments
   vidés (avant, ils se rattachaient à la page d'un ancêtre).
10. Une recomposition (insertion, remplacement, redimensionnement) n'incruste plus les
    marques non enregistrées. Le document rouvert garde les pages exclues, les réglages
    de marques et les métadonnées.
- Aussi : une page prise deux fois (plage « 1,1 ») a ses propres annotations.
- Tests : `pdf-organize-review.test.ts` (9), 1 navigateur (`pdf-marks.spec.ts`). Suite
  complète 2002/2002 ; specs PDF 62/62.
- Non confirmés, laissés en suivi :
  - le lasso qui dépasse l'écran ;
  - les champs déplacés dans « Préparer » puis rognés ;
  - les signets des pages remplacées ;
  - les annotations partagées lors de la duplication interne.

### Session cloud 1 : T6, point 6 (calques)
- Les bascules de l'utilisateur sont des surcharges dans les deux sens, appliquées dans
  l'ordre des clics : un calque masqué par défaut peut enfin être affiché, et le
  panneau montre la visibilité réelle calculée par pdf.js.
- Hiérarchie de /Order lue dans le fichier (pdf.js perd les enfants d'un calque),
  titres de groupe, calques verrouillés (/Locked : case désactivée), groupes exclusifs
  (/RBGroups : boutons radio ; en allumer un éteint les autres).
- « Enregistrer la visibilité actuelle comme état par défaut » : /OCProperties /D
  /BaseState ON, /ON, /OFF à l'enregistrement.
- Limites restantes : aplatir les calques ; état d'impression distinct (/Usage /Print)
  non géré à l'impression ; les miniatures ignorent les calques.
- Tests : `pdf-layers.test.ts` (3). Suite 2005/2005 ; specs PDF 61/62 : le test
  « saisie pendant le chargement des scripts » est instable sous charge en bureau
  (12/12 isolément), à surveiller.

### Session cloud 1 : T6, points 8 à 11 (recherche, historique, case de page)
- Recherche :
  - relance automatique, temporisée, quand la requête ou une option change ;
  - nouvelles options « Mots entiers » et « Accents » (respectés ou ignorés) ;
  - accents décomposés (NFD) trouvés dans les deux modes ;
  - mots coupés en fin de ligne (« exam-⏎ple ») trouvés ;
  - textes repliés mis en cache par page (plus de repli à chaque frappe) ;
  - résultats dans l'ordre actuel des pages, rien depuis une page supprimée ;
  - premier résultat pris à partir de la page lue ;
  - la liste des résultats affiche les étiquettes de page, et ajoute des sections
    Commentaires (texte et réponses) et Signets.
- Étiquettes du fichier (/PageLabels) enfin affichées (miniatures, vue Organiser,
  résultats, case de page) ; elles suivent leurs pages.
- Case de page :
  - accepte une étiquette (« iv », « A-3 ») ou un numéro ;
  - Entrée pour valider (plus de saut à chaque frappe) ;
  - affiche « étiquette (n / N) » ; Ctrl+Maj+N pour y aller.
- Vue précédente / suivante (Alt+← / Alt+→) après un lien, un signet, la case de page ou
  une action nommée. GoBack et GoForward fonctionnent ; NextPage et les autres
  actions nommées comptent les pages dans l'ordre actuel.
- Les liens du fichier suivent maintenant toute leur destination (zoom, ajustement,
  position horizontale).
- Tests : 3 unitaires (recherche), `pdf-navigation.spec.ts` (3 × 2 projets). Suite
  2008/2008 ; specs PDF 68/68.

### Session cloud 1 : T6, points 7 et 13 (liens)
- Lien tracé : un dialogue « Créer un lien » s'ouvre aussitôt (apparence, action) ;
  « Modifier le lien… » dans l'inspecteur le rouvre.
- Destination liée à la page elle-même (elle suit la page déplacée), avec la vue :
  page entière, ou la vue affichée (position et zoom). Les anciennes sessions (numéro
  seul) fonctionnent toujours.
- Actions : page du document, page web, commande nommée (page suivante et précédente,
  première et dernière, vue précédente et suivante).
- Apparence écrite comme Acrobat : rectangle invisible (/Border [0 0 0], sans /C) ou
  visible (/BS : épaisseur, plein, tirets ou souligné ; /C ; apparence dessinée), et
  /H au clic.
- Écran : un lien se suit au clic avec les outils de sélection et la main ; l'outil
  Lien le sélectionne, le déplace et le redimensionne, et trace les nouveaux.
- « Créer des liens à partir des adresses web du texte » : http(s)://… et www.…
  deviennent de vrais liens, sauf là où il y en a déjà un.
- Reste : modifier ou supprimer les liens déjà présents dans le fichier (ils restent
  affichés et suivis par pdf.js) ; lien vers un autre fichier (GoToR).
- Tests : `pdf-links.test.ts` (3), 1 navigateur (× 2 projets). Suite 2011/2011 ;
  specs PDF 70/70.

### Session cloud 1 : T6, points 12, 14 et 15 (T6 terminé hors relecture)
- Signets :
  - glisser-déposer pour réordonner ou imbriquer (avant, après, dedans ; jamais dans
    sa propre branche) ;
  - tout déplier et tout replier ; filtre de recherche ;
  - style (gras, italique) et couleur ;
  - la page affichée utilise l'étiquette ;
  - « depuis les titres » ajoute au sommaire au lieu de le remplacer.
- Vue initiale :
  - lue dans le fichier (/PageMode, /PageLayout, /OpenAction, /ViewerPreferences) ;
  - appliquée à l'ouverture : panneau, disposition, page et agrandissement ;
  - onglet « Vue initiale » dans Propriétés ; écrite à l'enregistrement.
  - Défaut trouvé au passage : pdf.js 6 renvoie des Map pour /OpenAction,
    /ViewerPreferences et les pièces jointes. Le panneau Pièces jointes était vide
    pour tous les fichiers.
- Pièces jointes du document :
  - contenu lu avec pdf-lib (pdf.js 6 ne le donne plus) ; clé unique (les noms en
    double ne se confondent plus) ;
  - ajout (25 Mo au plus), suppression, modification de la description ;
  - celles des commentaires sont aussi listées.
- Lecture pdf-lib du fichier partagée (calques, pièces jointes), déchiffrée avec le mot
  de passe du document.
- Limites notées :
  - pas de panneau Destinations nommées ;
  - liens existants du fichier non modifiables ;
  - pas de GoToR ;
  - calques ni aplatis ni imprimés selon /Usage.
- Tests : 3 unitaires (arbre de signets, vue initiale, pièces jointes), 1 navigateur.
  Suite 2014/2014 ; specs PDF 72/72.
- À valider dans Acrobat :
  - vue initiale écrite par Elium ;
  - signets réécrits (actions conservées) ;
  - liens visibles (/BS) ;
  - calques « visibilité par défaut » ;
  - pièces jointes ajoutées, décrites et supprimées.

### Session cloud 1 : T6, panneau Destinations
- Destinations nommées : liste (filtrable), aller à, créer à partir de la vue affichée,
  supprimer.
- Écrites à l'enregistrement : arbre /Names /Dests trié, clés ASCII en chaîne simple
  (les liens comparent les octets) ; /Dests du catalogue si l'arbre est découpé en /Kids.
- Test unitaire (ajout, suppression, résolution). Suite 2027/2027 ; specs PDF 72/72.

## T7 : sécurité

### Audit (session cloud 1), par ordre d'impact
- Vérifié correct :
  - protection AES-256 R6 (qpdf l'ouvre avec les deux mots de passe, /Perms juste) ;
  - enregistrements incrémentaux de fichiers protégés (RC4, AES-128, AES-256) ;
  - le caviardage réécrit tout le fichier ; glyphes Type3, texte OCR invisible et TJ
    retirés.
1. Caviardage : le texte dans les XObjects de formulaire reste (non parcourus), sans
   avertissement.
2. Caviardage d'image : l'image « retirée » reste entière dans /Resources ; sous 2 %
   de recouvrement, rien n'est retiré ; tout ou rien (une ligne caviardée efface toute
   la page scannée).
3. Caviardage : la valeur du champ reste dans l'AcroForm (/V), et /Kids [null] reste
   pendant.
4. Informations masquées gardées après caviardage, sans proposer de les supprimer :
   - titres de signets, /Alt, /ActualText, Info, JavaScript du document, /Thumb ;
   - annotations recouvertes à 25 % ou moins ;
   - dessins vectoriels sous la zone.
5. « Assainir » annonce avoir tout retiré mais laisse :
   - des fichiers incorporés (/AF) ;
   - du JavaScript dans les liens, widgets et signets, et des actions Launch ;
   - commentaires, valeurs de champs, texte caché, calques masqués ;
   - /PieceInfo, /Thumb, /Alt, clés Info personnalisées.
6. Les permissions des fichiers ouverts sont ignorées : tout est permis, la protection
   peut être retirée sans le mot de passe propriétaire, et les copies sortent non
   chiffrées.
7. Le mot de passe propriétaire prend par défaut la valeur du mot de passe
   d'ouverture : les restrictions ne servent à rien.
8. Modèles de recherche à caviarder :
   - IBAN tronqué ;
   - NIR sans Corse ni préfixes 3, 4, 7, 8 ;
   - téléphones internationaux absents ;
   - pas de carte bancaire (Luhn), de SIRET/SIREN, de dates.
9. Bits 1-2 de /P mis à 1 (-1 au lieu de -4).
10. Options :
    - AES-256 seul ; permissions en cases brutes au lieu des choix d'Acrobat ;
    - mots de passe R6 sans SASLprep ;
    - /Filter non vérifié.
11. Chiffrement par certificat absent.
12. Visionneuse globalement saine. À faire :
    - préférence « Activer JavaScript » ;
    - boîtes alert/confirm des scripts à encadrer ;
    - copies d'impression non nettoyées de leur JavaScript.

### Session cloud 1 : relecture adversariale de T6, 7 défauts corrigés
1. Pièce jointe ajoutée à un arbre /EmbeddedFiles en /Kids : perdue à la réouverture
   (pdf-lib ajoutait /Names à côté de /Kids).
2. Arbre non trié après ajout, et /Limits périmés après suppression.
   Correctif pour les deux : nouveau module `ops/nametree.ts` (lecture dans l'ordre,
   réécriture en une feuille triée par octets, clés uniques), utilisé aussi par les
   destinations. Le fichier joint est construit à la main (plus de `doc.attach`).
3. Lien vers une page supprimée ou exclue : il était enregistré vers la page qui avait
   pris son numéro. Il reste maintenant sans destination.
4. Régression : panneau Calques vide sans /Order. Repli sur /OCGs, à plat.
5. « Visibilité par défaut » : allumait les groupes hors /Order. L'état existant (/ON,
   /OFF, /BaseState) est maintenant fusionné.
6. Pièces jointes de même nom : une seule listée, et les deux supprimées. Clés par
   position (#0, #1…), lecture par pdf-lib.
7. Vue initiale : /OpenAction n'est réécrit que si la page ou l'agrandissement ont
   changé (un script ou une position exacte restent).
- Aussi :
  - course entre recherches (numéro de requête) ;
  - bascule de calque sur un état périmé ou sur un autre document ;
  - « liens depuis les URL » comparait deux repères sur les pages rognées ;
  - lecture pdf-lib libérée 15 s après usage.
- Tests : `pdf-navigation-review.test.ts` (8). Suite 2023/2023 ; specs PDF 72/72.

### Session cloud 1 : T7, caviardage et informations masquées (points 1 à 5)
- Caviardage (`ops/redact.ts`, moteur réécrit) :
  - descente dans les XObjects de formulaire (copiés avant modification : une autre
    page peut les dessiner), sur 8 niveaux au plus ;
  - pixels couverts détruits dans une copie de l'image. Pris en charge : brut, Flate
    (prédicteurs PNG compris), 1 à 16 bits par composante, CMYK ; JPEG décodé dans le
    navigateur puis réécrit sans perte. Sinon, l'image est retirée entière, avec un
    avertissement ;
  - les originaux ne sont plus référencés, donc élagués à la réécriture complète ;
  - dessins vectoriels couverts à plus de 50 % retirés (texte vectorisé, formes) ;
  - toute annotation touchée retirée, avec sa pop-up ; un champ dont tous les widgets
    partent quitte le formulaire, valeur comprise (plus de /Kids [null]).
- Informations masquées (`removeHiddenInfo`), en catégories comme dans Acrobat :
  - métadonnées (tout /Info, XMP partout, /PieceInfo, vignettes) ;
  - fichiers joints (/EmbeddedFiles, /AF, pièces jointes et multimédia) ;
  - liens, actions et JavaScript (document, pages, champs, signets hors « aller à »,
    XFA) ;
  - signets, commentaires ;
  - texte invisible (Tr 3, la position des glyphes suivants est gardée) ;
  - calques masqués (contenu supprimé, calques fusionnés) ;
  - textes de remplacement (/Alt, /ActualText, /E, dictionnaires imbriqués et contenu
    marqué compris).
- « Appliquer le caviardage » ouvre un dialogue qui propose aussi de supprimer les
  informations masquées. Coché par défaut : tout sauf les commentaires et le texte
  invisible (OCR).
- « Nettoyer le document » : toutes les catégories, et les champs sont aplatis. Le
  rapport ne dit plus que ce qui a réellement été supprimé.
- Limite : le texte blanc sur blanc n'est pas détecté.
- Tests : `pdf-redaction.test.ts` (5 ; recherche de texte résiduel dans tous les objets,
  flux décodés). Délai des assertions Playwright porté à 12 s (échecs d'ouverture sous
  charge). Suite 2028/2028 ; specs PDF 72/72.
- À valider dans Acrobat : un fichier caviardé (image partiellement couverte, XObject)
  et un fichier nettoyé.

### Session cloud 1 : T7, protection (points 6 à 12)
- Permissions des fichiers ouverts, appliquées comme dans Acrobat (hors mot de passe
  propriétaire) :
  - chaque commande et chaque outil demande son droit : impression, copie et
    extraction, organisation, modification, commentaires, remplissage, sécurité ;
  - la copie (Ctrl+C) est bloquée ; une saisie de champ interdite est annulée ;
  - « Mot de passe des autorisations » demandé à ce moment-là : le bon lève toutes les
    restrictions pour la session, un faux est refusé ;
  - un fichier protégé seulement à l'ouverture n'est pas restreint ;
  - `inspectProtection` sait si le mot de passe utilisé est celui du propriétaire.
- Dialogue « Protéger » refait comme Acrobat :
  - mot de passe d'ouverture et mot de passe des autorisations, chacun confirmé ; le
    second doit différer du premier ;
  - impression (aucune, basse, haute résolution) ; modifications (aucune, pages,
    formulaires, commentaires, toutes sauf extraction) ; copie ; lecteurs d'écran ;
  - sans restriction demandée, le mot de passe propriétaire est aléatoire (il ne
    reprend plus le mot de passe d'ouverture).
- /P conforme (bits 1-2 à 0, 7-8 et 13-32 à 1 : -4 pour tout autoriser).
- Mots de passe AES-256 normalisés (NFKC, approche de SASLprep), avec repli sur la
  forme brute pour les fichiers déjà écrits.
- Protection par certificat détectée : message clair au lieu de « mot de passe
  incorrect ».
- Modèles de recherche à caviarder (`ops/redactpatterns.ts`), avec contrôle quand le
  format en a un :
  - IBAN (mod 97, dernier groupe compris) ;
  - NIR (Corse 2A/2B, préfixes 3/4/7/8, clé) ;
  - téléphones français (+33 (0)…) et internationaux ;
  - cartes (Luhn), SIRET/SIREN (Luhn), dates.
- JavaScript des documents : préférence « JavaScript » (onglet Protéger). Les boîtes
  alert, confirm et prompt des scripts indiquent leur origine (le document, pas Elium) ;
  au-delà de 3 en 10 s, elles sont ignorées.
- Les invites de mot de passe d'un PDF inséré masquent la saisie.
- Restent :
  - chiffrement par certificat ;
  - niveaux AES-128 et RC4 à la création (AES-256 seul) ;
  - chiffrer seulement les pièces jointes ;
  - texte blanc sur blanc.
- Tests : `pdf-security-t7.test.ts` (7), `pdf-protection.spec.ts` (restrictions puis
  déverrouillage, Drive + bureau). Suite 2035/2035 ; specs PDF 74/74.
- À valider dans Acrobat : les autorisations écrites (impression basse résolution,
  « commentaires et formulaires »), et une ouverture avec chaque mot de passe.

## T8 : signatures

### Audit (session cloud 1), par ordre d'impact
- Vérifié correct : une signature PAdES simple (pyHanko 0.37 : INTACT, UNTOUCHED,
  ENTIRE_FILE, SHA-256, RSA) ; les enregistrements après signature sont incrémentaux.
1. Deuxième signature impossible : réécriture complète, et recherche du premier
   /ByteRange (celui de l'ancienne signature). Erreur « Placeholder /ByteRange trop
   court ».
2. Vérification trompeuse : un contenu modifié après signature s'affiche « Valide »
   (pas d'analyse des révisions ni de DocMDP).
3. « Chaîne vérifiée » affiché pour n'importe quelle autorité incluse par le
   signataire : pas de magasin de confiance.
4. Faux négatifs à la vérification :
   - SHA-256 imposé ; clés RSA seules ;
   - certificat pris en premier plutôt que par l'identifiant du signataire ;
   - validité jugée à la date du jour et non à la date de signature ;
   - nom de champ inventé ;
   - /ByteRange dans un flux d'objets non trouvé.
5. Clés EC impossibles pour signer (node-forge), avec un message qui accuse le mot de
   passe.
6. Mot de passe PKCS#12 saisi en clair.
7. Le PDF signé est seulement téléchargé : le document ouvert reste non signé, et un
   « Enregistrer » ultérieur écrase la version signée.
8. PAdES B-B non conforme : pas de signing-certificate-v2, signing-time dans la CMS.
9. Pas d'horodatage RFC 3161 ni de LTV (DSS/VRI) ; le réseau est fermé par la CSP du
   poste.
10. Pas de certification DocMDP, de FieldMDP ni de /Lock.
11. Champ préparé : SigFlags non fixé ; un clic sur un champ de signature vide ne lance
    rien.
12. Apparence visible réduite à l'image : pas de nom, date, motif ni lieu ; motif
    imposé.
13. Ni panneau Signatures ni affichage de la version signée.
14. Identifiant auto-signé jetable (recréé à chaque signature, mot de passe fixe) ;
    génération bloquante.
15. Remplir et signer :
    - initiales non gérées ;
    - signatures enregistrées perdues hors .elium ;
    - proportions fausses à la restauration ;
    - outils coche, croix, point et date absents.
