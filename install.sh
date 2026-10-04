#!/usr/bin/env bash
# =============================================================================
# Elium — installateur & configurateur UNIQUE.
#
# Un seul fichier pour tout configurer et installer, sur un VPS comme en local :
#   • déployer le Drive entreprise (Docker) — VPS avec HTTPS auto, ou local ;
#   • lancer la suite bureautique dans le navigateur (sans Docker) ;
#   • se mettre à jour AUTOMATIQUEMENT (releases signées), sauvegarder, vérifier.
#
# Usage :
#   bash install.sh                     # menu interactif
#   bash install.sh drive --domain drive.exemple.fr --email vous@exemple.fr
#   bash install.sh drive --local       # Drive en local (http://localhost, sans TLS)
#   bash install.sh suite               # suite bureautique dans le navigateur
#   bash install.sh update | status | backup | help
#   bash install.sh auto-update on|off|status|now   # màj auto signées du serveur
#   bash install.sh self-update         # une passe de màj signée (appelée par le timer)
#   bash install.sh restore <timestamp> # restaure une sauvegarde de backups/
#
# Options de « drive » :
#   --domain <fqdn>     domaine public (HTTPS automatique via Caddy/Let's Encrypt)
#   --local             déploiement local sans TLS (SITE_ADDRESS=:80)
#   --email <email>     e-mail ACME (recommandé en prod)
#   --storage fs|s3     backend de blobs (défaut fs ; s3 = MinIO intégré)
#   --quota-gb <n>      (obsolète, ignoré) le quota se règle par organisation dans le Drive
#   --port <n>          port HTTP local en mode --local (défaut 80)
#   --yes               ne pose aucune question (automatisation/CI)
#   --dry-run           génère .env et s'arrête avant `docker compose up`
#
# La suite locale Windows reste distribuée en MSI (double-clic) — voir INSTALL.md.
# =============================================================================
set -euo pipefail

# --- Cadre ------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
ENV_FILE="$SCRIPT_DIR/.env"

bold=$'\033[1m'; dim=$'\033[2m'; grn=$'\033[32m'; ylw=$'\033[33m'; red=$'\033[31m'; cyn=$'\033[36m'; rst=$'\033[0m'
say()  { printf '%s\n' "$*"; }
info() { printf '%s➜%s %s\n' "$cyn" "$rst" "$*"; }
ok()   { printf '%s✓%s %s\n' "$grn" "$rst" "$*"; }
warn() { printf '%s!%s %s\n' "$ylw" "$rst" "$*"; }
die()  { printf '%s✗ %s%s\n' "$red" "$*" "$rst" >&2; exit 1; }
hr()   { printf '%s────────────────────────────────────────────────────────%s\n' "$dim" "$rst"; }

# =============================================================================
#  Auto-update du Drive (VPS) — racine de confiance : signature Ed25519.
#
#  Modèle identique à l'app de bureau (« push = publication ») : chaque version
#  publiée sur GitHub Releases porte un manifeste `latest.json` SIGNÉ (Ed25519).
#  Le VPS ne fait confiance QU'À cette signature — jamais au CDN/serveur : une
#  mise à jour n'est appliquée que si la signature du manifeste se vérifie avec
#  la clé publique embarquée ci-dessous (miroir de installer/updater.py), puis
#  la pile est reconstruite sur le commit EXACT signé, avec health-check et
#  rollback automatique en cas d'échec.
# =============================================================================
REPO_SLUG="eliumgame/elium-main"
# Clé publique de vérification (hex brut Ed25519, 32 octets) — MIROIR de
# installer/updater.py:UPDATE_PUBLIC_KEY_HEX. La clé privée est le secret CI
# UPDATE_SIGNING_KEY. Ne JAMAIS mettre la clé privée ici.
UPDATE_PUBLIC_KEY_HEX="137934bb39b4e6a7de258019fc980db1024bd6f5fa47e4f38bc8468c305dbbef"
MANIFEST_URL="https://github.com/${REPO_SLUG}/releases/latest/download/latest.json"
UPDATE_LOG="$SCRIPT_DIR/deploy/auto-update.log"
SYSTEMD_UNIT="elium-drive-update"

