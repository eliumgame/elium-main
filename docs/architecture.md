# Architecture du dépôt Elium

> Document destiné aux **contributeurs** du dépôt : comment les sous-projets
> s'articulent, comment la parité Python↔TypeScript du format `.elium` est
> garantie, et le schéma de données du Drive Cloud. Pour la documentation
> **utilisateur final** (celle affichée dans l'application), voir
> `web-studio/src/docs/documentation.ts` — ce fichier-ci ne la duplique pas.

## 1. Vue d'ensemble des cinq sous-projets

Le dépôt regroupe cinq sous-projets. Quatre sont actifs et livrés ; le
cinquième (`desktop/`) est un legacy conservé pour référence historique (voir
§4).

- **`src/elium/`** — cœur Python : CLI (`src/elium/cli/`), lecture/écriture du
  format conteneur `.elium` (`src/elium/format/`, et lecture du conteneur
  legacy v3 via `src/elium/core/`), primitives crypto (`src/elium/crypto/` —
  Argon2id, AES-256-GCM/ChaCha20-Poly1305, Ed25519). C'est la référence
  « source de vérité » du format : tout ce que `web-studio/` sait produire ou
  lire doit rester byte-compatible avec ce que ce cœur produit ou lit.
- **`web-studio/`** — client React/Vite/TypeScript. Contient les éditeurs
  (Documents, Tableur, Présentations, PDF) et le client du Drive Cloud
  (collaboration temps réel, chiffrement de bout en bout côté navigateur). Il
  embarque sa **propre** réimplémentation TypeScript du format `.elium`
  (`web-studio/src/format/`) : en usage local (pas de Drive Cloud), l'éditeur
  lit/écrit des fichiers `.elium` entièrement côté navigateur, sans jamais
  appeler `server/`.
- **`server/`** — backend Drive Cloud en Fastify/TypeScript : RBAC, SSO/SCIM,
  WebAuthn, relais de collaboration temps réel (Yjs), stockage de blobs
  chiffrés en Postgres. `web-studio/` lui parle en **HTTP** (REST, via
  `web-studio/src/drive-cloud/api.ts`) pour les opérations CRUD/RBAC/partage,
  et en **WebSocket** (`server/src/collab/relay.ts` + `backplane.ts`) pour la
  co-édition temps réel des documents ouverts à plusieurs. Le serveur est
  zéro-connaissance : il ne voit jamais que du ciphertext, des clés
  enveloppées et des métadonnées d'autorisation.
- **`installer/`** — packaging Windows : exécutable PyInstaller
  (`elium_launcher.py`) et paquet MSI (WiX, `elium.wxs`), avec auto-mise à
  jour signée Ed25519. Construit l'app livrée à partir de `web-studio/` (build
  statique embarqué) et de `src/elium/` (cœur Python embarqué), pas depuis
  `desktop/`.
- **`desktop/`** — legacy, voir §4.

Schéma textuel des communications :

```
                     ┌────────────────────────┐
                     │        server/          │
                     │  Fastify + Postgres      │
                     │  RBAC, SSO/SCIM, WebAuthn │
                     │  relais collab (Yjs)      │
                     └───────────▲────────▲─────┘
                        HTTP REST │        │ WebSocket (collab temps réel)
                                  │        │
                     ┌────────────┴────────┴─────┐
                     │        web-studio/          │
                     │  React/Vite/TS               │
                     │  éditeurs Documents/Tableur/  │
                     │  Présentations/PDF            │
                     │  + client Drive Cloud          │
                     │  + format/ (TS, autonome)       │
                     └───────────┬─────────────────┘
                                  │ fichier .elium (ZIP/OPC)
                                  │ lu/écrit indépendamment
                                  │ par chaque implémentation
                     ┌────────────▼─────────────┐
                     │        src/elium/          │
                     │  cœur Python : CLI, format/, │
                     │  core/, crypto/               │
                     └───────────────────────────┘
```

Point clé : `web-studio/` et `src/elium/` ne communiquent **jamais**
directement entre eux au runtime — ils ne partagent ni processus, ni appel
réseau. Le seul point de contact est le **fichier `.elium`** lui-même (et son
format canonique de hachage) : chaque implémentation le produit et le
consomme indépendamment, et leur accord est vérifié par des tests croisés
(§2), pas par une dépendance de code partagée.

## 2. Parité Python ↔ TypeScript du format `.elium`

Le format `.elium` doit produire des hachages et des signatures identiques
que le fichier soit écrit par le cœur Python (`src/elium/format/`) ou par
`web-studio/src/format/`. Cette parité repose sur un point unique : une
sérialisation JSON canonique implémentée en double, une fois par langage.

- **`src/elium/format/canonical.py`** ↔ **`web-studio/src/format/canonical.ts`**
  définissent tous les deux `canonicalJSON`/`canonical_json` : clés d'objet
  triées récursivement, aucun espace superflu, encodage UTF-8, rejet explicite
  des nombres non finis (NaN/Infinity) des deux côtés — pour qu'une valeur non
  sérialisable de façon canonique lève une erreur plutôt que de corrompre
  silencieusement un hachage de sceau ou de journal. `hash_canonical` /
  `hashCanonical` appliquent SHA-256 à cette forme canonique.
