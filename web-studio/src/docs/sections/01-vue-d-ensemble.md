## Vue d'ensemble

Elium est une **suite bureautique et un Drive d'entreprise chiffrés**, conçus
_local-first_ et _zéro-connaissance_, articulés autour d'un **format de fichier
`.elium`** portable, signable et scellé. Ce n'est pas un simple conteneur
chiffré : c'est un écosystème documentaire complet pour **rédiger, calculer,
présenter, annoter des PDF, signer, protéger et vérifier** des documents, puis
les enregistrer dans un fichier `.elium` portable et vérifiable.

Le positionnement d'Elium est celui d'une **alternative chiffrée de bout en bout
à Google Workspace / Microsoft 365**, où le serveur ne voit **jamais** le contenu
en clair. Par défaut, aucun document n'est envoyé en ligne.

Concrètement, Elium se décline en **deux produits** qui partagent le même format
`.elium`, les mêmes primitives cryptographiques, le même moteur de signatures et
les mêmes éditeurs.

| Produit | Ce que c'est | Où ça tourne |
|---|---|---|
| **Suite bureautique locale** | Documents, Tableur, Présentations, PDF, Drive local et Parapheur — 100 % hors-ligne, chiffrés/signés par document | Le **PC** de l'utilisateur (MSI Windows ou navigateur) |
| **Drive d'entreprise** | Plateforme web multi-utilisateurs, zéro-connaissance : stockage, partage, co-édition temps réel, rôles et permissions | Un **serveur que vous hébergez** (VPS Linux, ou PC via Docker) |

Une règle **dual-plateforme** gouverne le produit : toute fonctionnalité livrée
existe des **deux** côtés (local et collaboratif).

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

**Point essentiel** : l'application de bureau **n'embarque aucun serveur**
(c'est la suite *locale*). Le **Drive d'entreprise** est un service que **vous
hébergez** et auquel l'app se connecte via son URL (bouton « Serveur » de l'écran
de connexion). Sans serveur configuré, la carte Drive affiche « Serveur Drive
injoignable ».

### Organisation du dépôt

```
elium-main/
├── src/elium/            Cœur Python (core, crypto, format, cli)
│   ├── core/             Conteneur chiffré v3 (primitive de chiffrement héritée)
│   ├── crypto/           Argon2id · AES-256-GCM · ChaCha20-Poly1305 · Ed25519 · HMAC
│   ├── format/           Format documentaire v4 : package, manifeste, journal, profils, preuve
│   └── cli/              CLI (create/open hérités + doc-create/doc-open/doc-verify/doc-sign)
├── web-studio/           App web React/TypeScript — suite bureautique + client Drive
│   └── src/
│       ├── format/       Lecture/écriture .elium, JSON canonique, journal, profils
│       ├── crypto/       Moteur crypto (WebCrypto + @noble/*), coffre local
│       ├── sign/         Elium Sign : signatures visuelles, preuve et sceau Ed25519
│       ├── editor/       Éditeur riche TipTap (barre d'outils, pagination, suivi)
│       ├── sheet/        Tableur (formules, XLSX/CSV, mise en forme conditionnelle)
│       ├── slides/       Présentations (canvas, animations, PPTX, présentateur)
│       ├── pdf/          PDF (lecteur, annotation, formulaires AcroForm, fusion/division)
│       ├── drive-cloud/  Client Drive entreprise (SDK, provider CRDT chiffré, UI)
│       ├── panels/ views/ Inspecteur + écrans (Home, Studio, Sheet, Slides, PDF, Drive)
│       └── ui/           Design system
├── server/               Drive entreprise (Fastify + PostgreSQL)
│   └── src/              routes, rbac, db, collab (relais Yjs), storage, middleware
├── deploy/               Caddyfile + guide opérateur
├── installer/            build exe (PyInstaller) + MSI (WiX) + updater client
├── docker-compose.yml    Pile Drive : db · api · minio · web · caddy
├── install.sh            Installateur/configurateur unique (suite et Drive)
└── tests/                Tests Python + interop
```

---