ulog() { printf '%s  %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >> "$UPDATE_LOG" 2>/dev/null || true; }

# Version applicative du checkout courant (source unique = src/elium/__init__.py).
repo_version() {
  sed -n 's/^__version__ *= *"\(.*\)"/\1/p' "$SCRIPT_DIR/src/elium/__init__.py" 2>/dev/null | head -n1
}

# Décode une chaîne hex (stdin ignoré ; $1) en octets bruts vers le fichier $2.
# NUL-safe (écriture directe, jamais via $(...)). Essaie xxd, puis perl, puis
# python3 — au moins un est présent sur tout VPS Linux réaliste.
_hex_to_file() {
  local hex="$1" out="$2"
  if command -v xxd >/dev/null 2>&1; then
    printf '%s' "$hex" | xxd -r -p > "$out"
  elif command -v perl >/dev/null 2>&1; then
    printf '%s' "$hex" | perl -ne 'chomp; print pack("H*", $_)' > "$out"
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c 'import sys,binascii;sys.stdout.buffer.write(binascii.unhexlify(sys.argv[1].strip()))' "$hex" > "$out"
  else
    return 1
  fi
}

# Vérifie la signature Ed25519 d'un manifeste. $1 = fichier manifeste, $2 =
# fichier signature (hex). Reconstruit une clé publique PEM à partir du hex brut
# (préfixe DER SubjectPublicKeyInfo Ed25519) puis vérifie via openssl (-rawin,
# Ed25519 étant un algorithme one-shot). Renvoie 0 si valide, 1 si invalide,
# 2 si l'outillage manque (openssl / décodeur hex).
verify_manifest_sig() {
  local manifest="$1" sigfile="$2" tmp rc sighex
  command -v openssl >/dev/null 2>&1 || return 2
  tmp="$(mktemp -d)" || return 2
  # Préfixe DER SPKI Ed25519 (12 octets) + les 32 octets de clé publique.
  if ! _hex_to_file "302a300506032b6570032100${UPDATE_PUBLIC_KEY_HEX}" "$tmp/pub.der"; then rm -rf "$tmp"; return 2; fi
  sighex="$(tr -d ' \t\r\n' < "$sigfile")"
  if ! _hex_to_file "$sighex" "$tmp/sig.bin"; then rm -rf "$tmp"; return 2; fi
  if ! openssl pkey -pubin -inform DER -in "$tmp/pub.der" -out "$tmp/pub.pem" 2>/dev/null; then rm -rf "$tmp"; return 2; fi
  if openssl pkeyutl -verify -pubin -inkey "$tmp/pub.pem" -rawin -in "$manifest" -sigfile "$tmp/sig.bin" >/dev/null 2>&1; then
    rc=0
  else
    rc=1
  fi
  rm -rf "$tmp"
  return "$rc"
}

# Extrait un champ chaîne du manifeste (json.dumps indent=2 -> un champ/ligne).
manifest_field() {
  sed -n "s/.*\"$2\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$1" 2>/dev/null | head -n1
}

# Renvoie 0 si $1 (version) est strictement supérieure à $2 (comparaison semver).
version_gt() {
  [ "$1" != "$2" ] || return 1
  [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -n1)" = "$1" ]
}

# Upsert d'une variable dans .env (préserve les droits 600).
set_env_var() {
  local key="$1" val="$2" tmpf
  [ -f "$ENV_FILE" ] || return 0
  if grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
    tmpf="$(mktemp)"
    sed "s|^${key}=.*|${key}=${val}|" "$ENV_FILE" > "$tmpf" && mv "$tmpf" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$val" >> "$ENV_FILE"
  fi
  chmod 600 "$ENV_FILE" 2>/dev/null || true
}

# Attend que l'API réponde /api/health (jusqu'à ~60 s). Renvoie 0 si saine.
wait_health() {
  for _ in $(seq 1 30); do
    if curl -fsS "http://localhost:8787/api/health" >/dev/null 2>&1 \
       || $DC exec -T api wget -qO- http://localhost:8787/api/health >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  return 1
}

# Dernière migration appliquée (table schema_migrations) : « version de schéma » à enregistrer
# avant une mise à jour pour savoir, au rollback, si des migrations ont tourné. Vide si illisible.
db_schema_version() {
  $DC exec -T db psql -U elium -d elium -Atc \
    "SELECT COALESCE(MAX(version), '') FROM schema_migrations" 2>/dev/null | tr -d '[:space:]' || true
}

# Sauvegarde de la base AVANT une mise à jour — OBLIGATOIRE : si elle échoue (pg_dump en erreur,
# fichier vide, pas d'espace disque), la mise à jour est ABANDONNÉE sans rien toucher. Le dump est
# « --clean --if-exists » : il peut être rejoué sur une base déjà migrée (rollback). Un fichier
# .meta voisin consigne version applicative, commit et version de schéma. Chemin du dump sur stdout.
# Fichier dédié « preupdate » pour ne pas se mêler aux sauvegardes manuelles.
backup_db_preupdate() {
  local ts out dump; ts="$(date -u '+%Y%m%d-%H%M%S')"; out="$SCRIPT_DIR/backups"
  mkdir -p "$out"
  dump="$out/elium-db-preupdate-$ts.sql.gz"
  # pipefail (set -o) : l'échec de pg_dump n'est pas masqué par gzip.
  if ! $DC exec -T db pg_dump -U elium --clean --if-exists elium 2>/dev/null | gzip > "$dump"; then
    rm -f "$dump"; return 1
  fi
  # gzip d'un dump vide pèse ~20 octets : un vrai dump contient au moins la création du schéma.
  if [ "$(gzip -dc "$dump" 2>/dev/null | wc -c)" -lt 200 ]; then rm -f "$dump"; return 1; fi
  {
    printf 'app_version=%s\n' "$(repo_version || true)"
    printf 'commit=%s\n' "$(git -C "$SCRIPT_DIR" rev-parse HEAD 2>/dev/null || true)"
    printf 'schema_version=%s\n' "$(db_schema_version)"
  } > "${dump%.sql.gz}.meta"
  printf '%s' "$dump"
}

# Rejoue un dump `--clean` sur la base courante (api arrêtée le temps de l'opération).
restore_db_dump() {
  local dump="$1"
  $DC stop api >/dev/null 2>&1 || true
  gzip -dc "$dump" | $DC exec -T db psql -U elium -d elium -v ON_ERROR_STOP=1 >/dev/null
}

# Ajoute à .env les secrets introduits par les versions récentes (REDIS_PASSWORD) sans toucher aux
# existants : une pile déployée avant leur introduction continue de démarrer (compose exige ces
# secrets, il n'y a plus de valeur par défaut).
ensure_env_secrets() {
  [ -f "$ENV_FILE" ] || return 0
  if [ -z "$(read_env REDIS_PASSWORD)" ]; then
    set_env_var REDIS_PASSWORD "$(gen_secret)"
    info "REDIS_PASSWORD généré et ajouté à .env (Redis est désormais protégé par mot de passe)."
  fi
  if [ -z "$(read_env CORS_ORIGINS)" ]; then
    warn "CORS_ORIGINS absent de .env : renseignez l'origine de votre site (ex. https://drive.exemple.fr)."
  fi
}

# Copie hors machine (rclone) : BACKUP_RCLONE_REMOTE=<remote>:<chemin> (ex. s3backup:elium-prod ou
# sftp:/srv/backups). Les fichiers sont déjà du chiffré E2E (zéro-connaissance) ; on ne chiffre
# pas davantage ici, mais le remote devrait l'être (rclone crypt) pour les métadonnées.
offsite_push() {
  local remote; remote="${BACKUP_RCLONE_REMOTE:-$(read_env BACKUP_RCLONE_REMOTE)}"
  [ -n "$remote" ] || return 0
  if ! command -v rclone >/dev/null 2>&1; then
    warn "BACKUP_RCLONE_REMOTE défini mais rclone est introuvable : copie hors machine IGNORÉE."; return 1
  fi
  info "Copie hors machine vers $remote…"
  if rclone copy "$SCRIPT_DIR/backups" "$remote" --include "elium-*-$1.*" >/dev/null 2>&1; then
    ok "Sauvegarde copiée vers $remote."
  else
    warn "Copie hors machine ÉCHOUÉE vers $remote (la sauvegarde locale reste valide)."; return 1
  fi
}

# Ne conserve que les 5 dernières sauvegardes pré-mise-à-jour.
prune_update_backups() {
  local out="$SCRIPT_DIR/backups"
  [ -d "$out" ] || return 0
  # shellcheck disable=SC2012
  ls -1t "$out"/elium-db-preupdate-*.sql.gz 2>/dev/null | tail -n +6 | while read -r f; do rm -f "$f"; done
  return 0
}

# Démarre la pile : avec des images SIGNÉES épinglées par digest (ELIUM_API_IMAGE / ELIUM_WEB_IMAGE
# dans .env, écrites par l'auto-update d'après le manifeste signé) on les TIRE sans rien construire
# sur le serveur ; sinon (premier déploiement, manifeste ancien) on construit sur place.
compose_up_stack() {
  local profile=(); [ "$(read_env STORAGE_DRIVER)" = "s3" ] && profile=(--profile s3)
  if [ -n "$(read_env ELIUM_API_IMAGE)" ] && [ -n "$(read_env ELIUM_WEB_IMAGE)" ]; then
    $DC "${profile[@]}" pull api web && $DC "${profile[@]}" up -d --no-build
  else
    $DC "${profile[@]}" up -d --build
  fi
}

# Vérifie la signature cosign (keyless, identité du workflow de publication) d'une image si cosign
# est installé ; sans cosign, le digest signé dans le manifeste Ed25519 reste la garantie.
verify_image_cosign() {
  local ref="$1"
  command -v cosign >/dev/null 2>&1 || return 0
  cosign verify "$ref" \
    --certificate-identity-regexp "^https://github.com/${REPO_SLUG}/\\.github/workflows/release\\.yml@" \
    --certificate-oidc-issuer "https://token.actions.githubusercontent.com" >/dev/null 2>&1
}

# --- Détection Docker Compose ----------------------------------------------
DC=""
detect_compose() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    DC="docker compose"
  elif command -v docker-compose >/dev/null 2>&1; then
    DC="docker-compose"
  fi
}

