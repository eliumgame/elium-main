# Elium Server — Drive Cloud

Backend Fastify/TypeScript d'Elium Drive Entreprise : API zéro-connaissance
(chiffrement de bout en bout côté client, le serveur ne stocke que du
ciphertext opaque), RBAC détaillé par organisation/nœud, SSO entreprise (OIDC)
et provisioning SCIM 2.0, WebAuthn/passkeys en second facteur, relais de
collaboration temps réel (CRDT Yjs relayé en aveugle, jamais déchiffré), et
stockage de blobs chiffrés (filesystem local ou S3/MinIO).

Le serveur ne voit et ne stocke jamais de mot de passe, de clé privée ou de
contenu en clair : toute la cryptographie applicative (dérivation de clé,
chiffrement AES-256-GCM, enveloppement des clés de nœud) a lieu côté client.
Voir les commentaires d'en-tête de `src/routes/auth.ts`, `src/routes/nodes.ts`
et `src/rbac/engine.ts` pour le détail du modèle.

## Prérequis

- **Node.js** ≥ 20 (voir `engines` dans `package.json`).
- **PostgreSQL** — obligatoire. C'est le stockage de vérité (utilisateurs,
  organisations, RBAC, métadonnées de nœuds, journal d'audit, updates de
  collaboration). URL de connexion via `DATABASE_URL`.
- **Redis** — **optionnel**. Sans `REDIS_URL`, le serveur tourne en
  mono-instance et dégrade proprement : le relais de collaboration, le canal
  d'événements d'organisation et le compteur de rate-limit vivent en mémoire
  du process (comportement historique, aucune fonctionnalité perdue en
  mono-instance). Avec `REDIS_URL` renseigné, un backplane pub/sub Redis
  propage broadcast/kick/notifyOrg à toutes les instances et rend le
  rate-limit partagé — nécessaire uniquement pour un déploiement
  multi-instance. Voir `src/collab/backplane.ts`.
- Un backend de stockage de blobs : système de fichiers local (`fs`, par
  défaut) ou un service compatible S3 comme MinIO (`s3`).

## Variables d'environnement

Copier `.env.example` vers `.env` et ajuster. En production, ces variables
sont normalement injectées par docker-compose / le script d'installation.

