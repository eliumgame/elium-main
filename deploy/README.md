# Déploiement — Elium Drive Entreprise (VPS Linux)

> **Le plus simple : un seul fichier.** Depuis la racine du dépôt :
> ```bash
> bash install.sh drive --domain drive.exemple.fr --email vous@exemple.fr
> ```
> `install.sh` génère les secrets, écrit `.env`, construit et lance la pile,
> puis vérifie la santé. Menu interactif : `bash install.sh`. Guide complet
> (VPS **et** PC local) : **[../DOCUMENTATION.md §2](../DOCUMENTATION.md#2-installation)**. Ce README documente
> la mécanique sous-jacente (configuration manuelle équivalente).

Déploiement mono-VPS via Docker Compose : un reverse-proxy **Caddy** (HTTPS
automatique) devant l'app web statique et l'**API Fastify** (REST + relais
WebSocket de co-édition), avec **Postgres** et un volume de **blobs chiffrés**.

## Rappel sécurité
Le serveur est **zéro-connaissance** : Postgres et le volume `blobs` ne
contiennent que du **chiffré** (contenu, noms de fichiers, clés emballées).
Aucun mot de passe, clé privée ni contenu en clair n'y transite. Pour la défense
en profondeur, **chiffrez le disque du VPS au repos (LUKS)** — ainsi tout ce qui
touche le disque est doublement chiffré.

## Prérequis
- Docker + Docker Compose v2.
- Un nom de domaine pointant vers le VPS (pour HTTPS automatique).
- (Recommandé) partition de données sur volume LUKS.

## Configuration
```bash
cp deploy/.env.example .env
# Éditez .env :
#  - SITE_ADDRESS      = votre domaine (ex. drive.example.com)
#  - TOKEN_SECRET      = secret long et aléatoire :
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
#  - POSTGRES_PASSWORD = mot de passe base de données fort
#  - CORS_ORIGINS      = https://votre-domaine
```

## Lancement
```bash
docker compose up -d --build
```
- Les **migrations s'appliquent automatiquement** au démarrage de l'API
  (schéma + rôles système), de façon idempotente. Désactivable via
  `RUN_MIGRATIONS=false`.
- Vérifier la santé : `curl -k https://SITE_ADDRESS/api/health`.

## Services
| Service | Rôle | Port |
|---------|------|------|
| `caddy` | Reverse-proxy TLS, sert l'app + `/api/*` (dont WebSocket) | 80/443 |
| `web`   | App web (build Vite statique servi par Caddy) | interne |
| `api`   | API Fastify + relais de co-édition chiffré | 8787 (interne) |
| `db`    | Postgres 16 (métadonnées + clés emballées, chiffré) | interne |

Volumes persistants : `pgdata`, `blobs`, `caddy_data`, `caddy_config`.

## Sauvegardes
Sauvegardez `pgdata` **et** `blobs` ensemble (ils se référencent). Les
sauvegardes héritent du chiffrement E2E ; stockez-les sur un support lui aussi
chiffré. Une perte du couple (Postgres, blobs) sans les clés côté clients rend
les données irrécupérables — c'est le prix du zéro-connaissance.

```bash
bash install.sh backup                  # écrit backups/elium-db-<ts>.sql.gz + elium-blobs-<ts>.tar.gz
bash install.sh restore <timestamp>     # restaure ce couple (écrase l'état actuel, demande confirmation)
```
`restore` arrête `api`, restaure Postgres puis les blobs à partir des deux
fichiers correspondants, puis relance la pile. Utilisez-le pour un VPS
perdu/corrompu, en repartant d'une sauvegarde connue.

## Stockage objet S3 / MinIO (optionnel)
Par défaut les blobs chiffrés sont écrits sur le volume `blobs` (driver `fs`).
Pour utiliser un stockage objet S3-compatible :
```bash
# dans .env : STORAGE_DRIVER=s3  (+ S3_ACCESS_KEY / S3_SECRET_KEY / S3_BUCKET)
docker compose --profile s3 up -d --build
```
Le service `minio` n'a volontairement **aucun port publié** (pas d'exposition
publique). Pour créer le bucket une fois via la console web, ouvrez un tunnel
SSH depuis votre poste :
```bash
ssh -L 9001:localhost:9001 <user>@<vps>
# puis ouvrez http://localhost:9001 en local
```
L'API écrit/télécharge les blobs **en streaming** (multipart), sans les
bufferiser en mémoire — adapté aux fichiers volumineux. Les blobs restent du
chiffré E2E ; MinIO/S3 ne voit jamais de clair.

## Durcissement Phase 2 — livré (2026-07-11)
- ✅ **MFA (TOTP)**, **login sans oracle** (défi-réponse Ed25519),
  **rotation de clés à la révocation**, **quotas de stockage**,
  **rate-limiting** par route, **padding des tailles** (Padmé).
- Détail : [../DOCUMENTATION.md §6.7](../DOCUMENTATION.md#67-durcissement-drive-entreprise--phase-2-livré-2026-07-11).
- Reste : SSO/SCIM entreprise.