# --- Génération de secrets (plusieurs fallbacks) ---------------------------
gen_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 48 | tr -d '/+=\n' | cut -c1-48
  elif command -v node >/dev/null 2>&1; then
    node -e "process.stdout.write(require('crypto').randomBytes(48).toString('base64url'))"
  elif [ -r /dev/urandom ]; then
    LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 48
  else
    die "Aucun générateur d'aléa disponible (openssl, node ou /dev/urandom requis)."
  fi
}

# Lit une valeur d'un .env existant (pour préserver les secrets au re-run).
read_env() {
  local key="$1"
  [ -f "$ENV_FILE" ] || return 0
  sed -n "s/^${key}=//p" "$ENV_FILE" | head -n1
}

prompt() {
  # prompt "Question" "défaut" -> réponse (défaut si vide ou --yes)
  local q="$1" def="${2:-}" ans=""
  if [ "$ASSUME_YES" = "1" ]; then printf '%s' "$def"; return 0; fi
  if [ -n "$def" ]; then printf '%s%s%s [%s] : ' "$bold" "$q" "$rst" "$def" >&2
  else printf '%s%s%s : ' "$bold" "$q" "$rst" >&2; fi
  read -r ans || true
  printf '%s' "${ans:-$def}"
}

# --- Arguments --------------------------------------------------------------
CMD="${1:-menu}"; [ $# -gt 0 ] && shift || true
DOMAIN=""; LOCAL=0; EMAIL=""; STORAGE="fs"; HTTP_PORT="80"
ASSUME_YES=0; DRY_RUN=0; ARG1=""
while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --local) LOCAL=1; shift ;;
    --email) EMAIL="${2:-}"; shift 2 ;;
    --storage) STORAGE="${2:-fs}"; shift 2 ;;
    --quota-gb) warn "--quota-gb est obsolète et ignoré : le quota se règle par organisation (PATCH /orgs/:id/quota, ou l'interface d'administration du Drive)."; shift 2 ;;
    --port) HTTP_PORT="${2:-80}"; shift 2 ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) CMD="help"; shift ;;
    -*) warn "Option inconnue ignorée : $1"; shift ;;
    # Positional argument (e.g. the <timestamp> for `restore`).
    *) ARG1="$1"; shift ;;
  esac
done

