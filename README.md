# Elium

Suite bureautique **chiffrée, signée et scellée**, *local-first*, au format ouvert
`.elium` — Documents, Tableur, Présentations, PDF — plus un **Drive d'entreprise**
zéro-connaissance avec co-édition temps réel.

- **Chiffrement** : Argon2id + AES-256-GCM (cascade ChaCha20-Poly1305 en profil
  `secure_max`), multi-destinataires ECDH-ES P-256.
- **Preuve** : sceau et signatures **Ed25519**, journal à intégrité chaînée.
- **Interopérable** : cœur Python (`src/elium/`) et Web Studio TypeScript
  (`web-studio/`) byte-for-byte via JSON canonique.
- **Drive entreprise** : RBAC granulaire, partage & liens, SSO/SCIM, passkeys
  (WebAuthn + PRF), recouvrement d'organisation — le serveur ne voit que du chiffré.

## Architecture

Le dépôt regroupe cinq sous-projets :

- **`src/elium/`** — cœur Python : CLI, format conteneur `.elium` (et lecture du
  conteneur legacy v3), primitives crypto (Argon2id, AES-256-GCM/ChaCha20-Poly1305,
  signatures Ed25519).
- **`web-studio/`** — client React/Vite/TypeScript : éditeurs Documents, Tableur,
  Présentations, PDF, et le client du Drive Cloud (collaboration temps réel,
  chiffrement de bout en bout côté navigateur).
- **`server/`** — backend Drive Cloud en Fastify/TypeScript : RBAC, SSO/SCIM,
  WebAuthn, relais de collaboration temps réel (Yjs), stockage des blobs chiffrés.
- **`installer/`** — packaging Windows : exécutable via PyInstaller
  (`elium_launcher.py`) et paquet MSI (WiX, `elium.wxs`), avec auto-mise à jour
  signée Ed25519. Voir [installer/README.md](installer/README.md).
- **`desktop/`** — ⚠️ **legacy, non maintenue et non testée**. Ancienne application
  PySide6. Le vrai pipeline de release (`installer/build.bat` + `elium.spec`,
  ce que `release.yml` exécute) construit l'app livrée depuis `web-studio/` +
  `installer/` et exclut explicitement `desktop/`. Les scripts racine
  `Elium.wizard.bat`, `dev.bat` et `build_exe.bat` ont été réalignés sur ce
  vrai flux (ils ne lancent/ne construisent plus l'ancienne app PySide6). Ne
  t'y fie pas pour comprendre l'application distribuée aux utilisateurs finaux.

## Installation

### Utilisateur final

Télécharge l'installeur (`.exe` ou `.msi`) depuis les
[Releases GitHub](../../releases) du dépôt et lance-le. Aucune compilation
requise.

### Développeur

La suite de ce README couvre le setup développeur : compiler et lancer chaque
sous-projet depuis les sources, lancer la pile complète en local, construire
l'installeur, et exécuter les tests.

## Setup développeur

Chaque sous-projet peut être lancé isolément pour développer une partie précise
de la suite (l'éditeur seul, l'API seule, le cœur crypto seul) :

```bash
# Web Studio (éditeurs + client Drive Cloud) — http://localhost:3000
cd web-studio
npm install
npm run dev

# Serveur Drive Cloud (Fastify)
cd server
npm install
npm run migrate   # applique les migrations sur la base configurée (DATABASE_URL)
npm run dev

# Cœur Python + CLI
pip install -e ".[dev]"
pytest
```

Ces trois commandes suffisent pour développer chaque partie séparément, mais le
serveur a besoin d'une base Postgres (et, en collaboration multi-instance, de
Redis) pour fonctionner réellement — voir la section suivante pour un
environnement complet.

> **Multiplateforme ou non ?** Les trois commandes ci-dessus (`web-studio/`,
> `server/`, cœur Python) fonctionnent sans changement sur Linux, Mac et
> Windows. En revanche, les scripts `.bat` (racine et `installer/`) ainsi que
> le packaging final — exécutable PyInstaller et paquet MSI (WiX) — sont
> Windows-only, puisque le produit distribué cible Windows. Un·e contributeur
> Linux/Mac peut donc développer normalement les trois sous-projets, mais ne
> peut pas construire ni tester l'installeur localement : voir
> [installer/README.md](installer/README.md), ou passer par la CI
> (`.github/workflows/release.yml`).

## Lancer la pile complète en local

Pour tester le Drive Cloud collaboratif de bout en bout (API + base de données +
relais temps réel + edge TLS), les trois commandes isolées ci-dessus ne
suffisent pas : il faut la pile complète orchestrée par Docker Compose.

```bash
cp deploy/.env.example .env
# éditer .env : au minimum TOKEN_SECRET, POSTGRES_PASSWORD

docker compose up
```

Cela démarre `db` (Postgres), `api` (le serveur Fastify), `redis` (backplane de
collaboration cross-instance), `web` (le Web Studio compilé, servi en statique)
et `caddy` (edge TLS/reverse proxy devant tout le reste) — voir
[docker-compose.yml](docker-compose.yml) et [deploy/Caddyfile](deploy/Caddyfile).
Le stockage des blobs chiffrés est local (`fs`) par défaut ; pour du S3, ajoute
`--profile s3` afin de démarrer aussi le service `minio` optionnel, et mets
`STORAGE_DRIVER=s3` dans `.env`.

## Construire l'installeur

Voir [installer/README.md](installer/README.md).

## Tests et lint

```bash
# web-studio
cd web-studio && npx vitest run && npm run lint

# server
cd server && npx vitest run && npm run lint

# cœur Python (depuis la racine)
pytest
ruff check src/ tests/
```

## Documentation

**La documentation utilisateur et déploiement vit dans l'application**, sur une
page unique et complète : ouvre Elium → bouton **Documentation** (icône livre,
en haut de l'accueil). Elle couvre l'installation, le déploiement du Drive, le
format, la cryptographie, la sécurité, chaque module, l'authentification, le
RGPD et le journal des versions.

Pour l'architecture côté contributeur (comment les sous-projets s'articulent,
choix techniques), voir [docs/architecture.md](docs/architecture.md).

## Contribution

Voir [CONTRIBUTING.md](CONTRIBUTING.md).

## Licence

Voir [LICENSE](LICENSE).