| Variable | Rôle |
| --- | --- |
| `PORT`, `HOST` | Adresse d'écoute HTTP du serveur. |
| `CORS_ORIGINS` | Liste (séparée par des virgules) des origines web autorisées (l'app web-studio). |
| `DATABASE_URL` | URL de connexion PostgreSQL. |
| `TOKEN_SECRET` | Secret HMAC-SHA256 de signature des access tokens. Doit être long et aléatoire en production (≥ 32 caractères, et rejeté si une valeur d'exemple type `change-me` est détectée). |
| `ACCESS_TOKEN_TTL_SECONDS`, `REFRESH_TOKEN_TTL_SECONDS` | Durées de vie des access/refresh tokens. |
| `STORAGE_DRIVER` | `fs` (volume local) ou `s3` (MinIO / S3-compatible). |
| `STORAGE_FS_ROOT` | Racine du volume local quand `STORAGE_DRIVER=fs`. |
| `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_FORCE_PATH_STYLE` | Configuration S3/MinIO quand `STORAGE_DRIVER=s3`. |
| `MAX_BLOB_BYTES` | Taille maximale d'un blob de contenu (upload de fichier chiffré). |
| `MAX_JSON_BYTES` | Taille maximale d'un corps de requête JSON. |

> **Note** : `src/config.ts` lit aussi d'autres variables, documentées
> directement en commentaire dans `.env.example` (avec leur valeur par
> défaut) plutôt que dans le tableau ci-dessus — `REDIS_URL`, `WEBAUTHN_RP_ID`,
> `WEBAUTHN_RP_NAME`, `MAX_SIGN_ARTIFACT_BYTES`, les plafonds
> `MAX_COLLAB_MESSAGE_BYTES` / `MAX_COLLAB_MESSAGES_PER_SEC` /
> `MAX_COLLAB_CONNECTIONS_PER_USER`, `NODE_ENV`, `RUN_MIGRATIONS`,
> `TRUST_PROXY` et `ELIUM_VERSION`. La plupart sont optionnelles avec une
> valeur par défaut raisonnable en développement ; se référer à `.env.example`
> pour savoir laquelle doit vraiment être définie en production.

## Migrations

Les migrations SQL versionnées vivent dans `src/db/migrations/` et sont
appliquées dans l'ordre du nom de fichier, chacune une seule fois (suivi dans
la table `schema_migrations`). Le runner est idempotent — sûr à relancer à
chaque déploiement/démarrage de conteneur.

```
npm run migrate
```

Le serveur applique aussi les migrations automatiquement à chaque démarrage
(`npm run dev` / `npm start`), sauf si `RUN_MIGRATIONS=false`.

## Lancer le serveur en développement

```
npm install
cp .env.example .env   # puis ajuster DATABASE_URL, TOKEN_SECRET, etc.
npm run migrate
npm run dev
```

`npm run dev` (tsx en mode watch) démarre `src/server.ts`, qui construit
l'app Fastify, écoute sur `PORT`/`HOST`, et lance un ménage périodique des
tables éphémères (défis d'authentification, sessions expirées, invitations
expirées).

Autres scripts utiles : `npm run build` (compilation TypeScript vers
`dist/`), `npm start` (lance le build compilé), `npm run typecheck`,
`npm run lint` / `lint:fix`, `npm run format` / `format:check`.

## Tests

```
npm test          # vitest run — suite complète, une seule passe
npm run test:watch
```

Les fichiers de test vivent dans `server/tests/` (un fichier par domaine :
auth, RBAC, groupes, partages, signature, SCIM, SSO/OIDC, WebAuthn, stockage,
housekeeping, chaîne d'audit, etc.), pas à côté des fichiers source.

## Structure du code (`src/`)

- **`collab/`** — relais de collaboration temps réel : le serveur reste un
  relais aveugle (il ne décode ni ne déchiffre jamais les updates Yjs), fait
  respecter le RBAC à l'entrée d'une salle, et journalise les updates dans
  Postgres pour le rattrapage des retardataires ; le backplane Redis optionnel
  y ajoute le fan-out multi-instance.
- **`db/`** — accès PostgreSQL : pool de connexions, helper de requêtes
  paramétrées, wrapper de transactions, et le runner de migrations
  versionnées (`migrations/*.sql`).
- **`lib/`** — utilitaires transverses sans route propre : cryptographie
  serveur minimale, tokens d'accès/rafraîchissement, TOTP, WebAuthn, OIDC,
  journal d'audit chaîné et infalsifiable, purge périodique des tables
  éphémères, suppression de compte RGPD, et erreurs HTTP typées (`errors.ts`).
- **`middleware/`** — authentification (qui es-tu, via l'access token) et
  helpers d'autorisation (`requireOrgPerm`, `requireNodePerm`, ...) appelés
  dans les routes une fois l'identité et la ressource connues.
- **`rbac/`** — moteur RBAC : catalogue des permissions granulaires, modèles
  de rôles système clonés par organisation, et résolution des permissions
  effectives d'un utilisateur sur une organisation ou un nœud.
- **`routes/`** — tous les endpoints HTTP de l'API, un module par domaine
  (voir détail ci-dessous).
- **`storage/`** — abstraction de stockage de blobs chiffrés (le serveur ne
  voit jamais de contenu en clair), avec un driver filesystem et un driver
  S3/MinIO interchangeables.

## Structure des routes (`src/routes/`)

Toutes montées par `src/app.ts` sous des préfixes `/api/...` :

- **`auth.ts`** — inscription/connexion zéro-connaissance par défi-réponse
  Ed25519 (aucun équivalent de mot de passe ne transite), rafraîchissement et
  révocation de session, second facteur (TOTP/WebAuthn).
- **`users.ts`** — annuaire des utilisateurs (identité publique uniquement)
  et self-service `/me` (changement de mot de passe côté client).
- **`orgs.ts`** — création d'organisation, adhésion, invitations, paramètres,
  et récupération d'entreprise (clé de récupération enveloppée).
- **`roles.ts`** — catalogue des permissions et gestion des rôles RBAC par
  organisation (clonage des rôles système, rôles personnalisés).
- **`groups.ts`** — groupes/équipes en tant que principaux cryptographiques
  (paire de clés de groupe, partage de clé wrappée à chaque membre).
- **`audit.ts`** — lecture paginée et vérification du journal d'audit
  chaîné d'une organisation.
- **`nodes.ts`** — l'arborescence du Drive (dossiers/fichiers) : métadonnées
  et contenu restent chiffrés côté serveur, qui ne fait qu'autoriser et
  stocker.
- **`shares.ts`** — partage interne (ACL par clé de nœud wrappée) et liens de
  partage externes publics (secret dans le fragment d'URL, jamais côté
  serveur).
- **`signing.ts`** — signature à distance par lien cloud : création d'une
  demande de signature et écriture-retour publique (scellée par token) de
  l'artefact signé.
- **`versions.ts`** — historique des versions d'un nœud : liste, téléchargement
  d'une version passée, restauration.
- **`sso.ts`** — SSO entreprise (OIDC) et gestion des tokens SCIM ; authentifie
  l'identité, ne déverrouille jamais les clés de contenu.
- **`scim.ts`** — provisioning SCIM 2.0 (RFC 7644) des utilisateurs et groupes,
  scoped par le token bearer SCIM d'une organisation.