# =============================================================================
#  Déploiement du Drive entreprise
# =============================================================================
deploy_drive() {
  detect_compose
  if [ "$DRY_RUN" != "1" ]; then
    [ -n "$DC" ] || die "Docker + Docker Compose v2 requis. Installez Docker puis relancez (voir INSTALL.md)."
    docker info >/dev/null 2>&1 || die "Le démon Docker ne répond pas (démarrez Docker / vérifiez les droits)."
  fi

  hr; info "Configuration du Drive entreprise"

  # Domaine / mode local
  if [ "$LOCAL" != "1" ] && [ -z "$DOMAIN" ]; then
    local existing default_domain; existing="$(read_env SITE_ADDRESS)"
    # SITE_ADDRESS=":PORT" is the marker a previous `--local` run wrote; it is
    # not a real domain, so default to empty here rather than leaking the raw
    # port into the "Domaine public" prompt (which would otherwise be accepted
    # as a literal domain, pushing a re-run into PRODUCTION mode with Caddy
    # trying to get a Let's Encrypt certificate for e.g. "80").
    # NB: a plain `${existing#:*}`/`${existing#:}` prefix-strip does NOT work
    # here — bash's shortest-match `#` removes only the leading ":" either
    # way, leaving the port digits (e.g. "80") behind. A `case` match is
    # needed to drop the whole marker.
    case "$existing" in
      :*) default_domain="" ;;
      *)  default_domain="$existing" ;;
    esac
    DOMAIN="$(prompt "Domaine public (vide = local sans TLS)" "$default_domain")"
  fi
  local site cors origin
  if [ "$LOCAL" = "1" ] || [ -z "$DOMAIN" ]; then
    site=":${HTTP_PORT}"
    if [ "$HTTP_PORT" = "80" ]; then origin="http://localhost"; cors="http://localhost,http://127.0.0.1"
    else origin="http://localhost:${HTTP_PORT}"; cors="$origin,http://localhost,http://127.0.0.1"; fi
    info "Mode LOCAL — pas de TLS (accès via $origin)"
  else
    site="$DOMAIN"; origin="https://$DOMAIN"; cors="$origin"
    ok "Mode PRODUCTION — HTTPS automatique pour $bold$DOMAIN$rst (le domaine doit pointer vers ce serveur)"
    [ -z "$EMAIL" ] && EMAIL="$(prompt "E-mail pour Let's Encrypt (recommandé)" "")"
  fi

  # Stockage
  if [ "$ASSUME_YES" != "1" ]; then
    STORAGE="$(prompt "Stockage des blobs : fs (volume) ou s3 (MinIO)" "$STORAGE")"
  fi
  [ "$STORAGE" = "s3" ] || [ "$STORAGE" = "fs" ] || die "Stockage invalide : $STORAGE (attendu fs ou s3)."

  # Secrets : PRÉSERVÉS s'ils existent déjà (rotation = perte des sessions + MFA)
  local token pgpw s3key s3secret
  token="$(read_env TOKEN_SECRET)";        [ -n "$token" ]    || token="$(gen_secret)"
  pgpw="$(read_env POSTGRES_PASSWORD)";     [ -n "$pgpw" ]     || pgpw="$(gen_secret)"
  s3key="$(read_env S3_ACCESS_KEY)";        [ -n "$s3key" ]    || s3key="elium"
  s3secret="$(read_env S3_SECRET_KEY)";     [ -n "$s3secret" ] || s3secret="$(gen_secret)"
  local redispw; redispw="$(read_env REDIS_PASSWORD)"; [ -n "$redispw" ] || redispw="$(gen_secret)"
  # Réglages optionnels préservés d'un run à l'autre (images signées, copie hors machine).
  local keep_api keep_web keep_rclone
  keep_api="$(read_env ELIUM_API_IMAGE)"; keep_web="$(read_env ELIUM_WEB_IMAGE)"; keep_rclone="$(read_env BACKUP_RCLONE_REMOTE)"
  if [ -f "$ENV_FILE" ]; then ok "Secrets existants préservés (.env conservé)"; fi

  # Écriture du .env
  {
    echo "# Généré par install.sh le $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    echo "# NE PAS COMMITER. Sauvegardez TOKEN_SECRET : le perdre invalide les"
    echo "# sessions et les secrets MFA (mais PAS les données, chiffrées côté client)."
    echo "SITE_ADDRESS=$site"
    [ -n "$EMAIL" ] && echo "ACME_EMAIL=$EMAIL"
    echo "TOKEN_SECRET=$token"
    echo "POSTGRES_PASSWORD=$pgpw"
    echo "CORS_ORIGINS=$cors"
    echo "ELIUM_VERSION=$(repo_version)"
    echo "STORAGE_DRIVER=$STORAGE"
    echo "S3_ACCESS_KEY=$s3key"
    echo "S3_SECRET_KEY=$s3secret"
    echo "S3_BUCKET=$(read_env S3_BUCKET || true)"
    echo "REDIS_PASSWORD=$redispw"
    [ -n "$keep_api" ] && echo "ELIUM_API_IMAGE=$keep_api"
    [ -n "$keep_web" ] && echo "ELIUM_WEB_IMAGE=$keep_web"
    [ -n "$keep_rclone" ] && echo "BACKUP_RCLONE_REMOTE=$keep_rclone"
    true
  } > "$ENV_FILE.tmp"
  # remplace la ligne bucket vide par la valeur par défaut
  sed -i.bak 's/^S3_BUCKET=$/S3_BUCKET=elium-blobs/' "$ENV_FILE.tmp" 2>/dev/null || true
  rm -f "$ENV_FILE.tmp.bak"
  mv "$ENV_FILE.tmp" "$ENV_FILE"
  chmod 600 "$ENV_FILE" 2>/dev/null || true
  ok "Configuration écrite dans .env (droits 600)"

  if [ "$DRY_RUN" = "1" ]; then
    warn "--dry-run : arrêt avant le lancement. Vérifiez .env puis relancez sans --dry-run."
    return 0
  fi

  # Lancement
  hr; info "Construction et démarrage de la pile Docker (peut prendre quelques minutes)…"
  compose_up_stack

  # Santé
  info "Vérification de l'état de l'API…"
  local healthy=0
  for _ in $(seq 1 30); do
    if curl -fsS "http://localhost:8787/api/health" >/dev/null 2>&1 \
       || $DC exec -T api wget -qO- http://localhost:8787/api/health >/dev/null 2>&1; then
      healthy=1; break
    fi
    sleep 2
  done
  hr
  if [ "$healthy" = "1" ]; then ok "API en bonne santé (migrations appliquées automatiquement)."
  else warn "L'API n'a pas répondu au health-check à temps — voir : $DC logs api"; fi

  say ""
  ok "${bold}Elium Drive déployé.${rst}"
  say "  • Accès        : $bold$origin$rst"
  say "  • État         : bash install.sh status"
  say "  • Journaux     : $DC logs -f api"
  # MinIO n'a volontairement AUCUN port publié (docker-compose.yml) : la
  # console n'est joignable que via un tunnel SSH, jamais exposée publiquement.
  [ "$STORAGE" = "s3" ] && say "  • Stockage S3  : bucket ${bold}$(read_env S3_BUCKET)${rst} créé automatiquement au démarrage (aucune étape manuelle). Console MinIO non exposée — tunnel d'inspection : ${bold}ssh -L 9001:localhost:9001 <user>@<vps>${rst} puis http://localhost:9001"
  say ""
  say "  Prochaine étape : ouvrez $origin, créez le 1er compte (= propriétaire),"
  say "  puis votre organisation. Activez la 2FA dans l'onglet ${bold}Sécurité${rst}."
  if [ "$LOCAL" = "1" ] || [ -z "$DOMAIN" ]; then
    say "  Depuis l'app de bureau : bouton ${bold}Serveur${rst} → $origin/api"
  else
    say "  Depuis l'app de bureau : bouton ${bold}Serveur${rst} → $origin/api"
  fi

  # --- Mises à jour automatiques du serveur -------------------------------
  # Le Drive se maintient à jour tout seul depuis les GitHub Releases signées
  # (même modèle que l'app de bureau). Activation par défaut en production
  # (mode --yes inclus) ; le local peut s'en passer.
  say ""
  local want_auto="o"
  if [ "$LOCAL" = "1" ] || [ -z "$DOMAIN" ]; then
    want_auto="$(prompt "Activer les mises à jour automatiques du serveur ? (o/N)" "n")"
  else
    want_auto="$(prompt "Activer les mises à jour automatiques du serveur (recommandé) ? (O/n)" "o")"
  fi
  case "$want_auto" in
    o|O|oui|y|Y|yes)
      # En mode --yes sans root ni sudo non-interactif, ne PAS tenter d'activer
      # (sudo bloquerait sur une invite de mot de passe en CI/automatisation).
      if [ "$ASSUME_YES" = "1" ] && [ "$(id -u)" != "0" ] && ! sudo -n true 2>/dev/null; then
        warn "Auto-update non activée (mode --yes sans root/sudo). Activez-la avec : bash install.sh auto-update on"
      elif auto_update_enable; then :; else
        warn "Activation de l'auto-update ignorée (droits ? systemd/cron ?). Vous pourrez lancer : bash install.sh auto-update on"
      fi ;;
    *)
      say "  ${dim}Auto-update non activée. Pour l'activer plus tard : ${bold}bash install.sh auto-update on${rst}${dim} (ou mise à jour manuelle : bash install.sh update).${rst}" ;;
  esac
}

# =============================================================================
#  Suite bureautique dans le navigateur (sans Docker)
# =============================================================================
run_suite() {
  command -v node >/dev/null 2>&1 || die "Node.js 20+ requis pour la suite web. Voir INSTALL.md."
  info "Installation des dépendances de la suite (web-studio)…"
  ( cd web-studio && npm ci --no-audit --no-fund )
  info "Construction…"
  ( cd web-studio && npm run build )
  ok "Suite construite. Lancement de l'aperçu sur http://localhost:3100 (Ctrl+C pour arrêter)."
  say "  ${dim}(La suite bureautique fonctionne 100 % en local ; le Drive entreprise, lui, nécessite « bash install.sh drive ».)${rst}"
  ( cd web-studio && npm run preview -- --port 3100 --host )
}

