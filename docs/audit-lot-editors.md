# Lot F — éditeurs : bilan par constat

Reprise le 3 novembre 2026 sur le checkout partagé `master` (HEAD observé à la dernière reprise : `e2c2831`). Source : `batch-F-editors.json` du scratchpad de l'audit `3e7aa5f6-bb03-469d-8747-a62856d2140c`, constats et votes relus. Les identifiants F-00 à F-22 ci-dessous sont les **indices zéro-based** du tableau JSON, pas de nouveaux identifiants d'audit.

**Pas de clôture globale : 15 constats corrigés dans le périmètre, 1 partiellement corrigé avec dépendance hors périmètre, 7 restant à déléguer hors périmètre.** Aucun constat de ce lot n'était déjà entièrement corrigé lors de sa vérification. Les fichiers des autres agents ont été conservés. Aucun changement de branche, push ou publication.

## Commits autonomes

- `4352be6` — tableur : texte littéral, calculs, dates et limites XLSX.
- `143d9e7` — chargement/persistance des éditeurs, import des fichiers applicatifs, assainissement et historique des diapositives, avis PPTX.
- `c70a777` — exports en vue finale, mise en forme des paragraphes et repères de pagination.
- Un commit complémentaire contient les tests d'aller-retour XLSX et le présent bilan.

## Bilan exhaustif

