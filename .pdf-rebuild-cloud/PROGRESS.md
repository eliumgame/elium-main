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