# =============================================================================
#  Mise à jour / état / sauvegarde
# =============================================================================
do_update() {
  detect_compose; [ -n "$DC" ] || die "Docker Compose requis."
  [ -f "$ENV_FILE" ] || die "Aucun .env — lancez d'abord : bash install.sh drive"
  if command -v git >/dev/null 2>&1 && [ -d .git ]; then
    info "git pull…"; git pull --ff-only || warn "git pull ignoré (arbre modifié ou hors dépôt)."
  fi
  ensure_env_secrets
  # Les sauvegardes comptent : pas de mise à jour manuelle sans filet non plus.
  local dump; dump="$(backup_db_preupdate)" || die "Sauvegarde de la base impossible — mise à jour ABANDONNÉE (la pile n'a pas été redémarrée)."
  ok "Base sauvegardée avant mise à jour : $dump"
  info "Reconstruction + redémarrage…"
  compose_up_stack
  set_env_var ELIUM_VERSION "$(repo_version)"
  ok "Pile mise à jour (migrations ré-appliquées, idempotentes)."
}

# =============================================================================
#  Auto-update SIGNÉE (appelée par le timer systemd / cron, ou à la main)
# =============================================================================
# Vérifie le manifeste signé, et si une version plus récente existe : bascule
# sur le commit EXACT signé, reconstruit la pile, health-check, et ROLLBACK
# automatique en cas d'échec. Conçue pour être « silencieuse » (retour 0) sur
# les aléas réseau afin de ne pas faire échouer le timer ; ne refuse (die) que
# sur une signature invalide ou un rollback impossible.
do_self_update() {
  if [ "${ELIUM_NO_UPDATE:-0}" = "1" ]; then info "Auto-update désactivé (ELIUM_NO_UPDATE=1)."; return 0; fi
  detect_compose; [ -n "$DC" ] || { warn "Docker Compose absent — auto-update ignoré."; return 0; }
  [ -f "$ENV_FILE" ] || { warn "Aucun .env — rien à mettre à jour."; return 0; }
  command -v curl >/dev/null 2>&1     || { warn "curl requis pour l'auto-update."; return 0; }
  command -v openssl >/dev/null 2>&1  || die "openssl requis (vérification de signature)."
  { command -v git >/dev/null 2>&1 && [ -d "$SCRIPT_DIR/.git" ]; } \
    || die "Auto-update requiert un dépôt git (clonez le dépôt plutôt qu'un tarball)."

  local tmp; tmp="$(mktemp -d)" || return 0
  # shellcheck disable=SC2064
  trap "rm -rf '$tmp'" RETURN

  info "Recherche d'une mise à jour signée…"
  if ! curl -fsSL "$MANIFEST_URL" -o "$tmp/latest.json" 2>/dev/null; then
    ulog "check: manifeste injoignable"; warn "Manifeste injoignable — nouvel essai au prochain cycle."; return 0
  fi
  if ! curl -fsSL "${MANIFEST_URL}.sig" -o "$tmp/latest.json.sig" 2>/dev/null; then
    ulog "check: signature injoignable"; warn "Signature injoignable — abandon."; return 0
  fi

  # `|| vrc=$?` : capturer le code SANS déclencher `set -e` (un appel nu
  # sortirait le script avant le `case`, court-circuitant le die de sécurité).
  local vrc=0
  verify_manifest_sig "$tmp/latest.json" "$tmp/latest.json.sig" || vrc=$?
  case "$vrc" in
    0) : ;;  # signature valide
    2) die "Outillage de vérification manquant (openssl + xxd/perl/python3)." ;;
    *) ulog "check: SIGNATURE INVALIDE — rejeté"; die "Signature du manifeste invalide — mise à jour refusée." ;;
  esac

  local remote_ver commit cur_ver
  remote_ver="$(manifest_field "$tmp/latest.json" version || true)"
  commit="$(manifest_field "$tmp/latest.json" commit || true)"
  cur_ver="$(repo_version || true)"
  [ -n "$remote_ver" ] || { warn "Version absente du manifeste."; return 0; }

  if ! version_gt "$remote_ver" "$cur_ver"; then
    ok "Déjà à jour (déployé ${cur_ver:-?}, publié $remote_ver)."; ulog "up-to-date (${cur_ver:-?} >= $remote_ver)"; return 0
  fi
  hr; info "Mise à jour disponible : ${bold}${cur_ver:-?} → $remote_ver${rst}"
  ulog "available ${cur_ver:-?} -> $remote_ver (commit ${commit:-<tag>})"

  # Ne JAMAIS écraser des modifications locales de l'opérateur (fichiers suivis).
  if ! git -C "$SCRIPT_DIR" diff --quiet 2>/dev/null || ! git -C "$SCRIPT_DIR" diff --cached --quiet 2>/dev/null; then
    warn "Arbre git modifié localement — auto-update ignoré (faites 'bash install.sh update' manuellement)."
    ulog "skip: dirty worktree"; return 0
  fi

  # Récupère la référence puis résout le commit EXACT à déployer : d'abord le
  # champ signé `commit`, sinon (manifeste plus ancien) le tag de la version.
  if ! git -C "$SCRIPT_DIR" fetch --quiet --tags origin 2>/dev/null; then
    warn "git fetch a échoué — réseau ? nouvel essai plus tard."; ulog "skip: fetch failed"; return 0
  fi
  local target=""
  if [ -n "$commit" ] && git -C "$SCRIPT_DIR" cat-file -e "${commit}^{commit}" 2>/dev/null; then
    target="$commit"
  elif git -C "$SCRIPT_DIR" rev-parse -q --verify "refs/tags/v${remote_ver}^{commit}" >/dev/null 2>&1; then
    target="$(git -C "$SCRIPT_DIR" rev-parse "refs/tags/v${remote_ver}^{commit}")"
  else
    warn "Commit/tag de la version $remote_ver introuvable après fetch."; ulog "skip: target unresolved"; return 0
  fi

  # Sécurité défense-en-profondeur : le commit cible DOIT être contenu dans
  # origin/master (pas une branche/ref arbitraire poussée par erreur).
  if git -C "$SCRIPT_DIR" rev-parse -q --verify origin/master >/dev/null 2>&1; then
    if ! git -C "$SCRIPT_DIR" merge-base --is-ancestor "$target" origin/master 2>/dev/null; then
      warn "Commit cible hors de origin/master — refus (sécurité)."; ulog "skip: target not on master ($target)"; return 0
    fi
  fi

  local prev; prev="$(git -C "$SCRIPT_DIR" rev-parse HEAD)"

  # Images signées : le manifeste (signé Ed25519) porte les références épinglées par digest des
  # images construites et signées (cosign) par le workflow de publication. Absentes (manifeste
  # ancien) => construction sur place, comme avant.
  local new_api new_web old_api old_web
  new_api="$(manifest_field "$tmp/latest.json" serverImage || true)"
  new_web="$(manifest_field "$tmp/latest.json" webImage || true)"
  old_api="$(read_env ELIUM_API_IMAGE)"; old_web="$(read_env ELIUM_WEB_IMAGE)"
  if [ -n "$new_api" ] && [ -n "$new_web" ]; then
    case "$new_api$new_web" in
      ghcr.io/*@sha256:*ghcr.io/*@sha256:*) : ;;
      *) warn "Références d'images invalides dans le manifeste — abandon."; ulog "skip: bad image refs"; return 0 ;;
    esac
    if ! verify_image_cosign "$new_api" || ! verify_image_cosign "$new_web"; then
      warn "Signature cosign des images invalide — abandon (sécurité)."; ulog "skip: cosign verification failed"; return 0
    fi
  fi

  # Sauvegarde OBLIGATOIRE : si elle échoue, on s'arrête AVANT toute modification.
  info "Sauvegarde de la base avant migration…"
  local dump schema_before schema_after
  if ! dump="$(backup_db_preupdate)"; then
    warn "Sauvegarde de la base IMPOSSIBLE — mise à jour ABANDONNÉE (rien n'a été modifié)."
    ulog "ABORT: pre-update backup failed (no change made)"
    return 1
  fi
  schema_before="$(sed -n 's/^schema_version=//p' "${dump%.sql.gz}.meta" | head -n1)"
  ulog "backup ok: $dump (schema ${schema_before:-?})"

  info "Bascule sur $remote_ver ($(printf '%.12s' "$target"))…"
  git -C "$SCRIPT_DIR" checkout -q master 2>/dev/null || true
  if ! git -C "$SCRIPT_DIR" reset --hard -q "$target" 2>/dev/null; then
    warn "Bascule git échouée."; ulog "fail: reset $target"; return 0
  fi
  set_env_var ELIUM_VERSION "$remote_ver"
  ensure_env_secrets
  if [ -n "$new_api" ] && [ -n "$new_web" ]; then
    set_env_var ELIUM_API_IMAGE "$new_api"; set_env_var ELIUM_WEB_IMAGE "$new_web"
  fi

  info "Redémarrage de la pile…"
  if compose_up_stack && wait_health; then
    hr; ok "${bold}Mise à jour appliquée : $remote_ver.${rst} (migrations idempotentes rejouées)"
    ulog "success -> $remote_ver ($target)"
    prune_update_backups
    return 0
  fi

  # ---------- Rollback automatique ----------
  hr; warn "Health-check en échec après mise à jour — RETOUR à ${cur_ver:-la version précédente}."
  ulog "health failed after $remote_ver -> rollback to $prev"
  schema_after="$(db_schema_version)"
  git -C "$SCRIPT_DIR" reset --hard -q "$prev" 2>/dev/null || true
  set_env_var ELIUM_VERSION "${cur_ver:-dev}"
  # Images précédentes (digest) ou construction locale si on n'en utilisait pas.
  if [ -n "$old_api" ] && [ -n "$old_web" ]; then
    set_env_var ELIUM_API_IMAGE "$old_api"; set_env_var ELIUM_WEB_IMAGE "$old_web"
  else
    set_env_var ELIUM_API_IMAGE ""; set_env_var ELIUM_WEB_IMAGE ""
  fi
  # Des migrations ont tourné (la version de schéma a bougé) : le code précédent ne sait pas lire
  # le nouveau schéma — on restaure AUSSI la base depuis le dump pris juste avant.
  if [ -n "$schema_after" ] && [ "$schema_after" != "$schema_before" ]; then
    warn "Des migrations avaient été appliquées (${schema_before:-?} → $schema_after) : restauration de la base."
    ulog "restoring DB from $dump (schema $schema_after -> ${schema_before:-?})"
    if ! restore_db_dump "$dump"; then
      ulog "DB RESTORE FAILED — manual intervention required (dump: $dump)"
      die "Restauration de la base en échec — intervention requise. Dump : $dump (voir $UPDATE_LOG)"
    fi
  fi
  if compose_up_stack && wait_health; then
    warn "Rollback réussi — ${cur_ver:-version précédente} rétablie. Détails : $UPDATE_LOG"
    ulog "rollback ok -> ${cur_ver:-?}"
    return 0
  fi
  ulog "ROLLBACK FAILED — manual intervention required"
  die "Rollback en échec — intervention requise. Voir $UPDATE_LOG et : $DC logs api"
}

# =============================================================================
#  Gestion de l'auto-update planifiée (systemd timer, repli cron)
# =============================================================================
do_auto_update() {
  local action="${1:-$ARG1}"; [ -n "$action" ] || action="status"
  case "$action" in
    on|enable)   auto_update_enable ;;
    off|disable) auto_update_disable ;;
    now|run)     do_self_update ;;
    status)      auto_update_status ;;
    *) die "Usage : bash install.sh auto-update on|off|status|now" ;;
  esac
}

_have_systemd() { command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; }

# `sudo` seulement si nécessaire (root n'en a pas besoin).
_sudo() { if [ "$(id -u)" = "0" ]; then "$@"; else sudo "$@"; fi; }

auto_update_enable() {
  local interval; interval="$(read_env UPDATE_INTERVAL_MIN)"; [ -n "$interval" ] || interval="30"
  if _have_systemd; then
    info "Installation du timer systemd ($SYSTEMD_UNIT, toutes les ${interval} min)…"
    # Utilisateur d'exécution : PLUS root. Le propriétaire du dépôt s'il n'est pas root, sinon un
    # compte système dédié `elium-update` (membre du groupe docker, propriétaire du dépôt).
    # Le groupe docker équivaut à un accès root à la machine : le gain est de ne pas exécuter
    # git/openssl/curl (surface réseau) en root, et d'enfermer le service (voir les options ci-dessous).
    local run_user; run_user="$(stat -c '%U' "$SCRIPT_DIR" 2>/dev/null || echo root)"
    if [ "$run_user" = "root" ]; then
      run_user="elium-update"
      if ! id "$run_user" >/dev/null 2>&1; then
        _sudo useradd --system --home-dir "$SCRIPT_DIR" --no-create-home --shell /usr/sbin/nologin "$run_user"
      fi
      _sudo chown -R "$run_user":"$run_user" "$SCRIPT_DIR"
    fi
    if getent group docker >/dev/null 2>&1; then _sudo usermod -aG docker "$run_user" || true
    else warn "Groupe docker introuvable : l'utilisateur $run_user ne pourra peut-être pas piloter Docker."; fi
    _sudo tee "/etc/systemd/system/${SYSTEMD_UNIT}.service" >/dev/null <<EOF
[Unit]
Description=Elium Drive — mise à jour automatique (signée Ed25519)
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=${run_user}
SupplementaryGroups=docker
WorkingDirectory=${SCRIPT_DIR}
ExecStart=/usr/bin/env bash ${SCRIPT_DIR}/install.sh self-update
Nice=10
# Durcissement : aucun privilège supplémentaire, /usr et /etc en lecture seule, /tmp privé,
# noyau et modules inaccessibles. (ProtectSystem=strict est évité : il pourrait gêner l'accès à la
# socket Docker et à l'écriture de backups/ selon les installations.)
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
RestrictRealtime=true
EOF
    _sudo tee "/etc/systemd/system/${SYSTEMD_UNIT}.timer" >/dev/null <<EOF
[Unit]
Description=Elium Drive — planification de l'auto-update

[Timer]
OnBootSec=5min
OnUnitActiveSec=${interval}min
RandomizedDelaySec=5min
Persistent=true

[Install]
WantedBy=timers.target
EOF
    _sudo systemctl daemon-reload
    _sudo systemctl enable --now "${SYSTEMD_UNIT}.timer"
    ok "Auto-update ACTIVÉE (systemd). Vérif immédiate en arrière-plan possible : bash install.sh auto-update now"
    say "  • État   : bash install.sh auto-update status"
    say "  • Journal: $UPDATE_LOG"
  else
    # Repli cron.
    local line="*/${interval} * * * * cd ${SCRIPT_DIR} && /usr/bin/env bash ${SCRIPT_DIR}/install.sh self-update >> ${UPDATE_LOG} 2>&1"
    info "systemd absent — installation d'une tâche cron (toutes les ${interval} min)…"
    ( crontab -l 2>/dev/null | grep -v "install.sh self-update"; echo "$line" ) | crontab -
    ok "Auto-update ACTIVÉE (cron). Journal : $UPDATE_LOG"
  fi
}

