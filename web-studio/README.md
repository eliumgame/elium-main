# web-studio

Frontend React/Vite/TypeScript d'Elium : les éditeurs Documents, Tableur,
Présentations et PDF, ainsi que le client Drive Cloud (stockage chiffré de
bout en bout, partage, signature électronique, co-édition temps réel).

## Structure de `src/`

- **components** — composants transverses de l'interface (barre supérieure, palette de commandes, modales de mot de passe / sauvegarde d'identité / réglages).
- **crypto** — primitives cryptographiques génériques (coffre local, dérivation de clés, gestion des clés de destinataires) utilisées par les autres modules.
- **detector** — analyse d'un document (signaux de formatage, d'image, de métadonnées, de texte, détection de plagiat) et génération du rapport correspondant.
- **docs** — la vue de documentation intégrée à l'application (contenu et rendu).
- **drive-cloud** — client du Drive Cloud chiffré : comptes, API, opérations sur les nœuds, synchronisation collaborative CRDT, récupération et rotation de clés.
- **editor** — l'éditeur de Documents (RichEditor basé TipTap) et ses modales associées (recherche/remplace, équations, mise en colonnes, fusion et publipostage, correction).
- **export** — les fonctions d'export de documents vers des formats externes.
- **format** — modèles de données et sérialisation (document interne, DOCX, paquet Elium, journal, profils, magasins de brouillons/versions/parapheur).
- **panels** — panneaux latéraux communs aux éditeurs (informations, inspecteur, sécurité, versions, commentaires, suivi des modifications, signatures, parapheur).
- **pdf** — le visualiseur/éditeur PDF (cœur de rendu, modèle, opérations dont la signature PAdES, interface).
- **sheet** — le Tableur (modèle, formules, filtres, mise en forme conditionnelle, tableaux croisés dynamiques, validation, import/export CSV).
- **sign** — la signature électronique locale (création de signature, preuve, QR code, mots de sécurité, coffre de confiance).
- **slides** — l'éditeur de Présentations (canevas, lecture, présentateur, import/export PPTX, synchronisation).
- **studio** — types partagés du Studio (le conteneur commun aux éditeurs).
- **ui** — briques d'interface génériques (dialogues, thème, polices, jetons CSS, hook d'annulation/rétablissement).
- **views** — les vues de premier niveau routées par l'application (accueil, Tableur, Présentations, Studio, Drive Cloud).

## Lancer le serveur de développement

```
npm run dev
```

Démarre Vite sur le port 3000. En développement, `/api` est proxifié en même
origine vers le serveur local `tests/dev-drive-server.ts` (par défaut
`http://127.0.0.1:8787`, surchargeable via la variable d'environnement
`DEV_API_TARGET`), ce qui inclut le relais WebSocket de co-édition chiffrée.
Cette proxification n'existe qu'en dev : elle est ignorée par `vite build`.

## Tests

Il y a quatre commandes de test distinctes, chacune couvrant un périmètre
différent :

### `npm run test`

Exécute la suite Vitest (`tests/**/*.test.{ts,tsx}` et `src/**/*.test.{ts,tsx}`) :
tests unitaires et d'intégration en logique pure (modèles, formules, crypto,
formats, réducteurs CRDT en mémoire, etc.). Aucun prérequis externe. Le
timeout par test est porté à 30 s dans `vite.config.ts` car les tests crypto
enchaînent plusieurs dérivations Argon2id (256 Mio, ~1,3 s chacune).

### `npm run test:browser`

Exécute les tests Playwright (`tests/a11y.spec.ts` et `tests/journeys.spec.ts`,
seuls fichiers sélectionnés par `playwright.config.ts`) : scan d'accessibilité
axe-core et parcours utilisateur avec un vrai navigateur (rendu, mise en page,
téléchargements de fichiers réels) — ce qu'un DOM jsdom ne peut pas fournir.
Playwright démarre lui-même `vite --port 3100 --strictPort` (`webServer` dans
la config) ; aucune action manuelle n'est nécessaire.

### `npm run test:e2e`

Exécute `tests/e2e-multiuser.ts` (via `tsx`) : test de bout en bout de la pile
Drive entreprise multi-utilisateurs, sans Docker. Démarre un vrai PostgreSQL
embarqué (`embedded-postgres`) et la vraie API Fastify, puis pilote le vrai
SDK client (`src/drive-cloud`) avec sa cryptographie (Argon2id, ECDH-ES P-256,
AES-256-GCM) sur HTTP et WebSocket, comme le feraient deux navigateurs.
Vérifie inscription/connexion zéro-connaissance, organisation, invitations,
dossiers/fichiers chiffrés, héritage des clés, partage, permissions, versions,
corbeille, liens publics, journal d'audit, co-édition temps réel chiffrée et
révocation avec rotation de clés. Le PostgreSQL embarqué est téléchargé et
démarré automatiquement par le test — aucune installation manuelle requise.
Durée approximative : 1 à 2 minutes.

### `npm run test:e2e:sheet`

Exécute `tests/e2e-collab-sheet.ts` (via `tsx`) : test de bout en bout,
sur le réseau réel, de la co-édition du Tableur — deux instances réelles
d'`EncryptedYjsProvider` (deux `Y.Doc` distincts, comme deux onglets de
navigateur) se connectent au même nœud `collab-sheet` par-dessus le vrai
relais WebSocket chiffré. Comme `test:e2e`, il démarre un vrai PostgreSQL
embarqué et la vraie API Fastify ; c'est le seul test qui vérifie que les
mises à jour Yjs du Tableur traversent réellement le réseau (chiffrement,
envoi au relais, rediffusion, déchiffrement côté pair), au-delà de la simple
fusion CRDT en mémoire déjà couverte par `tests/collab-sheet-model.test.ts`.
Même prérequis que `test:e2e` : PostgreSQL embarqué géré automatiquement.

## Lint et formatage

```
npm run lint          # ESLint sur src/ et tests/ (*.ts, *.tsx)
npm run lint:fix       # idem, avec correction automatique
npm run format         # Prettier sur src/ et tests/ (*.ts, *.tsx, *.css)
npm run format:check   # vérifie le formatage sans modifier les fichiers
```
