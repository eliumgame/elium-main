<!--
  DOCUMENTATION UNIQUE ET DE RÉFÉRENCE D'ELIUM.
  Ce fichier remplace et consolide les anciens documents dispersés (rapports
  d'état, SPEC, THREAT_MODEL, SIGNATURE_MODEL, guides, roadmaps, INSTALL…).
  C'est LA source de vérité. Toute mise à jour de doc se fait ici.
-->

# Elium — Documentation complète

> **Document unique de référence.** Il couvre tout : présentation, installation
> (VPS et PC local), fonctionnalités des deux plateformes, format `.elium`,
> sécurité & cryptographie, exploitation, état d'avancement (fait / reste / à
> améliorer) et feuille de route.
>
> **Vérifié à la dernière mise à jour (2026-07-15)** : E2E multi-utilisateurs
> **87/87** (désormais gaté en CI, job `server-e2e`) · vitest **204/204** ·
> pytest **66/66** · typecheck + builds verts · MSI de bureau à jour.

---

## Table des matières

1. [Vue d'ensemble](#1-vue-densemble)
2. [Installation](#2-installation)
3. [La suite bureautique locale](#3-la-suite-bureautique-locale)
4. [Le Drive entreprise](#4-le-drive-entreprise)
5. [Le format `.elium`](#5-le-format-elium)
6. [Sécurité & cryptographie](#6-sécurité--cryptographie)
7. [Signatures — Elium Sign](#7-signatures--elium-sign)
8. [Modèle de menace](#8-modèle-de-menace)
9. [Historique d'audit de sécurité](#9-historique-daudit-de-sécurité)
10. [Exploitation (VPS)](#10-exploitation-vps)
11. [État : fait / reste / à améliorer](#11-état--fait--reste--à-améliorer)
12. [Feuille de route](#12-feuille-de-route)
13. [Guide développeur](#13-guide-développeur)
14. [Confidentialité / RGPD](#14-confidentialité--rgpd)
15. [Annexes](#15-annexes)

---

## 1. Vue d'ensemble

Elium, c'est **deux produits** qui partagent le format `.elium` et la même
cryptographie éprouvée :

| Produit | Ce que c'est | Où ça tourne |
|---|---|---|
| **Suite bureautique** | Documents, Tableur, Présentations, PDF, Drive local, Parapheur — 100 % hors-ligne, chiffré/signé par document | Le **PC** de l'utilisateur (MSI Windows ou navigateur) |
| **Drive entreprise** | Plateforme web multi-utilisateurs, zéro-connaissance, partage, co-édition temps réel | Un **serveur** que vous hébergez (VPS Linux, ou PC via Docker) |

**Positionnement** : une alternative chiffrée de bout en bout à Google
Workspace / Microsoft 365, où le serveur ne voit **jamais** le contenu en clair.

```
   SUITE LOCALE (PC)                     DRIVE ENTREPRISE (serveur auto-hébergé)
 ┌────────────────────┐   HTTPS  /api   ┌──────────────────────────────────────────────┐
 │  Elium.exe (MSI)   │───────────────► │   Caddy(TLS) ─► web (SPA) + api (Fastify)     │
 │  ou navigateur     │◄─────────────── │      api ─► Postgres (méta + clés emballées)  │
 │  Documents·Tableur │   (chiffré)     │          └► blobs (contenu chiffré : fs/S3)    │
 │  Présentations·PDF │                 └──────────────────────────────────────────────┘
 └────────────────────┘                   Zéro-connaissance : jamais de clair côté serveur.
     100 % local
```

> **À comprendre d'emblée** : l'application de bureau **n'embarque aucun
> serveur** (c'est la suite *locale*). Le **Drive entreprise** est un service
> que **vous hébergez** et auquel l'app se connecte via son URL (bouton
> « Serveur » de l'écran de connexion). Sans serveur configuré, le Drive affiche
> « Serveur Drive injoignable » — voir [§2](#2-installation).

---

## 2. Installation

**Le plus simple : un seul fichier, `install.sh`**, à la racine du dépôt.

```bash
bash install.sh                                   # menu interactif
bash install.sh drive --domain drive.exemple.fr   # Drive entreprise (VPS, HTTPS auto)
bash install.sh drive --local                     # Drive en local (http://localhost)
bash install.sh suite                             # suite bureautique dans le navigateur
bash install.sh update | status | backup          # exploitation
```

Options de `drive` : `--domain <fqdn>` · `--local` · `--email <acme>` ·
`--storage fs|s3` · `--quota-gb <n>` · `--port <n>` · `--yes` · `--dry-run`.

> Sous **Windows**, lancez `install.sh` via **Git Bash** ou **WSL**. Pour la
> seule suite bureautique, préférez le **MSI** (§2.1).

### 2.1 Suite bureautique sur un PC
- **Windows (recommandé)** : double-cliquez **`Elium-4.0.0-Setup.msi`**
  (dossier `Téléchargements`, ou `installer/output/` après un build). Tout
  fonctionne **hors-ligne**, sans compte. L'exe autonome `Elium.exe` fonctionne
  aussi sans installation.
- **Tout OS (navigateur)** : `bash install.sh suite` → `http://localhost:3100`.
- **Reconstruire le MSI** : `installer/build.bat` (exe PyInstaller) puis
  `installer/build_msi.bat /nopause` (MSI WiX) → `installer/output/`.
- **Mises à jour** : une fois installée, l'app se met à jour **automatiquement**
  depuis les GitHub Releases — voir §2.6.

### 2.2 Drive entreprise sur un VPS (production)
1. **DNS** : un enregistrement **A/AAAA** `drive.exemple.fr` → IP du VPS. Le
   domaine **doit** résoudre avant le lancement (`dig +short drive.exemple.fr`).
2. **Docker** : `curl -fsSL https://get.docker.com | sh` puis
   `sudo usermod -aG docker "$USER" && newgrp docker`.
3. **Code** : `git clone … && cd elium-main`.
4. **Config + lancement** :
   ```bash
   bash install.sh drive --domain drive.exemple.fr --email vous@exemple.fr
   ```
   Le script génère `TOKEN_SECRET` + mot de passe Postgres, écrit `.env`
   (droits `600`), construit et démarre la pile Docker, puis attend
   `/api/health`. **Migrations automatiques** (schéma + rôles système),
   idempotentes. Vérifier : `curl https://drive.exemple.fr/api/health`.
   > Re-lancer `install.sh` est **sûr** : il **préserve** les secrets existants
   > (ne régénère jamais `TOKEN_SECRET` ni le mot de passe DB — les régénérer
   > invaliderait sessions et secrets MFA).
5. **Premier compte** = **propriétaire**. Créez votre **organisation** (vous
   obtenez la clé de recouvrement). Invitez des membres, créez des équipes,
   ajustez rôles & permissions.
6. **2FA** : onglet **Sécurité** → activer → scanner le QR → sauvegarder les
   codes de secours.
7. **App de bureau → Drive** : carte Drive → bouton **« Serveur »** →
   `https://drive.exemple.fr/api` → Enregistrer.

### 2.3 Drive en local (test)
```bash
bash install.sh drive --local          # http://localhost (ou --port 8080)
```

### 2.4 Services de la pile Drive
| Service | Rôle | Exposition |
|---|---|---|
| `caddy` | Reverse-proxy TLS, sert l'app + `/api/*` (dont WebSocket) | 80/443 |
| `web`   | App web (build Vite statique) | interne |
| `api`   | API Fastify + relais de co-édition chiffré | 8787 (interne) |
| `db`    | Postgres 16 (métadonnées + clés emballées, chiffré) | interne |
| `minio` | Stockage objet S3 optionnel (profil `s3`) | 9000/9001 |

Volumes persistants : `pgdata`, `blobs`, `caddy_data`, `caddy_config`.

### 2.5 Dépannage rapide
- **« Serveur Drive injoignable » / « Not Found »** : aucun serveur configuré →
  bouton **Serveur** → URL de l'API (`https://votre-domaine/api`). L'app de
  bureau n'embarque pas de backend.
- **TLS ne se génère pas** : le domaine doit résoudre vers le VPS ; ports 80/443
  ouverts (Let's Encrypt valide via le port 80). `docker compose logs caddy`.
- **CORS** : `CORS_ORIGINS` (dans `.env`) doit contenir exactement l'origine
  d'accès. `install.sh` la règle ; sinon éditez puis `bash install.sh update`.
- **Collab ne synchronise pas** : WebSocket sur `/api/collab/*` (proxifié par
  Caddy) ; si un autre proxy est devant, activez le passage des connexions
  `Upgrade`.
- **API ne démarre pas** : souvent `TOKEN_SECRET` absent (l'API refuse de
  démarrer en prod sans secret ≥ 32 car.). `docker compose logs api`.

### 2.6 Mises à jour automatiques (application de bureau)

L'app de bureau Windows se met à jour **toute seule** depuis les GitHub Releases,
sans intervention et sans invite UAC. **Modèle « push = publication »** : chaque push
sur `master` (hors docs) publie automatiquement une nouvelle version ; les apps
installées la récupèrent et l'appliquent. Aucun tag manuel.

**Publier une version (mainteneur)** : `git push origin master`. C'est tout.
`.github/workflows/release.yml` (runner `windows-latest`) calcule la version
(`majeur.mineur` de `src/elium/__init__.py` + numéro de run), stampe version + `codeHash`,
build le Web Studio, produit `Elium.exe` (PyInstaller), le MSI (WiX, best-effort), le
paquet `web.zip`, **signe** `latest.json` (Ed25519) et crée la GitHub Release `vX.Y.Z`.

**Setup unique (2 actions, une fois pour toutes)** :
1. **Repo PUBLIC** — sinon les assets de Release ne sont pas téléchargeables par les
   utilisateurs (un repo privé exige une authentification que l'app n'a pas). Le code
   d'Elium peut être public sans risque : la sécurité est *zero-knowledge*, elle ne
   dépend pas du secret du code.
2. **Secret `UPDATE_SIGNING_KEY`** — clé privée Ed25519 (`scripts/gen_update_keypair.py`
   → fichier local `update-private-key.hex`) dans *Settings ▸ Secrets ▸ Actions*. La clé
   publique correspondante est embarquée dans `installer/updater.py`. Ne jamais committer
   la clé privée (couverte par `.gitignore`). Tant que ce secret est absent, `release.yml`
   s'exécute mais **ne publie pas** (run vert, sans échec).

**Côté client** (`installer/updater.py`, embarqué dans l'exe) : au lancement puis
périodiquement, l'app **détecte** une màj (télécharge `latest.json` + `.sig`, **vérifie
la signature** avec la clé publique embarquée, compare les versions) — **sans rien
télécharger**. Si une màj existe, une **carte discrète avec un seul bouton** apparaît
(« Mettre à jour »). Au clic : téléchargement avec **barre de progression animée**
(endpoints `/__update__`, `POST /__update__/start`), puis :
- **màj web** (cas courant) : `web.zip` vérifié (sha256 du manifeste signé) est déposé
  dans `%LOCALAPPDATA%\Elium\web\<version>\` ; la carte propose **« Recharger »** (un
  clic applique la nouvelle interface). Léger, sans admin.
- **màj exe** (le lanceur/Python a changé, détecté via `codeHash`) : le nouvel
  `Elium.exe` vérifié est déposé dans `%LOCALAPPDATA%\Elium\bin\` ; la carte propose
  **« Redémarrer Elium »** (`POST /__update__/restart` ferme la fenêtre et relance le
  nouvel exe — handoff). Sinon appliqué au prochain démarrage. Aucun UAC, rien dans
  `Program Files`. UI servie en CSS/JS externes (CSP-safe), aucun style/script inline.

Le MSI reste l'installeur canonique pour une **install fraîche** ; l'auto-update
maintient à jour entre deux MSI. Journal : `%LOCALAPPDATA%\Elium\update.log`.
Désactiver : variable d'environnement `ELIUM_NO_UPDATE=1`.

**Rotation de la clé de signature** : publier d'abord une version *transitoire* qui
embarque la **nouvelle** clé publique (signée avec l'**ancienne** clé, donc acceptée
par le parc actuel) ; une fois cette version largement déployée, basculer le secret
`UPDATE_SIGNING_KEY` vers la nouvelle clé privée pour les releases suivantes.

**Sécurité** : le serveur/CDN n'est jamais une racine de confiance — une màj n'est
appliquée que si la signature Ed25519 du manifeste **et** le sha256 de l'artefact sont
valides ; sinon l'artefact est jeté et l'app reste sur sa version courante. (La
signature Authenticode du binaire — qui supprime l'avertissement SmartScreen — n'est
pas incluse ; elle est orthogonale et peut s'ajouter avec un certificat de code.)

---

## 3. La suite bureautique locale

### 3.1 Documents (éditeur de texte riche)
Moteur TipTap v3 / ProseMirror. Titres, listes (puces/numérotées/tâches),
citations, blocs de code coloriés, tableaux, images avec habillage (`float`) et
redimensionnement, alignements, surlignage, interligne, indentation, table des
matières auto, commentaires, notes de bas de page, signets, styles de paragraphe
nommés, **suivi des modifications** (mode suggestion). Recherche/remplacement
complet (regex, casse, tout remplacer). **Import/export DOCX** sans dépendance.
Export HTML/Markdown/PDF. Modèle de page (A4/Letter, marges, en-tête/pied,
numérotation) appliqué à l'écran, à l'impression et au DOCX.

### 3.2 Tableur
Moteur de formules `tokenize → parse (AST) → evaluate`, ~59 fonctions,
`IFERROR`/`IFNA`, références absolues `$A$1` et **inter-feuilles** `Feuille2!A1`
(renommage propagé, détection de cycle). Poignée de remplissage (séries), tri
non destructif, mise en forme conditionnelle, gel de volets, undo/redo,
graphiques. Import XLSX/CSV.

### 3.3 Présentations
Modèle **canvas libre** : chaque diapo = liste d'éléments (texte riche / forme /
image) positionnés en %, avec **rotation, ordre de plan, opacité**. Éditeur :
sélection, déplacement, redimensionnement 8 poignées, rotation à la poignée,
**guides magnétiques**, 13 formes, alignement, dupliquer, undo/redo, notes de
l'orateur, vraies miniatures. **Mode présentateur** avec transitions (Fondu /
Glissement / Zoom / Morph). **Export PPTX** (paquet OPC, runs riches, géométries
natives).

### 3.4 PDF
Vrai éditeur (pdf.js + pdf-lib). Persistance `.elium` complète (pages,
annotations, éditions de texte, polices), rotation de pages correcte à l'export,
mode « Modifier le texte » (recouvrement + réécriture), undo/redo, registre de
polices partagé.

### 3.5 Drive local & Parapheur
**Drive local** : bibliothèque de documents `.elium` en IndexedDB, **coffre
local** optionnel chiffré (mot de passe d'application séparé, `format/vault-store.ts`),
purge exhaustive « Effacer les données locales ». **Parapheur** : circuit de
signature déclaratif local (suivi des statuts).

---

## 4. Le Drive entreprise

### 4.1 Backend (Node/TS Fastify + PostgreSQL)
- **Zéro-connaissance** : ne stocke que du chiffré (contenu, noms de fichiers,
  clés emballées) et des métadonnées d'autorisation. Jamais de mot de passe, de
  clé privée ni de contenu en clair.
- **Schéma** : utilisateurs, organisations, clés de recouvrement d'org, rôles,
  adhésions, groupes (clé P-256 par équipe), nœuds (arbre dossiers + fichiers),
  **node_keys (ACL cryptographique)**, versions, liens de partage, updates de
  collaboration, invitations, sessions, défis de connexion, codes de secours
  MFA, journal d'audit. Migrations idempotentes au démarrage.
- **RBAC** : catalogue de 35+ permissions, 7 rôles système clonés par org,
  rôles personnalisés = n'importe quel sous-ensemble. Résolution = rôle d'org ∪
  rôles de groupes ∪ ACL héritée des dossiers parents + droits du propriétaire.
  Le propriétaire d'organisation dispose des pleines permissions sur tout nœud
  de l'org (il détient la clé de recouvrement).
- **Stockage** : driver `fs` (volume, LUKS recommandé) **ou `s3`/MinIO**,
  upload/download **en streaming** (sans bufferisation).

### 4.2 Authentification (zéro-connaissance, sans oracle)
- Le mot de passe ne quitte **jamais** le navigateur. Argon2id (t=3, m=256 MiB,
  p=4) → HKDF dérive : une clé **Ed25519** d'authentification (seule sa clé
  **publique** est enregistrée) et une **clé maître** (jamais transmise) qui
  chiffre le bundle de clés privées côté serveur.
- **Login = défi-réponse** : `/auth/login/init` émet un défi aléatoire à usage
  unique, le client le **signe** (Ed25519), `/auth/login/verify` vérifie la
  signature. Aucun équivalent-mot-de-passe ne transite → pas d'oracle de login.
- **MFA (TOTP)** : `/auth/login/verify` renvoie un jeton court si le MFA est
  actif ; le bundle de clés n'est livré qu'après `/auth/login/mfa`.

### 4.3 Client (SDK + UI)
- SDK chiffré typé (refresh auto), cryptographie par nœud, providers de
  co-édition.
- UI : auth split-hero + **onboarding par lien d'invitation**, explorateur
  chiffré, **partage** (membre / équipe / lien externe), **éditeur de rôles &
  permissions**, membres, équipes, versions, corbeille, journal d'audit, page
  publique d'ouverture de liens, **onglet Sécurité (2FA)**.
- **Co-édition temps réel chiffrée** (Documents, Tableur, Présentations) : CRDT
  Yjs, curseurs colorés, présence ; le relais ne voit que du chiffré.

### 4.4 Recouvrement entreprise
Couple de clés d'organisation ; la privée est emballée vers chaque admin (jamais
détenue par le serveur). Un admin peut restaurer l'accès à un nœud pour un membre.

### 4.5 SSO (OIDC) & SCIM — en restant zéro-connaissance
- **SSO (OIDC)** : le serveur vérifie un **jeton d'identité** signé par l'IdP
  (RS256/ES256/EdDSA contre le JWKS configuré par org : issuer, clientId, clés
  publiques, domaines autorisés), puis ouvre une session pour le membre
  correspondant. **Point crucial** : le SSO authentifie l'**identité** ; il ne
  déverrouille **pas** les clés E2E — le client dérive toujours sa clé maître
  d'une **phrase de passe** que le serveur ne voit jamais, et s'en sert pour
  ouvrir le bundle renvoyé. Une org peut donc imposer le SSO tout en restant
  zéro-connaissance (comme Bitwarden/Proton : SSO + phrase de passe de coffre).
  Endpoint public `POST /auth/sso/verify`.
- **SCIM 2.0** : provisioning/**déprovisioning** par jeton SCIM d'organisation
  (`/scim/v2/Users` : list/get, POST=invitation, PATCH `active`, DELETE). Le
  déprovisioning suspend l'adhésion → **perte immédiate de tout accès** (SSO et
  session existante). SCIM ne peut pas créer de clés E2E (générées côté client) :
  un POST crée donc une **invitation** que la personne complète en s'inscrivant.

---

## 5. Le format `.elium`

**Statut : v4** — format documentaire. La v3 (conteneur binaire chiffré
mono-fichier) reste lisible en mode *hérité* et sert de **primitive de
chiffrement** à la v4.

### 5.1 Structure de l'archive (ZIP style OPC)
```
document.elium (ZIP)
├── mimetype                    "application/x-elium"  (stocké, non compressé, 1ʳᵉ entrée)
├── manifest.json               manifeste (TOUJOURS en clair)
├── content/document.json       corps (profils non chiffrés)      ── ou ──
├── content/document.elium      corps chiffré (conteneur v3)      (profils chiffrés)
├── signatures/signatures.json  signatures visuelles + preuves cryptographiques
├── tracking/journal.json       journal d'évènements chaîné par hash
├── resources/index.json + resources/<sha256>   ressources adressées par contenu
└── meta/rgpd.json              métadonnées RGPD
```
Détection : v4 commence par `PK\x03\x04` (ZIP) ; v3 hérité par `ELIUM\x03`. Pour
les profils chiffrés, **seul le corps** est chiffré ; le manifeste, le journal
et la liste des signatures restent lisibles par conception (sauf option F-7,
§6.4).

### 5.2 Manifeste, intégrité, sceau
Le manifeste (`format`, `formatVersion:4`, `profile`, `title`, dates,
`protection{…}`, `integrity{algorithm, contentHash}`, `features`, `rgpd`,
`seal?`) est **toujours en clair**. `integrity.contentHash` = SHA-256 des octets
stockés — il détecte une **corruption accidentelle**, pas une altération
délibérée (il vit dans le manifeste en clair). La **détection anti-altération**
est assurée par le **sceau** (§6.3).

### 5.3 Modèle de document
`content/document.json` : `{ schema:"elium-doc/1", page{format,orientation,
margins(mm),showPageNumbers}, doc{arbre ProseMirror/TipTap} }`. Nœuds :
paragraph, heading, listes/tâches, blockquote, codeBlock(language),
horizontalRule, image, table/row/header/cell ; marques : bold, italic,
underline, strike, code, link, highlight, textStyle(color/fontFamily/fontSize).

### 5.4 Profils de protection (additifs, optionnels)
| Profil | Chiffré | Mot de passe | Verrouillé | Suivi | Signatures |
|---|---|---|---|---|---|
| `standard` | non | non | non | non | non |
| `signed` | non | non | non | oui | oui |
| `tracked` | non | non | non | oui | non |
| `protected` / `encrypted` | oui | oui | non | non | non |
| `locked` | non | non | oui | oui | oui |
| `secure_max` | oui (cascade) | oui | oui | oui | oui |

### 5.5 Journal de suivi & JSON canonique
Journal `tracking/journal.json` : évènements chaînés par hash
(`hash = sha256(prevHash + canonicalJSON(payload))`) — toute rupture indique une
altération. Types : `document.created/modified`, `signature.added/validated`,
`protection.enabled`, `document.locked/opened`, `export`.
**JSON canonique** (empreintes reproductibles TS↔Python) : clés triées
récursivement, séparateurs `","`/`":"`, UTF-8, clés vides omises ; empreintes =
SHA-256 sur l'UTF-8 du JSON canonique.

### 5.6 Conteneur hérité v3 (primitive de chiffrement)
`Magic(6) ELIUM\x03 | HeaderLen(4 BE) | Header JSON | CiphertextLen(8 BE) |
Ciphertext (AES-GCM ± ChaCha20) | Signature(64 Ed25519, opt.) | HMAC(32)`.

---

## 6. Sécurité & cryptographie

### 6.1 Principe : la sécurité dépend du profil
Protections **optionnelles**. `standard`/`signed`/`tracked`/`locked` :
contenu **non chiffré** (portable mais pas confidentiel — `locked`/`tracked`
offrent de la *détection d'altération*, pas de la confidentialité).
`protected`/`encrypted`/`secure_max` : corps chiffré.

### 6.2 Primitives (zéro crypto maison)
Argon2id (t=3, m=256 MiB, p=4) · AES-256-GCM (+ cascade ChaCha20-Poly1305 pour
`secure_max`) · HKDF-SHA256 · HMAC-SHA256 (temps constant) · Ed25519 · ECDH-ES
P-256 multi-destinataires · SHA-256. Uniquement `cryptography`, `argon2-cffi`
(Python) et `@noble/*`, `hash-wasm`, WebCrypto (Web). Keyfile optionnel comme
2ᵉ facteur (`password + "|KF|" + sha256(keyfile)`).

### 6.3 Le sceau de document (ancrage anti-altération)
Signature **Ed25519** de l'auteur sur un condensé canonique liant *ensemble* le
sous-ensemble du manifeste, `sha256(signatures)` et `sha256(journal)` :
```
message = canonicalJSON({ v:1,
  manifest:{ format, formatVersion, profile, title, language, createdAt,
             protection{encrypted,locked,keyfileRequired,contentEntry},
             integrity{algorithm,contentHash} },
  signaturesHash: sha256(canonicalJSON(signatures)),
  journalHash:    sha256(canonicalJSON(journal)) })
```
Toute modification du contenu, du journal, de l'ensemble des signatures ou du
profil **casse le sceau** (`broken`). Champs volatils exclus
(`modifiedAt`/`generator`/`features`/`rgpd`/`seal`) → un ré-enregistrement
légitime ne le casse pas. Verdicts : `valid | unknown_key | broken | unsealed`.
Miroirs byte-for-byte : `format/seal.py` / `sign/seal.ts`. **Interopérable**
(fixture Python vérifiée par Vitest). **Le verdict n'est pas bloquant à
l'ouverture** (l'API renvoie toujours le document ; l'appelant doit vérifier
`seal.verdict !== "broken"` avant de faire confiance).

### 6.4 Chiffrement optionnel des métadonnées (F-7)
Sur un profil chiffré, l'option « Chiffrer aussi les métadonnées » déplace
titre/signataires/journal dans une enveloppe AEAD *à l'intérieur* du conteneur
chiffré ; les entrées ZIP en clair sont caviardées. **Opt-in** (par défaut, les
métadonnées restent en clair pour permettre lister/rechercher sans ouvrir).

### 6.5 Aucun recouvrement (zero-knowledge)
Elium ne connaît, ne stocke ni ne transmet jamais un mot de passe ou un
fichier-clé en clair. **La perte du mot de passe / fichier-clé d'un document
chiffré est définitive** — aucune clé maîtresse, aucun « mot de passe oublié ».
*(Côté Drive entreprise, le **recouvrement d'organisation** — clé emballée vers
les admins — est la seule voie de récupération d'accès à un nœud.)* Conservez
vos secrets (gestionnaire de mots de passe). C'est une conséquence assumée du
modèle.

### 6.6 Stockage des clés
La clé privée Ed25519 du Web Studio n'est **jamais** en clair : chiffrée au repos
(Argon2id + AES-256-GCM) sous un mot de passe utilisateur, en clair seulement en
mémoire après déverrouillage. `localStorage` ne contient que la clé publique,
l'empreinte et le blob chiffré. Les mots de passe ne sont jamais écrits dans le
`.elium`.

### 6.7 Durcissement Drive entreprise — Phase 2 (livré 2026-07-11)
1. **Rotation de clé à la révocation** — retirer un accès régénère la clé de
   contenu (CEK) : révocation profonde du sous-arbre (parts de clé héritées
   nettoyées, propriétaire préservé), re-chiffrement nom/méta/contenu/**toutes
   les versions** + compaction du backlog collab sous la nouvelle clé, révocation
   des liens externes, garde d'époque `key_epoch` (écriture périmée → 409),
   éviction live des pairs (WS close 4001 → re-fetch transparent de clé), reprise
   après interruption (slot `prev_key_wrapped`). Côté suite locale : le `.elium`
   re-chiffre avec une CEK fraîche à chaque sauvegarde → un destinataire retiré
   ne peut plus ouvrir le nouveau fichier.
2. **MFA (TOTP, RFC 6238)** — secret chiffré au repos (clé dérivée de
   `TOKEN_SECRET`), login en deux temps (bundle non livré avant le 2ᵉ facteur),
   codes de secours à usage unique, enrôlement par QR.
3. **Login sans oracle** (défi-réponse Ed25519) — voir §4.2. Objectif de
   SRP/OPAQUE atteint avec une primitive éprouvée. *Limite résiduelle* : un vol
   du vérificateur (clé publique d'auth) permet encore une attaque dictionnaire
   hors-ligne au coût d'un Argon2id par essai — identique à SRP ; c'est le coût
   Argon2id qui protège.
4. **Quotas de stockage** par organisation (dépassement → 507) + **rate-limiting
   par route** sur l'authentification (anti-brute-force, clé = IP).
5. **Padding des tailles** (Padmé, PURBs) — le contenu est rembourré avant
   chiffrement ; la longueur ne révèle plus qu'un bucket (surcoût < ~12 %).
   S'applique au contenu, aux noms, aux métadonnées et aux updates collab.

### 6.8 DoS & robustesse
Bornes KDF **identiques** Python/Web (t≤6, m≤256 MiB, p≤16) ; décompression du
conteneur plafonnée à 512 MiB ; **ZIP externe** plafonné (128 MiB/entrée,
384 MiB total) ; garde de profondeur JSON ; erreurs typées (`EliumError`).

---

## 7. Signatures — Elium Sign

Deux couches **volontairement séparées** :

- **Visuelle** (toujours) : dessin, texte, image, tampon (Approuvé/Validé/…),
  initiales, QR, ou mixte ; placement libre (déplacement, redimensionnement,
  rotation, z-index, ancrage page) en **% de page** (portable). Seule, **elle
  n'est pas une preuve** (copiable) — c'est une marque d'intention.
- **Preuve cryptographique** (optionnelle, « advanced ») : empreinte du contenu
  `SHA-256(canonicalJSON(document))`, signature **Ed25519** sur
  `{v, signatureId, signedContentHash, signer, signedAt}`, empreinte de clé
  publique, horodatage **local** (non qualifié).

**Statuts** (toujours recalculés à l'ouverture, jamais lus tels quels) :
`valid` (vérifie + document identique) · `modified` (vérifie mais document
changé) · `invalid` · `unknown_key` (clé de confiance fournie ≠ signataire) ·
`visual_only`. **Interopérable** (Web Studio ↔ CLI `elium doc-verify`).

**Ce que ce N'EST PAS** : Elium n'émet **pas** de signatures qualifiées eIDAS et
**n'est pas** une PKI. Confiance établie hors bande (empreinte) ou épinglage
TOFU (`sign/seal-pinning.ts`). Sur un document **non chiffré/non verrouillé**, un
tiers peut retirer une signature et reconstruire le paquet → utilisez `locked`
ou `secure_max` **et** vérifiez la clé publique du signataire.

---

## 8. Modèle de menace

**Actifs** : confidentialité (profils chiffrés), intégrité (ancrée par le
sceau), authenticité d'auteur (preuve Ed25519 optionnelle).

| Adversaire | Couvert ? | Mécanisme |
|---|---|---|
| Lecteur sans mot de passe (profil chiffré) | ✅ | Argon2id + AES-256-GCM |
| Altération d'un fichier **scellé** (contenu/journal/signatures/profil) | ✅ | Sceau Ed25519 casse |
| Altération d'un fichier **non scellé** | ⚠️ corruption seule | `contentHash` non clé → **scellez** |
| Altération d'un document signé | ✅ | `signedContentHash` ≠ empreinte ⇒ `modified` |
| Falsification de signature | ✅ | Vérif Ed25519 ⇒ `invalid` |
| Réécriture du journal (fichier **non scellé**) | ❌ | Chaîne de hash cohérente si réécrite en entier → **scellez** |
| Usurpation d'identité affichée | ⚠️ | Ed25519 ne s'attribue qu'avec une **clé de confiance** |
| DoS (KDF / zip bomb) | ✅ | Bornes alignées + plafonds de décompression/ZIP |

**Hors périmètre** : poste compromis (malware/keylogger/RAM), mot de passe
faible (Argon2id ralentit mais n'empêche pas le hors-ligne), non-répudiation
qualifiée (eIDAS → prestataire qualifié), PKI (pas d'AC), métadonnées du
manifeste en clair par défaut. **Hypothèses** : clé publique obtenue par un
canal de confiance ; bibliothèques crypto sûres ; poste non compromis.

---

## 9. Historique d'audit de sécurité

Audit initial **2026-06-10** (revue de code + pentest, 11 scénarios). La
cryptographie de chiffrement était solide ; les garanties d'**intégrité/suivi/
signature** reposaient sur des données non authentifiées (manifeste, journal,
signatures = entrées ZIP en clair ; `contentHash` non clé). **Correctif central :
le sceau de document Ed25519** (§6.3).

| # | Faille | Sév. | Statut |
|---|---|---|---|
| F-1 | Intégrité non authentifiée (altération silencieuse) | 🔴 | Corrigé (sceau) |
| F-2 | Journal réécrivable sans détection | 🔴 | Corrigé (sceau) |
| F-3 | Signature « valide » forgée ; UX trompeuse | 🔴 | Atténué (sceau + UX « clé non vérifiée ») |
| F-4 | Retrait de signature non détecté | 🔴 | Corrigé (sceau) |
| F-5 | Clé privée Ed25519 en clair dans `localStorage` | 🔴 | Corrigé (chiffrée au repos) |
| F-6 | Usurpation de badge/profil | 🟠 | Corrigé (sceau) |
| F-7 | Fuite métadonnées/PII sur fichier chiffré | 🟠 | Corrigé (chiffrement métadonnées opt-in, §6.4) |
| F-8 | Divergence bornes KDF Web vs Python | 🟠 | Corrigé (bornes alignées) |
| F-9 | ZIP externe sans plafond → DoS mémoire | 🟠 | Corrigé (plafonds 128/384 MiB) |
| F-10 | Robustesse parseur | 🟡 | Corrigé (erreurs typées + garde profondeur) |
| F-11 | Desktop lié à `0.0.0.0` sans en-têtes | 🟠 | Corrigé (`127.0.0.1` + en-têtes) |
| F-12 | Export : liens `javascript:`, injection CSS | 🟡 | Corrigé (filtrage + Blob URL) |

Couvert par `tests/python/test_seal.py` et `web-studio/tests/seal.test.ts`.

### Signalement d'une vulnérabilité
**Ne pas** ouvrir d'issue publique. Contactez les mainteneurs par un canal privé
(voir [SECURITY.md](SECURITY.md)). Accusé de réception + calendrier de correction.

---

## 10. Exploitation (VPS)

- **Sauvegardes** : `bash install.sh backup` → `backups/elium-db-*.sql.gz` +
  `elium-blobs-*.tar.gz`. Sauvegardez **base ET blobs ensemble** (ils se
  référencent), sur un support chiffré. Sans les clés côté clients, elles
  restent illisibles (zéro-connaissance).
- **Mises à jour** : `bash install.sh update` (git pull + rebuild + restart,
  migrations rejouées).
- **Rotation des secrets** — ⚠️ : changer `TOKEN_SECRET` **déconnecte toutes les
  sessions** et **rend illisibles les secrets MFA existants** (ré-enrôlement
  requis) ; cela n'affecte pas les données (chiffrées côté client). Ne le faire
  qu'en cas de compromission. Changer `POSTGRES_PASSWORD` nécessite une procédure
  dédiée (le volume Postgres existant garde l'ancien).
- **Durcissement VPS** : disque de données **LUKS** ; **pare-feu** n'exposant que
  80/443 (l'API 8787, la DB et MinIO restent internes) ; **2FA** imposée aux
  comptes sensibles ; `.env` en `600` sauvegardé hors serveur ; sauvegardes
  testées ; mises à jour régulières.

---

## 11. État : fait / reste / à améliorer

> Établi à partir du code réel. « Fait » = livré et testé ; « Reste » = non
> implémenté ; « À améliorer » = présent mais perfectible.

### Drive entreprise
- **Fait** : auth zéro-connaissance sans oracle, RBAC granulaire, partage
  profond (membre/équipe/lien), versions, corbeille, journal d'audit,
  co-édition temps réel chiffrée, recouvrement d'org, **+ Phase 2** (rotation de
  clés, MFA, quotas, rate-limiting, padding). Testé de bout en bout (E2E 87/87,
  vrai Postgres + vraie API + vrai SDK), gaté en CI (job `server-e2e`).
- **Fait aussi** : **SSO (OIDC)** + **SCIM** (provisioning/déprovisioning) en
  restant zéro-connaissance (§4.5), validés E2E.
- **Reste** : mode **présentation** dans l'éditeur de diapos *collaboratif* (le
  réglage de transition y est stocké mais pas rejoué).
- **À améliorer** : fusion caractère-par-caractère des champs texte collaboratifs
  (actuellement LWW par champ).

### Suite locale — Documents
- **Fait** : éditeur riche complet, suivi des modifications, import/export DOCX,
  sceau & signatures.
- **Reste** : **pagination écran réelle** (feuilles A4 empilées ; piste Paged.js).
- **À améliorer** : suivi des modifications non exporté en `w:ins`/`w:del` DOCX ;
  import DOCV ne relit pas toujours couleur/police/taille ; polices importées non
  persistées dans le `.elium`.

### Suite locale — Tableur
- **Fait** : ~59 formules, refs inter-feuilles, graphiques, mise en forme
  conditionnelle, tri, filtre, import XLSX/CSV. **AutoFilter réel** — tri, copie
  et export CSV ne considèrent que les lignes visibles (`sheet/filter.ts`).
- **Reste** : **export XLSX** (asymétrie avec l'import) ; fusion de cellules,
  validation de données, plages nommées, tableaux croisés.

### Suite locale — Présentations
- **Fait** : refonte canvas libre à objets (rotation/z-order/opacité), 8
  poignées, guides magnétiques, mode présentateur, transitions, export PPTX.
  **Animations par élément** câblées de bout en bout (lecture pas-à-pas au
  clic, keyframes CSS, rejouées en mode présentateur ET en mode public).
  **Vraie vue présentateur** (2ᵉ écran) : fenêtre popup séparée synchronisée
  par `BroadcastChannel`, avec notes, minuteur et diapo suivante. **Import
  PPTX** (`web-studio/src/slides/pptx-import.ts`) : formes, texte, images,
  tableaux, groupes. Transition **« Morph »** = interpolation réelle par
  élément (position/taille/rotation/opacité), pas un simple fondu.
- **Reste** : **galerie de modèles** riche (au-delà des quelques mises en page
  de base déjà fournies par `templates.ts`).

### Suite locale — PDF
- **Fait** : lecteur + annotation + édition de texte, persistance `.elium`,
  rotation de pages correcte.
- **Reste** : couche texte de **sélection/recherche** en lecture (Ctrl+F) ;
  **AcroForm** (formulaires) ; **fusion/division** multi-fichiers.

### Cœur Python & format
- **Fait** : parité `.elium` Python↔TS (format, sceau, signatures, chiffrement),
  interop testée par fixtures croisées. **Multi-destinataires ECDH-ES câblé au
  niveau paquet** des deux côtés (`write_elium(recipients=…)` /
  `read_elium(recipient_private_hex=…)` + CLI `--recipient`/`--recipient-key`),
  interop paquet testée dans les deux sens. **`docId` (UUID)** est désormais
  l'identifiant unique du document (index local versions/Parapheur/pinning), avec
  repli sur `createdAt` pour les fichiers hérités (`docKeyOf`) — hors sous-ensemble
  signé du sceau.

### Outillage & distribution
- **Fait** : **ESLint 9 (flat config) + Prettier** sur web-studio et server,
  câblés en CI (lint vert). Le **MSI a été retiré de l'historique git**
  (`git filter-repo` ; dépôt 13,2 Mo → ~1 Mo) — à distribuer via GitHub Releases.
- **À améliorer** : `AutoFilter réel` livré (Tableur) ; reste le code-splitting
  partiel des vues lourdes. Add-in Office = **prototype non fonctionnel**
  (chiffrement non implémenté ; ne pas distribuer).

---

## 12. Feuille de route

1. **Présentations v2 — parité dual-plateforme** : animations par élément,
   vraie vue présentateur (2ᵉ écran), morph par interpolation et import PPTX
   sont déjà livrés sur l'éditeur **local** (§11) ; reste à porter le rejeu des
   animations/transitions sur l'éditeur **collaboratif** (Drive), où le
   réglage est aujourd'hui stocké mais pas rejoué, et à enrichir la galerie de
   modèles sur les **deux** éditeurs.
2. **Parité fonctionnelle** : export XLSX (Tableur), pagination écran (Documents),
   couche texte de lecture PDF.
3. **Qualité** : interop Python↔TS en CI ; code-splitting des vues lourdes.
4. **Microsoft 365 (cible future, après consolidation locale)** : add-in Office
   (Word/Excel/PowerPoint/Outlook) réutilisant `format` + `sign` extraits en
   packages ; conversion DOCX/PDF ↔ `.elium`. Toute fonction en ligne reste
   **opt-in** et conforme RGPD.

---

## 13. Guide développeur

### Structure
```
elium-main/
├── src/elium/          Cœur Python (core, crypto, format, cli)
├── web-studio/         App web (Vite/React/TS) — suite + Drive client
│   ├── src/            format, crypto, sign, editor, sheet, slides, drive-cloud
│   └── tests/          vitest + e2e-multiuser.ts (Drive, vrai Postgres embarqué)
├── server/             Drive entreprise (Fastify + Postgres)
├── installer/          build exe (PyInstaller) + MSI (WiX)
├── deploy/             Caddyfile + README opérateur
├── docker-compose.yml  pile Drive (caddy/web/api/db/minio)
└── install.sh          installateur/configurateur unique
```

### Commandes
| Action | Commande |
|---|---|
| Suite web (dev) | `cd web-studio && npm run dev` (port 3100) |
| Tests web | `cd web-studio && npx vitest run` |
| E2E Drive (sans Docker) | `cd web-studio && npm run test:e2e` |
| Tests Python | `pytest tests/python` |
| API Drive (dev) | `cd server && npm run dev` |
| Pile Drive complète | `bash install.sh drive --local` |
| Build MSI | `installer/build.bat` puis `installer/build_msi.bat /nopause` |

### Conventions
- **JSON canonique** partout où une empreinte doit être reproductible Python↔TS
  (§5.5). Les miroirs Python/TS doivent rester byte-for-byte (sceau, recipients,
  format) — tout changement se valide par les fixtures d'interop.
- Cryptographie : **aucune primitive maison**. Réutiliser `cryptography`/
  `argon2-cffi` (Python) et `@noble/*`/`hash-wasm`/WebCrypto (Web).

---

## 14. Confidentialité / RGPD

Traitement **100 % local** par défaut : aucun document n'est envoyé en ligne
sans action explicite. Minimisation des données, transparence (badges de
protection), pas de télémétrie. Le Drive entreprise, lui, est auto-hébergé et
zéro-connaissance : les données restent chez vous, chiffrées de bout en bout.
Détail légal : [PRIVACY_RGPD.md](PRIVACY_RGPD.md). Toute fonctionnalité en ligne
future (horodatage qualifié, add-in) reste **opt-in**.

---

## 15. Annexes

### Référence de configuration (Drive `.env`)
| Variable | Rôle | Défaut |
|---|---|---|
| `SITE_ADDRESS` | Adresse Caddy (domaine → HTTPS auto ; `:80` → local) | `:80` |
| `TOKEN_SECRET` | Signature jetons **et** chiffrement secrets MFA au repos | *(généré)* |
| `POSTGRES_PASSWORD` | Mot de passe Postgres | *(généré)* |
| `CORS_ORIGINS` | Origines navigateur autorisées (CSV) | origine du site |
| `STORAGE_DRIVER` | `fs` (volume) ou `s3` (MinIO/S3) | `fs` |
| `S3_ACCESS_KEY` / `S3_SECRET_KEY` / `S3_BUCKET` | Identifiants + bucket S3 | `elium`/*(généré)*/`elium-blobs` |
| `RUN_MIGRATIONS` | Migrations au démarrage | `true` |

Variables API surchargeables (service `api`) : `PORT` (8787), `HOST` (0.0.0.0),
`ACCESS_TOKEN_TTL_SECONDS` (900), `REFRESH_TOKEN_TTL_SECONDS` (2592000),
`MAX_BLOB_BYTES` (2 Gio), `MAX_JSON_BYTES` (1 Mio), `S3_ENDPOINT`, `S3_REGION`,
`S3_FORCE_PATH_STYLE`.

### Fichiers de doc conservés (hors ce document)
- [`README.md`](README.md) — présentation courte + point d'entrée.
- [`SECURITY.md`](SECURITY.md) — politique de signalement de vulnérabilité.
- [`PRIVACY_RGPD.md`](PRIVACY_RGPD.md) — mentions RGPD.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — contribuer.
- [`deploy/README.md`](deploy/README.md) — mécanique de déploiement détaillée.
- `install.sh` — installateur/configurateur unique.

*Tout le reste (rapports d'état datés, SPEC, THREAT_MODEL, SIGNATURE_MODEL,
SECURITY_AUDIT, guides, roadmaps, INSTALL) a été **consolidé dans ce document**.*