| Constat | Statut | Vérification, action et preuve |
| --- | --- | --- |
| F-00 — Bombe ZIP DOCX | **Reste — hors périmètre** | `format/docx.ts` laisse toujours passer les parties hors médias dans son filtre. Demande au parent : plafonds centraux et réels dans `docxToDoc`, filtre commun et contrôle de `passport/ficheImport.ts` / `format/coop-zip.ts`. Ne pas seulement protéger App : les autres appelants resteraient exposés. |
| F-01 — Décompression XLSX / chaînes partagées | **Corrigé** | `xlsx-stream.ts` extrait les petites parties en flux avec allocation plafonnée et vérification de la taille réelle ; 64 Mio par partie et 128 Mio cumulés. Chaînes partagées : 64 Mio décompressés et un million d'entrées maximum. Blocs compressés de 1 Kio pour borner l'expansion par appel. Correction d'une balise `<si` coupée entre blocs, découverte par le test du plafond. Tests : taille centrale mensongère, trop de chaînes et suite `xlsx-stream`. |
| F-02 — Formulaires dans les diapositives | **Corrigé dans le périmètre** | Les deux rendus HTML du canevas passent par `sanitizeSlideHtml`, avec liste limitée aux balises de texte riche et aux attributs nécessaires. Formulaires, champs, boutons, classes de l'application et URL JavaScript supprimés. Test fonctionnel de sanitisation. Demande complémentaire au parent : `form-action 'none'` dans les CSP de `deploy/Caddyfile` et `installer/elium_launcher.py` (hors périmètre). |
| F-03 — Injection à l'export CSV | **Reste — hors périmètre** | `views/SheetView.tsx` écrit toujours `disp` avec seulement l'échappement CSV. Demande au parent : neutraliser les préfixes de formules, en préservant les nombres, dans ce point d'entrée. L'import CSV corrigé ne suffit pas : une formule utilisateur peut produire un texte commençant par `=`. |
| F-04 — Markdown quadratique | **Reste — hors périmètre** | `format/importers.ts` conserve `INLINE.map(...re.exec(rest))` à chaque caractère. Demande au parent : tokenizer borné et test sur longue suite de délimiteurs non fermés. |
| F-05 — Écrasement du deck pendant son chargement | **Corrigé** | État `loaded`, ref de garde commune à l'autosauvegarde, au démontage et à `flush`; résultat tardif ignoré après démontage ; ref du deck mise à jour dès l'hydratation ; écran de chargement. Même garde ajoutée au timer du tableur, signalé dans les votes. Tests : chargement supérieur au debounce, flush, démontage précoce, succès différé, coffre en erreur ; test de garde équivalent pour le tableur. |
| F-06 — Fichier .elium applicatif sans autosauvegarde | **Corrigé** | App enregistre le deck/classeur dans le stockage local et le catalogue avant d'ouvrir une session persistante. Le chemin `initial` sans session n'est plus utilisé lors de cette ouverture. Les échecs sont remontés au lieu de basculer silencieusement dans Documents. La copie suit la politique du coffre local ; le fichier source n'est pas réécrit. Une ouverture depuis l'ancien stockage `drive` crée également une copie de travail persistante, sans supprimer l'original. Preuves : revue du chemin App, typage et tests des stores ; pas de parcours UI/IndexedDB de bout en bout réalisé pour cette migration. |
| F-07 — Suppressions suivies exportées | **Corrigé** | Une vue finale non mutante retire les nœuds portant `deletion` avant les trois sérialiseurs, y compris les collectes des titres, notes et index. `insertion` reste visible. HTML utilisé également par PDF. Tests HTML/Markdown/texte avec titre supprimé, sommaire et insertion ; modèle source conservé. |
| F-08 — Brouillon incomplet | **Reste — partiellement corrigé** | La clé de changement dans App porte maintenant sur `file.document`, donc une modification de page ou de métadonnées déclenche le cycle. Mais `format/drafts-store.ts` ne persiste toujours que `doc` et `page`. **Demande au parent** : étendre `DraftContent`, l'enregistrement clair/chiffré et `resolveDraft` aux styles, thème, filigrane et ressources ; coordonner ensuite les appels App de sauvegarde, récupération et téléchargement, ainsi que la clé de changement des ressources. Ne pas considérer ce constat comme corrigé. |
| F-09 — Mise en forme des paragraphes perdue | **Corrigé** | Export des espacements, retrait de première ligne positif/négatif, bordures et trame ; réutilisation de `bordersCss`; lettrine et autres styles fusionnés dans un seul attribut. Test sur tous les attributs et unicité de `style`. |
| F-10 — Notes DOCX perdues | **Reste — hors périmètre** | L'import est dans `format/docx.ts`. Demande au parent : reconstruire les notes aux références ou avertir explicitement de leur perte, avec aller-retour DOCX ; mettre la documentation au présent. |
| F-11 — Graphiques PPTX multi-séries | **Corrigé** | Avertissement explicite lorsque plusieurs séries sont présentes dans un graphique effectivement importé. Les graphiques combinés non pris en charge gardent leur propre avertissement, sans message trompeur annonçant une importation partielle. Test de graphique à deux séries construit depuis un PPTX exporté et suite des types PPTX. Le modèle reste mono-série, comme admis dans la recommandation. Demande documentaire au parent : préciser cette limite dans 04-03. |
| F-12 — Dérive de pagination après grand bloc | **Corrigé pour le défaut confirmé par les votes** | Une page traversée sans espaceur interne avance selon la hauteur réelle du contenu, sans inventer un interstice. Test : bloc de 250 px sur pages de 100 px, bloc suivant et espaceur ; suites des sections. La découpe visuelle interne des tableaux n'est pas implémentée et la parité exacte écran/impression n'est pas certifiée. Demande au parent : documenter cette limite. |
| F-13 — Historique de texte/navigation | **Corrigé** | `setActive` utilise `setQuiet`. Début d'édition clavier et double-clic créent un checkpoint. Tests : plus de 100 navigations ne chassent plus l'édition ; Ctrl+Z revient au texte précédent ; entrée clavier/double-clic appelle le checkpoint ; tests de focus et de l'éditeur. |
| F-14 — Documentation des modèles | **Reste — hors périmètre** | 04-01 contient toujours « Seuls le Compte rendu et le Procès-verbal ». Demande au parent : aligner sur `editor/templates.ts`, sans modifier les modèles fonctionnels. |
| F-15 — Documentation des médias PPTX | **Reste — hors périmètre** | 04-03 affirme encore que les médias ne sont pas relus, alors que le lecteur les importe. Demande au parent : supprimer la contradiction et conserver les plafonds réels. |
| F-16 — Texte numérique converti | **Corrigé** | Marqueur apostrophe pour les textes importés qui seraient interprétés ; lecture DOM et flux cohérentes ; moteur et export XLSX le respectent. Les zéros initiaux, longs entiers, préfixes hexadécimaux et Infinity restent du texte. Tests des types `s`, `inlineStr`, `str` sur les deux lecteurs, valeurs calculées et réexport `inlineStr`, plus suites XLSX. Aucun nouveau format de fichier ; le marqueur permet aussi la saisie explicite d'un texte numérique. |
| F-17 — ROUND / ROUNDUP / ROUNDDOWN | **Corrigé** | Décalage décimal de l'exposant au lieu de multiplier les doubles ; valeur absolue puis signe pour les demi-valeurs négatives. Tests 1,005 ; -2,5 ; 0,07 ; ±0,29 ; précision négative, et suite des formules. |
| F-18 — MOD et signe | **Corrigé** | Reste ajusté au signe du diviseur, zéro normalisé. Tests `MOD(-1;3)=2`, `MOD(5;-3)=-1` et suite existante. |
| F-19 — Critères et jokers | **Corrigé** | Égalité/inegalité textuelle insensible à la casse avec `*`, `?` et échappement `~`, sans expressions régulières à backtracking. Fonction partagée des familles IF/IFS. Tests de casse, jokers, échappement et négation. |
| F-20 — Formules actives depuis CSV | **Corrigé** | Import synchrone/asynchrone conserve les champs comme textes littéraux, dont `=...` et les nombres. Ils ressortent en chaînes XLSX ; aucune balise `<f>` créée pour ces champs. Tests sync/async et adaptation du test CSV qui attendait auparavant un nombre brut. |
| F-21 — Dates/fuseaux et NOW | **Corrigé** | Affichage des sériels en UTC, jour tronqué au lieu d'être arrondi ; NOW encode les champs de l'heure locale comme TODAY. Tests des dates avec fraction de jour et égalité INT(NOW())/TODAY(), relancés sous `TZ=America/Guadeloupe`. |
| F-22 — Documentation Drive/miroir | **Reste — hors périmètre** | 04-07 décrit encore l'archive unique et exclut les réglages du Détecteur ; 04-06 exclut aussi ces réglages. Demande au parent : décrire le stockage incrémental et les réglages effectivement synchronisés, en tenant compte des protections des racines de confiance déjà ajoutées par le lot Drive. |