auto_update_disable() {
  if _have_systemd && systemctl list-unit-files 2>/dev/null | grep -q "^${SYSTEMD_UNIT}.timer"; then
    _sudo systemctl disable --now "${SYSTEMD_UNIT}.timer" 2>/dev/null || true
    ok "Auto-update DÉSACTIVÉE (timer systemd arrêté)."
  fi
  if crontab -l 2>/dev/null | grep -q "install.sh self-update"; then
    ( crontab -l 2>/dev/null | grep -v "install.sh self-update" ) | crontab -
    ok "Auto-update DÉSACTIVÉE (tâche cron retirée)."
  fi
  if ! _have_systemd && ! crontab -l 2>/dev/null | grep -q "install.sh self-update"; then
    warn "Aucune planification d'auto-update trouvée."
  fi
}

auto_update_status() {
  hr; info "Auto-update — état"
  say "  • Version déployée : ${bold}$(repo_version)${rst}"
  if _have_systemd && systemctl list-unit-files 2>/dev/null | grep -q "^${SYSTEMD_UNIT}.timer"; then
    say "  • Planification    : systemd (${SYSTEMD_UNIT}.timer)"
    systemctl is-enabled "${SYSTEMD_UNIT}.timer" >/dev/null 2>&1 && ok "timer activé" || warn "timer présent mais désactivé"
    systemctl list-timers "${SYSTEMD_UNIT}.timer" --no-pager 2>/dev/null | sed -n '1,3p' || true
  elif crontab -l 2>/dev/null | grep -q "install.sh self-update"; then
    say "  • Planification    : cron"
    crontab -l 2>/dev/null | grep "install.sh self-update" | sed 's/^/      /'
  else
    warn "Auto-update NON planifiée. Activez : bash install.sh auto-update on"
  fi
  if [ -f "$UPDATE_LOG" ]; then
    hr; say "  Dernières lignes du journal ($UPDATE_LOG) :"
    tail -n 8 "$UPDATE_LOG" 2>/dev/null | sed 's/^/    /'
  fi
}

