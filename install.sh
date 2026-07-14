#!/usr/bin/env bash
# =============================================================================
# Elium — installateur & configurateur UNIQUE.
#
# Un seul fichier pour tout configurer et installer, sur un VPS comme en local :
#   • déployer le Drive entreprise (Docker) — VPS avec HTTPS auto, ou local ;
#   • lancer la suite bureautique dans le navigateur (sans Docker) ;
#   • mettre à jour, sauvegarder, vérifier l'état.
#
# Usage :
#   bash install.sh                     # menu interactif
#   bash install.sh drive --domain drive.exemple.fr --email vous@exemple.fr
#   bash install.sh drive --local       # Drive en local (http://localhost, sans TLS)
#   bash install.sh suite               # suite bureautique dans le navigateur
#   bash install.sh update | status | backup | help
#   bash install.sh restore <timestamp> # restaure une sauvegarde de backups/
#
# Options de « drive » :
#   --domain <fqdn>     domaine public (HTTPS automatique via Caddy/Let's Encrypt)
#   --local             déploiement local sans TLS (SITE_ADDRESS=:80)
#   --email <email>     e-mail ACME (recommandé en prod)
#   --storage fs|s3     backend de blobs (défaut fs ; s3 = MinIO intégré)
#   --quota-gb <n>      quota de stockage par organisation, en Go (défaut illimité)
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
DOMAIN=""; LOCAL=0; EMAIL=""; STORAGE="fs"; QUOTA_GB=""; HTTP_PORT="80"
ASSUME_YES=0; DRY_RUN=0; ARG1=""
while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --local) LOCAL=1; shift ;;
    --email) EMAIL="${2:-}"; shift 2 ;;
    --storage) STORAGE="${2:-fs}"; shift 2 ;;
    --quota-gb) QUOTA_GB="${2:-}"; shift 2 ;;
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
    echo "STORAGE_DRIVER=$STORAGE"
    echo "S3_ACCESS_KEY=$s3key"
    echo "S3_SECRET_KEY=$s3secret"
    echo "S3_BUCKET=$(read_env S3_BUCKET || true)"
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
  local profile=(); [ "$STORAGE" = "s3" ] && profile=(--profile s3)
  $DC "${profile[@]}" up -d --build

  # Santé
  info "Vérification de l'état de l'API…"
  local i healthy=0
  for i in $(seq 1 30); do
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
  [ "$STORAGE" = "s3" ] && say "  • Console MinIO: non exposée publiquement — tunnel : ${bold}ssh -L 9001:localhost:9001 <user>@<vps>${rst} puis http://localhost:9001 (créez le bucket ${bold}elium-blobs${rst})"
  say ""
  say "  Prochaine étape : ouvrez $origin, créez le 1er compte (= propriétaire),"
  say "  puis votre organisation. Activez la 2FA dans l'onglet ${bold}Sécurité${rst}."
  if [ "$LOCAL" = "1" ] || [ -z "$DOMAIN" ]; then
    say "  Depuis l'app de bureau : bouton ${bold}Serveur${rst} → $origin/api"
  else
    say "  Depuis l'app de bureau : bouton ${bold}Serveur${rst} → $origin/api"
  fi
}

# =============================================================================
#  Suite bureautique dans le navigateur (sans Docker)
# =============================================================================
run_suite() {
  command -v node >/dev/null 2>&1 || die "Node.js 20+ requis pour la suite web. Voir INSTALL.md."
  info "Installation des dépendances de la suite (web-studio)…"
  ( cd web-studio && npm install --no-audit --no-fund )
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
  local profile=(); [ "$(read_env STORAGE_DRIVER)" = "s3" ] && profile=(--profile s3)
  info "Reconstruction + redémarrage…"
  $DC "${profile[@]}" up -d --build
  ok "Pile mise à jour (migrations ré-appliquées, idempotentes)."
}

do_status() {
  detect_compose; [ -n "$DC" ] || die "Docker Compose requis."
  $DC ps || true
  hr
  if curl -fsS "http://localhost:8787/api/health" 2>/dev/null; then say ""; ok "API joignable en local (port 8787)."
  else warn "API non joignable directement (normal si seul Caddy est exposé) — testez via votre domaine."; fi
}

do_backup() {
  detect_compose; [ -n "$DC" ] || die "Docker Compose requis."
  local ts out; ts="$(date -u '+%Y%m%d-%H%M%S')"; out="$SCRIPT_DIR/backups"
  mkdir -p "$out"
  info "Sauvegarde Postgres…"
  $DC exec -T db pg_dump -U elium elium | gzip > "$out/elium-db-$ts.sql.gz"
  info "Sauvegarde des blobs chiffrés…"
  $DC run --rm -T -v "$out:/backup" api sh -c 'cd /data && tar czf - blobs' > "$out/elium-blobs-$ts.tar.gz" 2>/dev/null \
    || $DC exec -T api sh -c 'cd /data && tar czf - blobs' > "$out/elium-blobs-$ts.tar.gz"
  ok "Sauvegardes écrites dans $out (base + blobs, chiffrés E2E)."
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

  local db_file="$out/elium-db-$ts.sql.gz" blobs_file="$out/elium-blobs-$ts.tar.gz"
  [ -f "$db_file" ]    || die "Sauvegarde base introuvable : $db_file"
  [ -f "$blobs_file" ] || die "Sauvegarde blobs introuvable : $blobs_file"

  hr
  warn "Cette opération va ÉCRASER l'état actuel (base de données ET blobs) avec la sauvegarde du $ts."
  if [ "$ASSUME_YES" != "1" ]; then
    local c; c="$(prompt "Tapez 'restore' pour confirmer, autre chose pour annuler" "")"
    [ "$c" = "restore" ] || die "Restauration annulée."
  fi

  info "Arrêt du service api…"
  $DC stop api

  info "Restauration de Postgres depuis $db_file…"
  gunzip -c "$db_file" | $DC exec -T db psql -U elium elium

  info "Restauration des blobs depuis $blobs_file…"
  # `run --rm` (pas `exec`) : le service `api` vient d'être arrêté ci-dessus,
  # `exec` échouerait sur un conteneur non démarré. `run` en crée un nouveau,
  # éphémère, monté sur les mêmes volumes — même pattern que do_backup().
  gunzip -c "$blobs_file" | $DC run --rm -T api sh -c 'cd /data && tar xzf -'

  info "Redémarrage de la pile…"
  $DC up -d

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
  say "  4) Mettre à jour la pile Drive"
  say "  5) État de la pile"
  say "  6) Sauvegarder (base + blobs)"
  say "  7) Restaurer une sauvegarde"
  say "  8) Aide"
  say "  0) Quitter"
  hr
  local c; c="$(prompt "Votre choix" "1")"
  case "$c" in
    1) deploy_drive ;;
    2) LOCAL=1; deploy_drive ;;
    3) run_suite ;;
    4) do_update ;;
    5) do_status ;;
    6) do_backup ;;
    7) do_restore ;;
    8) show_help ;;
    0) exit 0 ;;
    *) die "Choix invalide." ;;
  esac
}

case "$CMD" in
  menu)    menu ;;
  drive)   deploy_drive ;;
  suite)   run_suite ;;
  update)  do_update ;;
  status)  do_status ;;
  backup)  do_backup ;;
  restore) do_restore ;;
  help|-h|--help) show_help ;;
  *) die "Commande inconnue : $CMD (essayez : bash install.sh help)" ;;
esac
