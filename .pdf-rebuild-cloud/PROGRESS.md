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
