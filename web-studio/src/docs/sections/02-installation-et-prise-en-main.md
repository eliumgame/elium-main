## Installation et prise en main

Le point d'entrée unique est **`install.sh`**, à la racine du dépôt.

```bash
bash install.sh                                   # menu interactif
bash install.sh drive --domain drive.exemple.fr   # Drive entreprise (VPS, HTTPS auto)
bash install.sh drive --local                     # Drive en local (http://localhost)
bash install.sh suite                             # suite bureautique dans le navigateur
bash install.sh update | status | backup          # exploitation
```

Options de la commande `drive` : `--domain <fqdn>` · `--local` · `--email <acme>`
· `--storage fs|s3` · `--quota-gb <n>` · `--port <n>` · `--yes` · `--dry-run`.

> Sous **Windows**, lancez `install.sh` via **Git Bash** ou **WSL**. Pour la
> seule suite bureautique, préférez le **MSI**.

### Suite bureautique sur un PC

- **Windows (recommandé)** : double-cliquez sur le **MSI** (`Elium-<version>-Setup.msi`,
  dossier `Téléchargements`, ou `installer/output/` après un build). Tout
  fonctionne **hors-ligne**, sans compte. L'exe autonome `Elium.exe` fonctionne
  aussi sans installation.
- **Assistant Windows** : `Elium.wizard.bat` installe Node + Python au premier
  lancement puis ouvre le Web Studio.
- **Tout OS (navigateur)** : `bash install.sh suite` → `http://localhost:3100`.
- **Installation manuelle / autres OS** :
  ```bash
  # 1. Cœur Python + CLI
  python -m venv .venv
  . .venv/bin/activate            # Windows : .venv\Scripts\activate
  pip install -e .[dev]

  # 2. Web Studio
  cd web-studio
  npm install
  npm run dev                     # http://localhost:3000 (3100 en prod locale)
  ```
- **Reconstruire le MSI** : `installer/build.bat` (exe PyInstaller) puis
  `installer/build_msi.bat /nopause` (MSI WiX) → `installer/output/`.
- **Mises à jour** : une fois installée, l'app se met à jour **automatiquement**
  depuis les GitHub Releases (voir §3).

### Drive d'entreprise sur un VPS (production)

1. **DNS** : un enregistrement **A/AAAA** `drive.exemple.fr` → IP du VPS. Le
   domaine **doit** résoudre avant le lancement (`dig +short drive.exemple.fr`).
2. **Docker** : `curl -fsSL https://get.docker.com | sh` puis
   `sudo usermod -aG docker "$USER" && newgrp docker`.
3. **Code** : `git clone … && cd elium-main`.
4. **Config + lancement** :
   ```bash
   bash install.sh drive --domain drive.exemple.fr --email vous@exemple.fr
   ```
   Le script génère `TOKEN_SECRET` + le mot de passe Postgres, écrit `.env`
   (droits `600`), construit et démarre la pile Docker, puis attend `/api/health`.
   Les **migrations sont automatiques** (schéma + rôles système) et idempotentes.
   Vérifier : `curl https://drive.exemple.fr/api/health`.

   > Re-lancer `install.sh` est **sûr** : il **préserve** les secrets existants
   > (ne régénère jamais `TOKEN_SECRET` ni le mot de passe DB — les régénérer
   > invaliderait sessions et secrets MFA).
5. **Premier compte = propriétaire.** Créez votre **organisation** (vous obtenez
   la clé de recouvrement). Invitez des membres, créez des équipes, ajustez rôles
   et permissions.
6. **2FA** : onglet **Sécurité** → activer → scanner le QR → sauvegarder les
   codes de secours.
7. **App de bureau → Drive** : carte Drive → bouton **« Serveur »** →
   `https://drive.exemple.fr/api` → Enregistrer.

### Drive en local (test)

```bash
bash install.sh drive --local          # http://localhost (ou --port 8080)
```

Configuration manuelle équivalente :

```bash
cp deploy/.env.example .env
# Éditez .env : SITE_ADDRESS, TOKEN_SECRET, POSTGRES_PASSWORD, CORS_ORIGINS
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"  # TOKEN_SECRET
docker compose up -d --build
curl -k https://SITE_ADDRESS/api/health
```

### Services de la pile Drive

| Service | Rôle | Exposition |
|---|---|---|
| `caddy` | Reverse-proxy TLS, sert l'app + `/api/*` (dont WebSocket) | 80/443 |
| `web`   | App web (build Vite statique) | interne |
| `api`   | API Fastify + relais de co-édition chiffré | 8787 (interne) |
| `db`    | Postgres 16 (métadonnées + clés emballées, chiffré) | interne |
| `minio` | Stockage objet S3 optionnel (profil `s3`, aucun port publié) | interne |

Volumes persistants : `pgdata`, `blobs`, `caddy_data`, `caddy_config`,
`miniodata` (profil s3). Caddy fournit **HTTPS automatique** (Let's Encrypt/ACME)
dès que le domaine résout et que les ports 80/443 sont ouverts.

### Dépannage rapide

- **« Serveur Drive injoignable » / « Not Found »** : aucun serveur configuré →
  bouton **Serveur** → URL de l'API (`https://votre-domaine/api`). L'app de bureau
  n'embarque pas de backend.
- **TLS ne se génère pas** : le domaine doit résoudre vers le VPS ; ports 80/443
  ouverts (Let's Encrypt valide via le port 80). Vérifier `docker compose logs caddy`.
- **CORS** : `CORS_ORIGINS` (dans `.env`) doit contenir exactement l'origine
  d'accès. `install.sh` la règle ; sinon éditez puis `bash install.sh update`.
- **Collab ne synchronise pas** : le WebSocket est sur `/api/collab/*` (proxifié
  par Caddy) ; si un autre proxy est devant, activez le passage des connexions
  `Upgrade`.
- **API ne démarre pas** : souvent `TOKEN_SECRET` absent (l'API refuse de démarrer
  en prod sans un secret ≥ 32 caractères). Vérifier `docker compose logs api`.

---