do_status() {
  detect_compose; [ -n "$DC" ] || die "Docker Compose requis."
  $DC ps || true
  hr
  if curl -fsS "http://localhost:8787/api/health" 2>/dev/null; then say ""; ok "API joignable en local (port 8787)."
  else warn "API non joignable directement (normal si seul Caddy est exposé) — testez via votre domaine."; fi
}

# Détecte comment sont stockés les blobs, quel que soit le driver :
#   fs          -> volume Docker `blobs` (monté /data/blobs dans api)
#   s3-minio    -> MinIO intégré (volume `miniodata`, /data)
#   s3-external -> S3 distant (AWS…), hors de portée d'un tar local
blob_backend() {
  local driver endpoint
  driver="$(read_env STORAGE_DRIVER)"; [ -n "$driver" ] || driver="fs"
  if [ "$driver" != "s3" ]; then echo "fs"; return 0; fi
  endpoint="$(read_env S3_ENDPOINT)"
  case "$endpoint" in
    ""|*minio*) echo "s3-minio" ;;
    *)          echo "s3-external" ;;
  esac
}

do_backup() {
  detect_compose; [ -n "$DC" ] || die "Docker Compose requis."
  local ts out backend; ts="$(date -u '+%Y%m%d-%H%M%S')"; out="$SCRIPT_DIR/backups"
  mkdir -p "$out"
  backend="$(blob_backend)"

  info "Sauvegarde Postgres…"
  $DC exec -T db pg_dump -U elium --clean --if-exists elium | gzip > "$out/elium-db-$ts.sql.gz"

  case "$backend" in
    s3-minio)
      info "Sauvegarde des blobs chiffrés (MinIO intégré)…"
      # tar de tout le volume de données MinIO (buckets + métadonnées) ; live OK
      # (les blobs sont immuables, écrits une fois sous une clé aléatoire).
      $DC --profile s3 exec -T minio sh -c 'cd /data && tar czf - .' > "$out/elium-blobs-$ts.tar.gz" ;;
    s3-external)
      warn "Stockage S3 EXTERNE : les blobs vivent hors de ce serveur — sauvegardez le bucket côté fournisseur."
      warn "La base (clés emballées + métadonnées, chiffrées E2E) est bien sauvegardée ici."
      : > "$out/elium-blobs-$ts.tar.gz" ;;  # marqueur vide (garde la paire db+blobs cohérente)
    *)
      info "Sauvegarde des blobs chiffrés (volume fs)…"
      $DC run --rm -T -v "$out:/backup" api sh -c 'cd /data && tar czf - blobs' > "$out/elium-blobs-$ts.tar.gz" 2>/dev/null \
        || $DC exec -T api sh -c 'cd /data && tar czf - blobs' > "$out/elium-blobs-$ts.tar.gz" ;;
  esac
  # Marqueur : indique à `restore` OÙ replacer les blobs (le format interne de
  # l'archive diffère selon le backend). Absent ⇒ restauration en mode `fs`.
  printf 'backend=%s\n' "$backend" > "$out/elium-blobs-$ts.meta"

  ok "Sauvegardes écrites dans $out (base + blobs, chiffrés E2E ; backend : $backend)."
  # Copie hors machine optionnelle (BACKUP_RCLONE_REMOTE=<remote>:<chemin> dans .env).
  offsite_push "$ts" || true
  warn "Conservez-les sur un support chiffré. Sans les clés côté clients, elles restent illisibles (zéro-connaissance)."
}