- Cette même primitive est réutilisée par tous les mécanismes d'intégrité du
  format :
  - **`journal.py` ↔ `journal.ts`** — journal de suivi chaîné par hachage
    (`event.hash = sha256(prevHash + canonical_json(payload))`).
  - **`seal.py` ↔ `web-studio/src/sign/seal.ts`** — sceau Ed25519 unique qui
    authentifie l'ensemble manifeste/signatures/journal.
  - **`proof.py` ↔ `web-studio/src/sign/proof.ts`** — preuve de signature
    Ed25519 sur un message canonique.
  - **`package.py` ↔ `web-studio/src/format/elium-package.ts`** — lecture/
    écriture du conteneur ZIP/OPC lui-même.
  - **`document.py` ↔ `web-studio/src/format/document.ts`** et
    **`profiles.py` ↔ `web-studio/src/format/profiles.ts`** miroitent le
    modèle de document et les profils de protection (chiffré/verrouillé/
    tracking/signatures attendues).

La parité n'est pas seulement une convention de code : elle est **vérifiée
par des tests d'interopérabilité croisés** qui font tourner les deux
implémentations l'une contre l'autre :

- `web-studio/tests/interop_v4.test.ts` et `web-studio/tests/interop_seal.test.ts`
  invoquent un exécutable Python (`tests/python/interop_helper.py`, via un
  `.venv` local ou `python3`/`python` sur le `PATH`) depuis Vitest :
  un fichier `.elium` écrit par Python est relu et vérifié côté TS, et
  inversement un fichier écrit côté TS est relu et vérifié par le helper
  Python. Ces tests sont ignorés (`describe.skipIf`) si aucun interpréteur
  Python n'est disponible (par ex. certains environnements CI) — l'absence de
  Python fait sauter le test plutôt que le faire échouer silencieusement.
- `web-studio/tests/canonical.test.ts` et `web-studio/tests/seal.test.ts`
  couvrent chaque implémentation isolément ; `tests/python/test_canonical.py`
  et `tests/python/test_journal.py` couvrent le côté Python.

En pratique : toute modification de `canonical.py`/`canonical.ts` (ou de tout
module qui en dépend pour le hachage) doit être répercutée **des deux côtés à
l'identique**, sous peine de casser silencieusement l'interopérabilité — les
tests d'interop ci-dessus sont le filet de sécurité à faire tourner en
premier.

## 3. Schéma de données Drive Cloud

Le Drive Cloud est stocké en Postgres par `server/`, en cinq migrations
(`server/src/db/migrations/`), toutes idempotentes (`CREATE ... IF NOT
EXISTS` / `ADD COLUMN IF NOT EXISTS`) :

1. **`0001_baseline.sql`** — schéma zéro-connaissance de base : utilisateurs
   (clés publiques Ed25519 + P-256, `key_bundle` chiffré côté client),
   organisations, nœuds (fichiers/dossiers, contenu en `*_encrypted`/
   `*_nonce`), rôles/permissions RBAC, liens de partage — le serveur ne
   stocke jamais de texte en clair, de mot de passe ni de clé privée.
2. **`0002_scim_groups.sql`** — groupes SCIM provisionnés par un IdP externe :
   métadonnées et appartenance uniquement (pas de clé de groupe
   cryptographique, distinct des « teams »), avec un mapping optionnel vers un
   rôle Elium ; l'appartenance est indexée par email pour survivre à la
   transition invité → utilisateur réel.
3. **`0003_org_key_epoch.sql`** — compteur `org_key_epoch` sur les
   organisations, pour détecter une rotation de clé d'organisation
   interrompue/partielle et garantir une vérification de concurrence
   optimiste lors du remplacement de la paire de clés de recouvrement.
4. **`0004_signature_requests.sql`** — circuit de signature à distance par
   lien cloud (Approche A, Tranche 0) : capacité `can_sign` sur les liens de
   partage et table `signature_requests` pour les demandes de signature
   portant sur un nœud, avec écriture-retour anonyme scellée par token.
5. **`0005_backfill_sign_request_perm.sql`** — rétro-propagation de la
   permission `node.sign.request` aux rôles déjà clonés dans des
   organisations existantes (le seed des rôles globaux ne met à jour que le
   patron des nouvelles organisations, pas celles déjà créées).

## 4. Statut de `desktop/` — legacy, une fois pour toutes

`desktop/src/app.py` est une **ancienne application de bureau PySide6**
(fenêtre Qt native avec onglets, ~500 lignes), antérieure à l'architecture
actuelle. Elle est :

- **legacy et non maintenue** : elle n'est plus mise à jour en parallèle des
  fonctionnalités du format `.elium` ou du Drive Cloud ;
- **non testée** : aucun test automatisé ne la couvre ;
- **exclue du pipeline de release réel** : c'est `installer/build.bat` +
  `elium.spec` (ce que `.github/workflows/release.yml` exécute) qui construit
  l'application effectivement livrée aux utilisateurs finaux à partir de
  `web-studio/` (build statique) et de `src/elium/` (cœur Python embarqué) —
  ce pipeline exclut explicitement `desktop/`. Les scripts racine
  `Elium.wizard.bat`, `dev.bat` et `build_exe.bat` ont été réalignés sur ce
  même flux (ils ne lancent/ne construisent plus l'ancienne app PySide6) ;
  `build_exe.bat` délègue désormais à `installer/build.bat`.

Conséquence pratique pour un contributeur : ne jamais se fier au code de
`desktop/` pour comprendre le comportement de l'application distribuée, ni
pour évaluer l'état d'une fonctionnalité. Le vrai client est `web-studio/`,
packagé par `installer/`. Ce paragraphe est la référence à citer partout
ailleurs dans le dépôt (issues, revues, autres docs) plutôt que de reformuler
le statut de `desktop/` à chaque fois.
