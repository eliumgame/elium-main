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