do_restore() {
  detect_compose; [ -n "$DC" ] || die "Docker Compose requis."
  local out="$SCRIPT_DIR/backups"
  local ts="${1:-$ARG1}"

  if [ -z "$ts" ] && [ "$ASSUME_YES" != "1" ]; then
    if [ -d "$out" ]; then
      say "Sauvegardes disponibles dans $out :"
      # shellcheck disable=SC2012
      ls -1 "$out" 2>/dev/null | sed -n 's/^elium-db-\(.*\)\.sql\.gz$/  \1/p'
    fi
    ts="$(prompt "Timestamp de la sauvegarde à restaurer" "")"
  fi
  [ -n "$ts" ] || die "Usage : bash install.sh restore <timestamp> (voir les fichiers backups/elium-db-<timestamp>.sql.gz)."

  local db_file="$out/elium-db-$ts.sql.gz" blobs_file="$out/elium-blobs-$ts.tar.gz" meta_file="$out/elium-blobs-$ts.meta"
  # Sauvegarde absente en local (serveur reconstruit après sinistre) : on la récupère du remote.
  local remote; remote="${BACKUP_RCLONE_REMOTE:-$(read_env BACKUP_RCLONE_REMOTE)}"
  if [ ! -f "$db_file" ] && [ -n "$remote" ] && command -v rclone >/dev/null 2>&1; then
    info "Sauvegarde $ts absente en local — récupération depuis $remote…"
    mkdir -p "$out"
    rclone copy "$remote" "$out" --include "elium-*-$ts.*" || warn "Récupération depuis $remote échouée."
  fi
  [ -f "$db_file" ]    || die "Sauvegarde base introuvable : $db_file"
  [ -f "$blobs_file" ] || die "Sauvegarde blobs introuvable : $blobs_file"
  # Backend d'origine de la sauvegarde (marqueur écrit par do_backup). Absent
  # (anciennes sauvegardes) ⇒ fs.
  local backend="fs"
  [ -f "$meta_file" ] && backend="$(sed -n 's/^backend=//p' "$meta_file" | head -n1)"
  [ -n "$backend" ] || backend="fs"

  # Profil compose pour joindre MinIO le cas échéant.
  local profile=(); [ "$(read_env STORAGE_DRIVER)" = "s3" ] && profile=(--profile s3)

  hr
  warn "Cette opération va ÉCRASER l'état actuel (base de données ET blobs) avec la sauvegarde du $ts (backend : $backend)."
  if [ "$ASSUME_YES" != "1" ]; then
    local c; c="$(prompt "Tapez 'restore' pour confirmer, autre chose pour annuler" "")"
    [ "$c" = "restore" ] || die "Restauration annulée."
  fi

  info "Arrêt du service api…"
  $DC stop api

  info "Restauration de Postgres depuis $db_file…"
  gunzip -c "$db_file" | $DC exec -T db psql -U elium elium

  case "$backend" in
    s3-minio)
      info "Restauration des blobs (MinIO intégré) depuis $blobs_file…"
      # Arrêter MinIO le temps de réécrire son volume de données, puis relancer.
      $DC "${profile[@]}" stop minio 2>/dev/null || true
      gunzip -c "$blobs_file" | $DC "${profile[@]}" run --rm -T minio sh -c 'cd /data && tar xzf -'
      $DC "${profile[@]}" up -d minio ;;
    s3-external)
      warn "Sauvegarde issue d'un S3 EXTERNE : les blobs ne sont pas restaurés ici (restaurez le bucket côté fournisseur)." ;;
    *)
      info "Restauration des blobs (volume fs) depuis $blobs_file…"
      # `run --rm` (pas `exec`) : le service `api` vient d'être arrêté ci-dessus,
      # `exec` échouerait sur un conteneur non démarré. `run` en crée un nouveau,
      # éphémère, monté sur les mêmes volumes — même pattern que do_backup().
      gunzip -c "$blobs_file" | $DC run --rm -T api sh -c 'cd /data && tar xzf -' ;;
  esac

  info "Redémarrage de la pile…"
  $DC "${profile[@]}" up -d

  hr
  ok "${bold}Restauration depuis $ts terminée.${rst} Vérifiez : bash install.sh status"
}

show_help() { sed -n '2,33p' "$0" | sed 's/^# \{0,1\}//'; }

menu() {
  hr
  printf '%s  ELIUM — installateur unique%s\n' "$bold" "$rst"
  hr
  say "  1) Déployer le Drive entreprise (VPS, HTTPS auto)"
  say "  2) Déployer le Drive en LOCAL (http://localhost, sans TLS)"
  say "  3) Lancer la suite bureautique dans le navigateur"
  say "  4) Mettre à jour la pile Drive (manuel)"
  say "  5) Mises à jour automatiques (activer / désactiver / état)"
  say "  6) État de la pile"
  say "  7) Sauvegarder (base + blobs)"
  say "  8) Restaurer une sauvegarde"
  say "  9) Aide"
  say "  0) Quitter"
  hr
  local c; c="$(prompt "Votre choix" "1")"
  case "$c" in
    1) deploy_drive ;;
    2) LOCAL=1; deploy_drive ;;
    3) run_suite ;;
    4) do_update ;;
    5) local a; a="$(prompt "auto-update : on / off / status / now" "status")"; ARG1="$a"; do_auto_update "$a" ;;
    6) do_status ;;
    7) do_backup ;;
    8) do_restore ;;
    9) show_help ;;
    0) exit 0 ;;
    *) die "Choix invalide." ;;
  esac
}

case "$CMD" in
  menu)        menu ;;
  drive)       deploy_drive ;;
  suite)       run_suite ;;
  update)      do_update ;;
  self-update) do_self_update ;;
  auto-update) do_auto_update "$ARG1" ;;
  status)      do_status ;;
  backup)      do_backup ;;
  restore)     do_restore ;;
  help|-h|--help) show_help ;;
  *) die "Commande inconnue : $CMD (essayez : bash install.sh help)" ;;
esac