## Validation

- **155 tests passent dans 14 fichiers ciblés**, avec `--maxWorkers=2` : `audit-editors-sheet`, `audit-editors-slides`, `audit-editors-export`, `sheet-formula`, `sheet-csv`, `xlsx-stream`, `xlsx-roundtrip`, `xlsx-export`, `slides-vault-reload`, `slides-edit-focus`, `slides-editor`, `slides-pptx-import`, `doc-pagination-sections`, `export-injection`.
- **15 tests passent en UTC-4** : `TZ=America/Guadeloupe`, `audit-editors-sheet.test.ts`, un worker.
- `tsc --noEmit -p web-studio/tsconfig.json` : réussite à la dernière exécution. Une exécution antérieure avait relevé une erreur dans `pdf/ops/pades.ts`, disparue après les changements de l'autre agent ; ce fichier n'a pas été modifié par ce lot.
- ESLint sur tous les fichiers de code modifiés et les trois nouvelles suites : réussite, zéro erreur et zéro avertissement à la dernière exécution.
- Prettier appliqué aux fichiers modifiés. Les avertissements Vite concernant esbuild/oxc et Node concernant localStorage sont indépendants du lot.
- Pas de suite complète coûteuse, pas d'installation de dépendances. La première tentative d'utiliser `python` a déclenché automatiquement le gestionnaire Windows PyManager, qui a annoncé sa mise à jour avant d'échouer à trouver un runtime ; aucune nouvelle tentative ni installation Python volontaire. Toutes les éditions ont ensuite utilisé Node déjà installé.

## Fichiers modifiés par ce lot

Préfixe `web-studio/src/` :

- `App.tsx`
- `editor/Pagination.ts`
- `export/exporters.ts`
- `sheet/csv.ts`, `sheet/format.ts`, `sheet/formula.ts`, `sheet/numeric.ts`
- `sheet/useLocalSheetStore.ts`, `sheet/xlsx-export.ts`, `sheet/xlsx-import.ts`, `sheet/xlsx-stream.ts`
- `slides/SlidesEditor.tsx`, `slides/canvas.tsx`, `slides/pptx-import.ts`, `slides/sanitize.ts`, `slides/store.ts`, `slides/useLocalDeckStore.ts`

Tests : `web-studio/tests/audit-editors-sheet.test.ts`, `audit-editors-slides.test.tsx`, `audit-editors-export.test.ts`, `sheet-csv.test.ts`.

Documentation autorisée pour ce lot : `docs/audit-lot-editors.md`.

## Transmission au parent

Les demandes hors périmètre sont explicitement consignées aux lignes F-00, F-03, F-04, F-08, F-10, F-14, F-15 et F-22, avec compléments CSP/documentation aux lignes F-02, F-11 et F-12. Aucun fichier de ces autres périmètres n'a été modifié. Ce bilan est destiné à leur prise en charge par le parent ; leur réalisation n'est pas revendiquée.
