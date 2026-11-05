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
#   bash install.sh release-feed        # rafraîchit release.json (carte « nouvelle version » du site)
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
umask 077

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

# Version annoncée par l'API effectivement en service, jamais par le checkout.
running_version() {
  [ -n "$DC" ] || return 1
  $DC exec -T api node -e 'fetch("http://127.0.0.1:8787/api/health").then(r=>{if(!r.ok)throw Error();return r.json()}).then(j=>{if(typeof j.version!=="string"||!j.version)throw Error();console.log(j.version)}).catch(()=>process.exit(1))' 2>/dev/null
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
  local out=""
  # Parseur JSON réel si disponible (python3, puis jq) ; repli sed sinon.
  if command -v python3 >/dev/null 2>&1; then
    if out="$(python3 -c 'import json, sys
try:
    v = json.load(open(sys.argv[1], encoding="utf-8")).get(sys.argv[2])
except Exception:
    sys.exit(3)
if isinstance(v, str):
    print(v)' "$1" "$2" 2>/dev/null)"; then
      printf '%s\n' "$out" | head -n1
      return 0
    fi
  fi
  if command -v jq >/dev/null 2>&1; then
    if out="$(jq -er --arg k "$2" 'if (.[$k] | type) == "string" then .[$k] else empty end' "$1" 2>/dev/null)"; then
      printf '%s\n' "$out" | head -n1
      return 0
    fi
  fi
  sed -n "s/.*\"$2\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$1" 2>/dev/null | head -n1
}

# Renvoie 0 si $1 (version) est strictement supérieure à $2 (comparaison semver).
version_gt() {
  [ "$1" != "$2" ] || return 1
  [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -n1)" = "$1" ]
}

# Upsert d'une variable dans .env (préserve les droits 600). La valeur est écrite telle quelle
# (awk + ENVIRON : aucun caractère spécial de sed — &, |, \ — n'est interprété).
set_env_var() {
  local key="$1" val="$2" tmpf
  [ -f "$ENV_FILE" ] || return 0
  tmpf="$(mktemp "$ENV_FILE.XXXXXX")" || return 1
  if grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
    K="$key" V="$val" awk 'BEGIN { p = ENVIRON["K"] "=" } index($0, p) == 1 { print p ENVIRON["V"]; next } { print }' "$ENV_FILE" > "$tmpf"
  else
    cat "$ENV_FILE" > "$tmpf"
    # fichier sans retour à la ligne final : en ajouter un avant la nouvelle clé
    if [ -n "$(tail -c1 "$ENV_FILE" 2>/dev/null)" ]; then printf '\n' >> "$tmpf"; fi
    printf '%s=%s\n' "$key" "$val" >> "$tmpf"
  fi
  chmod 600 "$tmpf" 2>/dev/null || true
  mv "$tmpf" "$ENV_FILE"
}

# N'écrit la variable QUE si elle est absente ou vide : un secret ou un réglage existant n'est
# jamais écrasé ni régénéré.
env_set_missing() {
  [ -n "$(read_env "$1")" ] || set_env_var "$1" "$2"
}

# Copie de .env dans backups/env-<horodatage> (droits 600 ; backups/ est ignoré par git).
backup_env_file() {
  local ts="${1:-$(date -u '+%Y%m%d-%H%M%S')}" out="$SCRIPT_DIR/backups" dest
  [ -f "$ENV_FILE" ] || return 0
  mkdir -p "$out"; chmod 700 "$out" 2>/dev/null || true
  dest="$out/env-$ts"
  cp "$ENV_FILE" "$dest" && chmod 600 "$dest"
}

# --- Accès SQL (surchargeable : variables ELIUM_PSQL / ELIUM_PGDUMP, utilisées par les tests) -------
# Nom de la base applicative.
DB_NAME="${ELIUM_DB_NAME:-elium}"

# _psql <base> [options psql…] : psql en superutilisateur (stdin transmis).
_psql() {
  local db="$1"; shift
  if [ -n "${ELIUM_PSQL:-}" ]; then
    # shellcheck disable=SC2086  # commande + options volontairement découpées
    $ELIUM_PSQL -d "$db" "$@"
  else
    [ -n "$DC" ] || return 1
    $DC exec -T db psql -U elium -d "$db" "$@"
  fi
}

# _pgdump [options pg_dump…] <base>
_pgdump() {
  if [ -n "${ELIUM_PGDUMP:-}" ]; then
    # shellcheck disable=SC2086
    $ELIUM_PGDUMP "$@"
  else
    [ -n "$DC" ] || return 1
    $DC exec -T db pg_dump -U elium "$@"
  fi
}

# Crochets remplaçables par les tests.
stop_api()          { [ -z "$DC" ] || $DC stop api >/dev/null 2>&1 || true; }
ensure_db_running() { [ -z "$DC" ] || $DC up -d db >/dev/null 2>&1 || true; }
# Ré-attribue la propriété des tables au rôle applicatif (db-init, idempotent) après une bascule de
# base ; sans objet si le compose en vigueur n'a pas ce service (versions anciennes).
post_restore_hook() {
  [ -n "$DC" ] || return 0
  if $DC config --services 2>/dev/null | grep -qx 'db-init'; then
    $DC run --rm -T db-init >/dev/null 2>&1
  fi
}

_wait_db() {
  for _ in $(seq 1 "${ELIUM_DB_WAIT_TRIES:-30}"); do
    if _psql postgres -Atqc 'SELECT 1' >/dev/null 2>&1; then return 0; fi
    sleep "${ELIUM_HEALTH_STEP_S:-2}"
  done
  return 1
}

# L'API répond-elle saine ? (statut Docker, puis sonde interne au conteneur ; jamais depuis l'hôte :
# le service `api` n'expose aucun port.)
api_healthy() {
  [ -n "$DC" ] || return 1
  if [ "$($DC ps api --format '{{.Health}}' 2>/dev/null)" = "healthy" ]; then return 0; fi
  $DC exec -T api wget -qO- http://127.0.0.1:8787/api/health >/dev/null 2>&1
}

# Une requête applicative non inactive est-elle en cours (migration longue) ?
migration_in_progress() {
  local n
  n="$(_psql "$DB_NAME" -Atqc "SELECT count(*) FROM pg_stat_activity WHERE datname = '$DB_NAME' AND usename = 'elium_app' AND state <> 'idle' AND pid <> pg_backend_pid()" 2>/dev/null | tr -d '[:space:]' || true)"
  case "$n" in ''|*[!0-9]*) return 1 ;; esac
  [ "$n" -gt 0 ]
}

# Attend que l'API soit saine : ELIUM_HEALTH_TIMEOUT_S secondes (défaut 300, car l'API n'écoute
# qu'APRÈS ses migrations). Au-delà, si une migration est visiblement en cours (requête applicative
# non inactive), le délai est prolongé jusqu'à ELIUM_HEALTH_MAX_S (défaut 1800) avant de conclure à
# un échec — donc avant tout rollback. Renvoie 0 si saine, 1 sinon.
wait_health() {
  local timeout="${ELIUM_HEALTH_TIMEOUT_S:-300}" max="${ELIUM_HEALTH_MAX_S:-1800}" step="${ELIUM_HEALTH_STEP_S:-2}" waited=0 noted=0
  case "$timeout" in ''|*[!0-9]*) timeout=300 ;; esac
  case "$max" in ''|*[!0-9]*) max=1800 ;; esac
  case "$step" in ''|*[!0-9]*|0) step=2 ;; esac
  [ "$max" -ge "$timeout" ] || max="$timeout"
  info "Attente de l'API (jusqu'à ${timeout}s ; les migrations de base s'exécutent avant l'ouverture du port)…"
  while :; do
    if api_healthy; then return 0; fi
    if [ "$waited" -ge "$timeout" ]; then
      if [ "$waited" -lt "$max" ] && migration_in_progress; then
        if [ "$noted" = "0" ]; then
          warn "Une migration de base est encore en cours : délai prolongé (jusqu'à ${max}s) avant de conclure à un échec."
          noted=1
        fi
      else
        break
      fi
    fi
    sleep "$step"; waited=$((waited + step))
    if [ $((waited % 30)) -lt "$step" ]; then info "…toujours en attente de l'API (${waited}s)."; fi
  done
  warn "L'API n'est pas devenue saine en ${waited}s (ELIUM_HEALTH_TIMEOUT_S=${timeout} ; aucune migration en cours détectée au-delà)."
  return 1
}

# Dernière migration appliquée (table schema_migrations) : « version de schéma » à enregistrer
# avant une mise à jour pour savoir, au rollback, si des migrations ont tourné. Vide si illisible.
db_schema_version() {
  _psql "$DB_NAME" -Atc \
    "SELECT COALESCE(MAX(version), '') FROM schema_migrations" 2>/dev/null | tr -d '[:space:]' || true
}

# Faut-il restaurer la base lors d'un rollback ? OUI si la version de schéma a changé, OU si l'un des
# deux états est illisible (base KO : on ne peut pas prouver qu'aucune migration n'a tourné ; le dump
# pré-mise-à-jour étant obligatoire, restaurer est le choix sûr). Arguments : avant, après.
rollback_needs_db_restore() {
  local before="$1" after="$2"
  [ -z "$before" ] && return 0
  [ -z "$after" ] && return 0
  [ "$before" != "$after" ]
}

free_kb() { df -Pk "$1" 2>/dev/null | awk 'NR==2 {print $4}'; }

# Espace disque suffisant pour sauvegarder (et restaurer) ? Exige le plus grand de
# ELIUM_MIN_FREE_MB (défaut 1024) et de 2 × la taille de la base.
check_disk_space() {
  local dir="${1:-$SCRIPT_DIR}" min_mb="${ELIUM_MIN_FREE_MB:-1024}" need_kb free dbsize
  need_kb=$((min_mb * 1024))
  dbsize="$(_psql "$DB_NAME" -Atqc 'SELECT pg_database_size(current_database())/1024' 2>/dev/null | tr -d '[:space:]' || true)"
  case "$dbsize" in ''|*[!0-9]*) dbsize=0 ;; esac
  if [ $((dbsize * 2)) -gt "$need_kb" ]; then need_kb=$((dbsize * 2)); fi
  free="$(free_kb "$dir")"
  case "$free" in
    ''|*[!0-9]*) warn "Espace disque libre illisible sur $dir — vérification ignorée."; return 0 ;;
  esac
  if [ "$free" -lt "$need_kb" ]; then
    warn "Espace disque insuffisant sur $dir : $((free / 1024)) Mo libres, $((need_kb / 1024)) Mo requis (sauvegarde + restauration)."
    return 1
  fi
  return 0
}

# Un dump est-il COMPLET ? gzip valide, taille décompressée minimale (arg 2, défaut
# ELIUM_DUMP_MIN_BYTES=2048 ; 0 = pas de minimum) et ligne finale « PostgreSQL database dump
# complete » (absente d'un pg_dump interrompu).
verify_dump_file() {
  local f="$1" min="${2:-${ELIUM_DUMP_MIN_BYTES:-2048}}" size
  gzip -t "$f" 2>/dev/null || { warn "Dump illisible (gzip invalide) : $f"; return 1; }
  size="$(gzip -dc "$f" 2>/dev/null | wc -c | tr -d '[:space:]')"
  if [ "${size:-0}" -lt "$min" ] || [ "${size:-0}" -eq 0 ]; then
    warn "Dump trop petit (${size:-0} octets, minimum $min) : $f"; return 1
  fi
  if ! gzip -dc "$f" 2>/dev/null | tail -n 10 | grep -q 'PostgreSQL database dump complete'; then
    warn "Dump incomplet (ligne finale « PostgreSQL database dump complete » absente) : $f"; return 1
  fi
  return 0
}

# Sauvegarde de la base AVANT une mise à jour (tag « preupdate ») ou avant une restauration (tag
# « prerestore ») — OBLIGATOIRE : si elle échoue (pg_dump en erreur, dump incomplet ou trop petit,
# espace disque insuffisant), l'opération est ABANDONNÉE sans rien modifier. Le dump est
# « --clean --if-exists ». Copie aussi .env (backups/env-<ts>, 600). Un .meta voisin consigne version
# applicative, commit, version de schéma. Chemin du dump sur STDOUT ; tous les messages vont sur
# STDERR (la fonction est appelée via $(…)).
backup_db_preupdate() {
  local tag="${1:-preupdate}" ts out dump part
  ts="$(date -u '+%Y%m%d-%H%M%S')"; out="$SCRIPT_DIR/backups"
  mkdir -p "$out"; chmod 700 "$out" 2>/dev/null || true
  check_disk_space "$out" >&2 || return 1
  backup_env_file "$ts" || { warn "Copie de .env impossible." >&2; return 1; }
  dump="$out/elium-db-$tag-$ts.sql.gz"; part="$dump.part"
  # pipefail (set -o) : l'échec de pg_dump n'est pas masqué par gzip.
  if ! _pgdump --clean --if-exists "$DB_NAME" 2>/dev/null | gzip > "$part"; then
    rm -f "$part"; return 1
  fi
  if ! verify_dump_file "$part" >&2; then rm -f "$part"; return 1; fi
  mv "$part" "$dump"
  {
    printf 'app_version=%s\n' "$(running_version || true)"
    printf 'commit=%s\n' "$(git -C "$SCRIPT_DIR" rev-parse HEAD 2>/dev/null || true)"
    printf 'schema_version=%s\n' "$(db_schema_version)"
    printf 'env_backup=%s\n' "$out/env-$ts"
  } > "${dump%.sql.gz}.meta"
  backup_blobs_note "$out" "$ts" "$tag" >&2 || return 1
  printf '%s' "$dump"
}

# Blobs (volume `blobs`) lors d'une sauvegarde pré-opération : message clair, et sauvegarde rapide
# (tar) si ELIUM_BACKUP_BLOBS=1 avec STORAGE_DRIVER=fs. Une mise à jour ne touche pas aux blobs
# (immuables, volume séparé) : ils ne sont donc PAS inclus par défaut — `install.sh backup` les inclut.
backup_blobs_note() {
  local out="$1" ts="$2" tag="$3" f
  case "$(blob_backend)" in
    fs)
      if [ "${ELIUM_BACKUP_BLOBS:-0}" = "1" ]; then
        f="$out/elium-blobs-$tag-$ts.tar.gz"
        info "Sauvegarde rapide des blobs (volume fs)…"
        if ! $DC exec -T api sh -c 'cd /data && tar czf - blobs' > "$f" 2>/dev/null || [ ! -s "$f" ]; then
          rm -f "$f"; warn "Sauvegarde des blobs demandée (ELIUM_BACKUP_BLOBS=1) mais impossible — opération abandonnée."; return 1
        fi
        ok "Blobs sauvegardés : $f"
      else
        warn "Les blobs (volume « blobs ») ne sont PAS inclus dans cette sauvegarde (la mise à jour n'y touche pas). Pour les inclure : ELIUM_BACKUP_BLOBS=1, ou « bash install.sh backup » avant."
      fi ;;
    s3-minio)
      warn "Blobs MinIO non inclus dans cette sauvegarde (volume « miniodata »). Utilisez « bash install.sh backup » pour les sauvegarder." ;;
    *)
      warn "Stockage S3 externe : les blobs sont hors de ce serveur — sauvegardez le bucket chez le fournisseur." ;;
  esac
  return 0
}

# Supprime une base (best effort).
_drop_db() {
  _psql postgres -q -At -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"$1\"" >/dev/null 2>&1 || true
}

# Contrôle d'une base restaurée contre le dump d'origine : chaque table du dump existe, et chaque
# table dont le dump contenait des lignes (COPY non vide) en contient. Arguments : dump, base.
verify_restored_db() {
  local dump="$1" db="$2" sqlf tables datatables t
  sqlf="$(mktemp)" || return 1
  tables="$(gzip -dc "$dump" | sed -n 's/^CREATE TABLE \([^ ]*\) (.*$/\1/p')"
  datatables="$(gzip -dc "$dump" | awk '/^COPY /{t=$2; if ((getline nxt) > 0 && nxt != "\\.") print t}')"
  if [ -z "$tables" ]; then
    warn "Le dump ne contient aucune table : restauration refusée."; rm -f "$sqlf"; return 1
  fi
  {
    echo '\set ON_ERROR_STOP 1'
    for t in $tables; do
      case "$t" in *[!A-Za-z0-9_.\"]*) continue ;; esac
      printf 'SELECT 1 FROM %s LIMIT 0;\n' "$t"
    done
    for t in $datatables; do
      case "$t" in *[!A-Za-z0-9_.\"]*) continue ;; esac
      printf "DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM %s) THEN RAISE EXCEPTION 'table vide apres restauration : %s'; END IF; END \$\$;\n" "$t" "$t"
    done
  } > "$sqlf"
  if ! _psql "$db" -q -At -v ON_ERROR_STOP=1 -f - < "$sqlf" >/dev/null; then
    rm -f "$sqlf"; return 1
  fi
  rm -f "$sqlf"
  return 0
}

# Restauration ATOMIQUE d'un dump `pg_dump --clean` (rollback, restore) :
#   1. api arrêtée ; base TEMPORAIRE neuve « elium_restore » ;
#   2. dump rejoué dedans en UNE transaction (--single-transaction) avec ON_ERROR_STOP ;
#   3. contrôle (tables du dump présentes, tables non vides si le dump avait des lignes) ;
#   4. seulement alors, bascule par renommage (connexions coupées) : l'ancienne base est CONSERVÉE
#      sous « <base>_before_restore_<horodatage> » ; db-init ré-attribue la propriété des tables.
# Tant que l'étape 4 n'a pas eu lieu, la base courante n'est JAMAIS touchée : un échec la laisse intacte.
# Pourquoi pas un rejeu direct : un dump pris sur l'ancien schéma ne connaît pas les tables créées
# depuis par les migrations ; ses DROP échouent sur ces dépendances (FK) et laissaient la base à
# moitié détruite.
restore_db_dump() {
  local dump="$1" ts tmpdb olddb live="$DB_NAME"
  ts="$(date -u '+%Y%m%d-%H%M%S')"
  tmpdb="${ELIUM_RESTORE_DB:-elium_restore}"
  olddb="${live}_before_restore_${ts}"
  [ -f "$dump" ] || { warn "Dump introuvable : $dump"; return 1; }
  verify_dump_file "$dump" 0 || return 1
  stop_api
  ensure_db_running
  _wait_db || { warn "La base de données ne répond pas : restauration impossible."; return 1; }
  info "Restauration atomique du dump dans une base temporaire « $tmpdb »…"
  _drop_db "$tmpdb"
  _psql postgres -q -At -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$tmpdb\"" >/dev/null || return 1
  if ! gzip -dc "$dump" | _psql "$tmpdb" -q -At -v ON_ERROR_STOP=1 --single-transaction -f - >/dev/null; then
    warn "Rejeu du dump en échec : la base « $live » n'a PAS été modifiée."
    _drop_db "$tmpdb"; return 1
  fi
  if ! verify_restored_db "$dump" "$tmpdb"; then
    warn "Contrôle de la base restaurée en échec : la base « $live » n'a PAS été modifiée."
    _drop_db "$tmpdb"; return 1
  fi
  _psql postgres -q -At -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$live' AND pid <> pg_backend_pid()" >/dev/null 2>&1 || true
  if ! _psql postgres -q -At -v ON_ERROR_STOP=1 -c "ALTER DATABASE \"$live\" RENAME TO \"$olddb\"" >/dev/null; then
    warn "Impossible de mettre la base courante de côté : elle est inchangée."
    _drop_db "$tmpdb"; return 1
  fi
  if ! _psql postgres -q -At -v ON_ERROR_STOP=1 -c "ALTER DATABASE \"$tmpdb\" RENAME TO \"$live\"" >/dev/null; then
    _psql postgres -q -At -v ON_ERROR_STOP=1 -c "ALTER DATABASE \"$olddb\" RENAME TO \"$live\"" >/dev/null \
      || warn "CRITIQUE : base courante laissée sous le nom « $olddb » — renommez-la en « $live » à la main."
    warn "Bascule de la base restaurée impossible : base d'origine rétablie."
    _drop_db "$tmpdb"; return 1
  fi
  if ! post_restore_hook; then
    warn "Préparation des droits (db-init) en échec après la bascule : retour à la base d'origine."
    _psql postgres -q -At -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$live' AND pid <> pg_backend_pid()" >/dev/null 2>&1 || true
    _psql postgres -q -At -c "ALTER DATABASE \"$live\" RENAME TO \"${live}_failed_restore_${ts}\"" >/dev/null 2>&1 || true
    _psql postgres -q -At -v ON_ERROR_STOP=1 -c "ALTER DATABASE \"$olddb\" RENAME TO \"$live\"" >/dev/null \
      || warn "CRITIQUE : renommez à la main « $olddb » en « $live »."
    return 1
  fi
  PREVIOUS_DB_KEPT_AS="$olddb"
  ok "Base restaurée. L'ancienne base est conservée sous « $olddb » (suppression : DROP DATABASE \"$olddb\" une fois la restauration validée)."
  return 0
}

# Ajoute à .env les secrets introduits par les versions récentes (REDIS_PASSWORD) sans toucher aux
# existants : une pile déployée avant leur introduction continue de démarrer (compose exige ces
# secrets, il n'y a plus de valeur par défaut).
ensure_env_secrets() {
  [ -f "$ENV_FILE" ] || return 0
  if [ -z "$(read_env POSTGRES_APP_PASSWORD)" ]; then
    set_env_var POSTGRES_APP_PASSWORD "$(gen_secret)"
  fi
  if [ -z "$(read_env WEBAUTHN_RP_ID)" ]; then
    local rp; rp="$(read_env SITE_ADDRESS)"
    case "$rp" in ""|:*) rp=localhost ;; esac
    set_env_var WEBAUTHN_RP_ID "$rp"
  fi
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

# Ne conserve que les 5 dernières sauvegardes pré-mise-à-jour (et les 10 dernières copies de .env).
prune_update_backups() {
  local out="$SCRIPT_DIR/backups"
  [ -d "$out" ] || return 0
  # shellcheck disable=SC2012
  ls -1t "$out"/elium-db-preupdate-*.sql.gz 2>/dev/null | tail -n +6 | while read -r f; do rm -f "$f" "${f%.sql.gz}.meta"; done
  # shellcheck disable=SC2012
  ls -1t "$out"/env-* 2>/dev/null | tail -n +11 | while read -r f; do rm -f "$f"; done
  return 0
}

# Démarre la pile : avec des images SIGNÉES épinglées par digest (ELIUM_API_IMAGE / ELIUM_WEB_IMAGE
# dans .env, écrites par l'auto-update d'après le manifeste signé) on les TIRE sans rien construire
# sur le serveur ; sinon (premier déploiement, manifeste ancien) on construit sur place.
# Images « tirées » seulement si elles sont épinglées par digest (…@sha256:…). Un tag local (ex.
# elium-api:local, VPS construit sur place) n'est JAMAIS tiré : on reconstruit (`up -d --build`), sans
# quoi `pull` échouerait, y compris pendant un rollback.
image_is_pinned() { case "$(read_env "$1")" in *@sha256:*) return 0 ;; esac; return 1; }
images_pinned() { image_is_pinned ELIUM_API_IMAGE || image_is_pinned ELIUM_WEB_IMAGE; }
# Ne fait JAMAIS `die` (appelée après modification de .env/git : l'appelant décide du rollback).
compose_up_stack() {
  mkdir -p "$SCRIPT_DIR/release"
  chmod 755 "$SCRIPT_DIR/release"
  local profile=(); [ "$(read_env STORAGE_DRIVER)" = "s3" ] && profile=(--profile s3)
  if [ "$(blob_backend)" = "s3-minio" ]; then
    case "$(read_env MINIO_IMAGE)" in
      *@sha256:*) : ;;
      *) warn "MinIO intégré exige MINIO_IMAGE avec une empreinte vérifiée d'une image maintenue (voir la documentation d'exploitation)."; return 1 ;;
    esac
  fi
  if images_pinned; then
    local pull_svcs=()
    image_is_pinned ELIUM_API_IMAGE && pull_svcs+=(api)
    image_is_pinned ELIUM_WEB_IMAGE && pull_svcs+=(web)
    $DC "${profile[@]}" pull "${pull_svcs[@]}" && $DC "${profile[@]}" up -d --no-build
  else
    $DC "${profile[@]}" up -d --build
  fi
}

# Compteur d'erreurs des pré-vérifications.
PREFLIGHT_ERRORS=0
preflight_fail() { warn "Pré-vérification : $*"; PREFLIGHT_ERRORS=$((PREFLIGHT_ERRORS + 1)); }

# Pré-vérifications AVANT toute modification (git, .env, pile). Échec = messages clairs, retour 1,
# et l'appelant n'a RIEN modifié. Contrôle : STORAGE_DRIVER ; MinIO intégré (MINIO_IMAGE épinglée par
# digest) ; clés S3 (S3_ACCESS_KEY ≠ valeur par défaut « elium », que l'API refuse en production) ;
# longueur de TOKEN_SECRET ; variables obligatoires (`${VAR:?…}`) du docker-compose qui va tourner
# (arg 1 = son contenu ; défaut : docker-compose.yml courant) ; espace disque. REDIS_PASSWORD et
# POSTGRES_APP_PASSWORD sont générés plus tard s'ils manquent (ensure_env_secrets).
preflight_update() {
  local compose_text="${1-}" driver key tok
  PREFLIGHT_ERRORS=0
  [ -n "$compose_text" ] || compose_text="$(cat "$SCRIPT_DIR/docker-compose.yml" 2>/dev/null || true)"
  driver="$(read_env STORAGE_DRIVER)"
  case "$driver" in
    ""|fs|s3) : ;;
    *) preflight_fail "STORAGE_DRIVER invalide (« $driver » ; attendu fs ou s3)." ;;
  esac
  if [ "$driver" = "s3" ]; then
    case "$(read_env S3_ACCESS_KEY)" in
      "")    preflight_fail "STORAGE_DRIVER=s3 mais S3_ACCESS_KEY est vide dans .env." ;;
      elium) preflight_fail "S3_ACCESS_KEY=elium (valeur par défaut) : l'API refuse de démarrer en production avec. Choisissez une clé propre à votre déploiement (voir la documentation d'exploitation)." ;;
    esac
    [ -n "$(read_env S3_SECRET_KEY)" ] || preflight_fail "STORAGE_DRIVER=s3 mais S3_SECRET_KEY est vide dans .env."
  fi
  if [ "$(blob_backend)" = "s3-minio" ]; then
    case "$(read_env MINIO_IMAGE)" in
      *@sha256:*) : ;;
      *) preflight_fail "MinIO intégré : MINIO_IMAGE doit être une image maintenue épinglée par empreinte (…@sha256:…)." ;;
    esac
  fi
  tok="$(read_env TOKEN_SECRET)"
  if [ -n "$tok" ] && [ "${#tok}" -lt 32 ]; then
    preflight_fail "TOKEN_SECRET trop court (${#tok} caractères, 32 minimum)."
  fi
  for key in $(printf '%s\n' "$compose_text" | grep -o '\${[A-Z][A-Z0-9_]*:?' | sed 's/^\${//; s/:?$//' | sort -u); do
    case "$key" in POSTGRES_APP_PASSWORD|REDIS_PASSWORD) continue ;; esac
    [ -n "$(read_env "$key")" ] || preflight_fail "variable obligatoire $key absente (ou vide) dans .env — exigée par le docker-compose à déployer."
  done
  check_disk_space "$SCRIPT_DIR" || PREFLIGHT_ERRORS=$((PREFLIGHT_ERRORS + 1))
  [ "$PREFLIGHT_ERRORS" -eq 0 ]
}

# Retour arrière COMMUN (mise à jour automatique ET manuelle). Arguments : commit précédent (vide si
# pas de git), version précédente, images api/web précédentes (vides = construction locale), dump
# pré-mise-à-jour, version de schéma d'avant. L'API est ARRÊTÉE avant de lire la version de schéma
# (sinon une migration pourrait encore tourner) ; un état illisible vaut « migré/inconnu » ⇒ la base
# est restaurée depuis le dump. Renvoie 0 si la version précédente est de nouveau saine.
perform_rollback() {
  local prev="$1" cur_ver="$2" old_api="$3" old_web="$4" dump="$5" schema_before="$6" schema_after
  stop_api
  schema_after="$(db_schema_version)"
  if [ -n "$prev" ]; then git -C "$SCRIPT_DIR" reset --hard -q "$prev" 2>/dev/null || true; fi
  set_env_var ELIUM_VERSION "${cur_ver:-dev}"
  # Images précédentes (digest) ou construction locale si on n'en utilisait pas.
  set_env_var ELIUM_API_IMAGE "$old_api"; set_env_var ELIUM_WEB_IMAGE "$old_web"
  if rollback_needs_db_restore "$schema_before" "$schema_after"; then
    if [ -z "$schema_after" ] || [ -z "$schema_before" ]; then
      warn "État de la base illisible (avant : ${schema_before:-?}, après : ${schema_after:-?}) — considéré comme migré : restauration de la base."
    else
      warn "Des migrations avaient été appliquées (${schema_before} → $schema_after) : restauration de la base."
    fi
    ulog "restoring DB from $dump (schema ${schema_after:-?} -> ${schema_before:-?})"
    if ! restore_db_dump "$dump"; then
      ulog "DB RESTORE FAILED — manual intervention required (dump: $dump)"
      die "Restauration de la base en échec — intervention requise. Dump : $dump (voir $UPDATE_LOG). La base courante n'a pas été modifiée par la restauration."
    fi
  fi
  compose_up_stack && wait_health
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
# Valeurs par défaut (globales) ; analysées dans main() — AUCUN code exécutable hors fonction, voir la
# fin du fichier.
CMD="menu"
DOMAIN=""; LOCAL=0; EMAIL=""; STORAGE="fs"; STORAGE_EXPLICIT=0; HTTP_PORT="80"
ASSUME_YES=0; DRY_RUN=0; ARG1=""
parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --domain) DOMAIN="${2:-}"; shift 2 ;;
      --local) LOCAL=1; shift ;;
      --email) EMAIL="${2:-}"; shift 2 ;;
      --storage) STORAGE="${2:-fs}"; STORAGE_EXPLICIT=1; shift 2 ;;
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
}

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

  # Stockage : sur une installation EXISTANTE, le driver déjà configuré est conservé tant que
  # --storage n'est pas passé explicitement (basculer fs <-> s3 sans migration rendrait les blobs
  # inaccessibles).
  local existing_driver; existing_driver="$(read_env STORAGE_DRIVER)"
  if [ "$STORAGE_EXPLICIT" != "1" ] && [ -n "$existing_driver" ]; then STORAGE="$existing_driver"; fi
  if [ "$ASSUME_YES" != "1" ]; then
    STORAGE="$(prompt "Stockage des blobs : fs (volume) ou s3 (MinIO)" "$STORAGE")"
  fi
  [ "$STORAGE" = "s3" ] || [ "$STORAGE" = "fs" ] || die "Stockage invalide : $STORAGE (attendu fs ou s3)."

  # Installation existante : `drive` n'est PAS la commande de mise à jour (elle ne sauvegarde pas la
  # base et ne fait aucun retour arrière). On ne touche qu'aux clés gérées de .env ; toute autre clé
  # (OWNER_EMAIL, SINGLE_DRIVE, TRUST_PROXY, S3_ENDPOINT, MINIO_IMAGE, REDIS_URL…) est conservée telle
  # quelle, et aucun secret existant n'est régénéré.
  if [ -f "$ENV_FILE" ]; then
    warn "Installation existante détectée (.env présent). Pour METTRE À JOUR, utilisez « bash install.sh update » — pas « drive »."
    if [ "$ASSUME_YES" != "1" ] && [ "$DRY_RUN" != "1" ]; then
      local go; go="$(prompt "Reconfigurer quand même ? Tapez 'oui'" "")"
      [ "$go" = "oui" ] || die "Annulé (rien n'a été modifié)."
    fi
    backup_env_file || die "Copie de sauvegarde de .env impossible — abandon."
    ok "Ancien .env sauvegardé dans backups/ (env-<horodatage>, droits 600)."
  else
    {
      echo "# Généré par install.sh le $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
      echo "# NE PAS COMMITER. Sauvegardez TOKEN_SECRET : le perdre invalide les"
      echo "# sessions et les secrets MFA (mais PAS les données, chiffrées côté client)."
    } > "$ENV_FILE"
    chmod 600 "$ENV_FILE" 2>/dev/null || true
  fi

  # Clés gérées : réglages de déploiement (mis à jour) ; secrets et réglages à valeur initiale
  # (écrits seulement s'ils manquent).
  set_env_var SITE_ADDRESS "$site"
  [ -z "$EMAIL" ] || set_env_var ACME_EMAIL "$EMAIL"
  set_env_var ELIUM_VERSION "$(repo_version)"
  set_env_var STORAGE_DRIVER "$STORAGE"
  env_set_missing TOKEN_SECRET "$(gen_secret)"
  env_set_missing POSTGRES_PASSWORD "$(gen_secret)"
  env_set_missing POSTGRES_APP_PASSWORD "$(gen_secret)"
  env_set_missing WEBAUTHN_RP_ID "${DOMAIN:-localhost}"
  env_set_missing CORS_ORIGINS "$cors"
  # Clé d'accès S3 propre au déploiement : la valeur historique « elium » est refusée par l'API en production.
  env_set_missing S3_ACCESS_KEY "elium-$(gen_secret | cut -c1-16)"
  env_set_missing S3_SECRET_KEY "$(gen_secret)"
  env_set_missing S3_BUCKET "elium-blobs"
  env_set_missing REDIS_PASSWORD "$(gen_secret)"
  case ",$(read_env CORS_ORIGINS)," in
    *",$origin,"*) : ;;
    *) warn "CORS_ORIGINS (« $(read_env CORS_ORIGINS) ») ne contient pas $origin : conservé tel quel — corrigez .env si besoin." ;;
  esac
  [ "$(read_env S3_ACCESS_KEY)" != "elium" ] || warn "S3_ACCESS_KEY=elium (valeur par défaut) : refusée par l'API en production avec STORAGE_DRIVER=s3 — voir la documentation d'exploitation."
  chmod 600 "$ENV_FILE" 2>/dev/null || true
  ok "Configuration écrite dans .env (droits 600) — clés inconnues et secrets existants conservés"

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

# Carte « nouvelle version » du site public (release.json).
# L'identité de CE déploiement (version, date de build, notes) est embarquée dans
# l'image web elle-même (générée par `gen-release-info.mjs` au build) ; on l'extrait
# de l'image EN SERVICE (jamais périmée, même après un self-update) pour servir de
# base à `deploy/release-feed.py`, qui y ajoute la dernière publication GitHub.
# Repli sur `web-dist/release.json` pour une install qui reconstruit localement
# (pas d'image épinglée). Jamais fatal : la carte est cosmétique.
do_release_feed() {
  command -v python3 >/dev/null 2>&1 || { warn "python3 requis pour rafraîchir release.json — ignoré."; return 0; }
  mkdir -p "$SCRIPT_DIR/release"
  detect_compose
  local web_image base; web_image="$($DC images -q web 2>/dev/null | head -n1)"; base="$SCRIPT_DIR/release/.base-release.json"
  if [ -n "$web_image" ] && command -v docker >/dev/null 2>&1 \
     && docker run --rm --entrypoint cat "$web_image" /usr/share/caddy/release.json > "$base" 2>/dev/null; then
    :
  elif [ -f "$SCRIPT_DIR/web-dist/release.json" ]; then
    cp "$SCRIPT_DIR/web-dist/release.json" "$base"
  else
    warn "release.json : aucune source (ni image épinglée, ni web-dist/) — ignoré."; return 0
  fi
  python3 "$SCRIPT_DIR/deploy/release-feed.py" --base "$base" --out "$SCRIPT_DIR/release/release.json"
  rm -f "$base"
}

do_update() {
  detect_compose; [ -n "$DC" ] || die "Docker Compose requis."
  [ -f "$ENV_FILE" ] || die "Aucun .env — lancez d'abord : bash install.sh drive"
  if images_pinned; then
    do_self_update
    return
  fi
  # Chemin « construction sur place » : AVEC filet, comme l'auto-update. Ordre : pré-vérifications →
  # version en service → sauvegarde vérifiée (rien n'est modifié tant qu'elle n'a pas réussi) →
  # git pull → redémarrage ; en cas d'échec, retour arrière (code + base si besoin).
  local prev="" old_version dump schema_before
  if command -v git >/dev/null 2>&1 && [ -d "$SCRIPT_DIR/.git" ]; then
    prev="$(git -C "$SCRIPT_DIR" rev-parse HEAD 2>/dev/null || true)"
  fi
  preflight_update || die "Pré-vérifications en échec — mise à jour ABANDONNÉE (rien n'a été modifié)."
  old_version="$(running_version)" || die "Version API illisible — mise à jour ABANDONNÉE (rien n'a été modifié)."
  dump="$(backup_db_preupdate)" || die "Sauvegarde de la base impossible ou non vérifiée — mise à jour ABANDONNÉE (rien n'a été modifié, la pile n'a pas été redémarrée)."
  ok "Base sauvegardée avant mise à jour : $dump"
  schema_before="$(sed -n 's/^schema_version=//p' "${dump%.sql.gz}.meta" | head -n1)"
  ensure_env_secrets
  if [ -n "$prev" ]; then
    info "git pull…"; git pull --ff-only || warn "git pull ignoré (arbre modifié ou hors dépôt)."
    # Le docker-compose tiré peut exiger d'autres variables : revérifier, sinon revenir au commit d'avant.
    if ! preflight_update; then
      git -C "$SCRIPT_DIR" reset --hard -q "$prev" 2>/dev/null || true
      die "Pré-vérifications en échec avec la nouvelle version — code remis à l'état précédent, pile non redémarrée. Sauvegarde : $dump"
    fi
  fi
  info "Reconstruction + redémarrage…"
  set_env_var ELIUM_VERSION "$(repo_version)"
  if ! compose_up_stack || ! wait_health; then
    warn "Redémarrage en échec — retour à ${old_version:-la version précédente}."
    if perform_rollback "$prev" "$old_version" "" "" "$dump" "$schema_before"; then
      die "Mise à jour en échec : version précédente rétablie. Sauvegarde : $dump"
    fi
    die "Redémarrage ET retour arrière en échec — intervention requise. Sauvegarde : $dump ($DC logs api)"
  fi
  do_release_feed || warn "release.json (carte de mise à jour du site) non rafraîchi — sans conséquence sur le service."
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
  cur_ver="$(running_version)" || { warn "Version API illisible — mise à jour abandonnée."; return 1; }
  [ -n "$remote_ver" ] || { warn "Version absente du manifeste."; return 0; }

  do_release_feed || ulog "release-feed: échec (sans conséquence sur le service)"
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

  # Pré-vérifications AVANT toute modification : configuration (stockage, MinIO, clés S3, variables
  # exigées par le docker-compose de la version cible), espace disque, images tirables. Échec =
  # abandon, rien n'a été touché (ni git, ni .env, ni pile).
  if ! preflight_update "$(git -C "$SCRIPT_DIR" show "${target}:docker-compose.yml" 2>/dev/null || true)"; then
    warn "Pré-vérifications en échec — mise à jour ABANDONNÉE (rien n'a été modifié). Corrigez puis relancez."
    ulog "ABORT: preflight failed (no change made)"
    return 1
  fi
  if [ -n "$new_api" ] && [ -n "$new_web" ] && command -v docker >/dev/null 2>&1; then
    local img
    for img in "$new_api" "$new_web"; do
      if ! docker pull -q "$img" >/dev/null 2>&1; then
        warn "Image inaccessible : $img (paquet GHCR privé ? réseau ?) — mise à jour ABANDONNÉE (rien n'a été modifié)."
        ulog "ABORT: image pull failed ($img) (no change made)"
        return 1
      fi
    done
  fi

  # Sauvegarde OBLIGATOIRE : si elle échoue, on s'arrête AVANT toute modification.
  info "Sauvegarde de la base avant migration…"
  local dump schema_before
  if ! dump="$(backup_db_preupdate)"; then
    warn "Sauvegarde de la base IMPOSSIBLE ou non vérifiée — mise à jour ABANDONNÉE (rien n'a été modifié)."
    ulog "ABORT: pre-update backup failed (no change made)"
    return 1
  fi
  schema_before="$(sed -n 's/^schema_version=//p' "${dump%.sql.gz}.meta" | head -n1)"
  ulog "backup ok: $dump (schema ${schema_before:-?})"

  # Secrets introduits par la nouvelle version (ajoutés s'ils manquent, jamais régénérés), AVANT la bascule.
  ensure_env_secrets

  info "Bascule sur $remote_ver ($(printf '%.12s' "$target"))…"
  git -C "$SCRIPT_DIR" checkout -q master 2>/dev/null || true
  if ! git -C "$SCRIPT_DIR" reset --hard -q "$target" 2>/dev/null; then
    git -C "$SCRIPT_DIR" reset --hard -q "$prev" 2>/dev/null || true
    warn "Bascule git échouée (arbre remis à l'état précédent)."; ulog "fail: reset $target"; return 0
  fi
  set_env_var ELIUM_VERSION "$remote_ver"
  if [ -n "$new_api" ] && [ -n "$new_web" ]; then
    set_env_var ELIUM_API_IMAGE "$new_api"; set_env_var ELIUM_WEB_IMAGE "$new_web"
  else
    set_env_var ELIUM_API_IMAGE ""; set_env_var ELIUM_WEB_IMAGE ""
  fi

  info "Redémarrage de la pile…"
  if compose_up_stack && wait_health; then
    hr; ok "${bold}Mise à jour appliquée : $remote_ver.${rst} (migrations idempotentes rejouées)"
    ulog "success -> $remote_ver ($target)"
    do_release_feed || ulog "release-feed: échec (sans conséquence sur le service)"
    prune_update_backups
    return 0
  fi

  # ---------- Rollback automatique ----------
  hr; warn "Health-check en échec après mise à jour — RETOUR à ${cur_ver:-la version précédente}."
  ulog "health failed after $remote_ver -> rollback to $prev"
  if perform_rollback "$prev" "$cur_ver" "$old_api" "$old_web" "$dump" "$schema_before"; then
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

  info "Copie de .env…"
  backup_env_file "$ts" || die "Copie de .env impossible."

  info "Sauvegarde Postgres…"
  if ! _pgdump --clean --if-exists "$DB_NAME" | gzip > "$out/elium-db-$ts.sql.gz.part"; then
    rm -f "$out/elium-db-$ts.sql.gz.part"; die "pg_dump en échec — sauvegarde abandonnée."
  fi
  if ! verify_dump_file "$out/elium-db-$ts.sql.gz.part"; then
    rm -f "$out/elium-db-$ts.sql.gz.part"; die "Dump incomplet ou trop petit — sauvegarde abandonnée."
  fi
  mv "$out/elium-db-$ts.sql.gz.part" "$out/elium-db-$ts.sql.gz"

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

  ok "Sauvegardes écrites dans $out (base + blobs + .env, chiffrés E2E ; backend : $backend)."
  # Copie hors machine optionnelle (BACKUP_RCLONE_REMOTE=<remote>:<chemin> dans .env).
  offsite_push "$ts" || true
  warn "Conservez-les sur un support chiffré (le fichier env-$ts contient TOUS vos secrets). Sans les clés côté clients, les données restent illisibles (zéro-connaissance)."
}

# shellcheck disable=SC2120  # les arguments (fichier de sauvegarde) sont optionnels, lus via $1 quand fournis
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
  # Le dump doit être COMPLET avant qu'on touche à quoi que ce soit.
  verify_dump_file "$db_file" 0 || die "Le dump $db_file est illisible ou incomplet — restauration refusée (rien n'a été modifié)."
  # Backend d'origine de la sauvegarde (marqueur écrit par do_backup). Absent
  # (anciennes sauvegardes) ⇒ fs.
  local backend="fs"
  [ -f "$meta_file" ] && backend="$(sed -n 's/^backend=//p' "$meta_file" | head -n1)"
  [ -n "$backend" ] || backend="fs"

  # Profil compose pour joindre MinIO le cas échéant.
  local profile=(); [ "$(read_env STORAGE_DRIVER)" = "s3" ] && profile=(--profile s3)

  hr
  warn "Cette opération va REMPLACER l'état actuel (base de données ET blobs) par la sauvegarde du $ts (backend : $backend)."
  say "  La base actuelle est d'abord sauvegardée, puis conservée sous un nom daté après la bascule."
  if [ "$ASSUME_YES" != "1" ]; then
    local c; c="$(prompt "Tapez 'restore' pour confirmer, autre chose pour annuler" "")"
    [ "$c" = "restore" ] || die "Restauration annulée."
  fi

  # Sauvegarde de l'état COURANT avant écrasement (sauf base vide : sinistre sur machine neuve).
  local ntables cur_dump
  ensure_db_running
  ntables="$(_psql "$DB_NAME" -Atqc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'" 2>/dev/null | tr -d '[:space:]' || true)"
  if [ -n "$ntables" ] && [ "$ntables" != "0" ]; then
    info "Sauvegarde de l'état courant avant écrasement…"
    if cur_dump="$(backup_db_preupdate prerestore)"; then
      ok "État courant sauvegardé : $cur_dump"
    else
      warn "Sauvegarde de l'état courant IMPOSSIBLE."
      if [ "${ELIUM_RESTORE_SKIP_CURRENT_BACKUP:-0}" = "1" ]; then
        warn "ELIUM_RESTORE_SKIP_CURRENT_BACKUP=1 : on continue sans (la base actuelle reste tout de même conservée sous un nom daté)."
      elif [ "$ASSUME_YES" = "1" ]; then
        die "Restauration abandonnée (rien n'a été modifié). Libérez de l'espace, ou ELIUM_RESTORE_SKIP_CURRENT_BACKUP=1 pour passer outre."
      else
        local c2; c2="$(prompt "Continuer SANS sauvegarde de l'état actuel ? Tapez 'oui'" "")"
        [ "$c2" = "oui" ] || die "Restauration annulée (rien n'a été modifié)."
      fi
    fi
  else
    info "Base actuelle vide (ou illisible) : pas de sauvegarde de l'état courant."
  fi

  info "Arrêt du service api…"
  stop_api

  info "Restauration de Postgres depuis $db_file…"
  restore_db_dump "$db_file" || die "Restauration de la base en échec — la base courante n'a pas été modifiée. Blobs non touchés."

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
  [ -z "${PREVIOUS_DB_KEPT_AS:-}" ] || say "  Ancienne base conservée sous « ${PREVIOUS_DB_KEPT_AS} » (à supprimer une fois la restauration validée)."
}

show_help() { sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'; }

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

main() {
  CMD="${1:-menu}"; [ $# -gt 0 ] && shift || true
  parse_args "$@"
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
    release-feed) do_release_feed ;;
    help|-h|--help) show_help ;;
    *) die "Commande inconnue : $CMD (essayez : bash install.sh help)" ;;
  esac
}

# ----------------------------------------------------------------------------
# DERNIÈRE instruction du fichier. Tout le code exécutable est dans des fonctions, entièrement lues
# AVANT le premier appel : bash relit un script par OFFSETS, donc un `git reset --hard` / `git pull`
# qui réécrit install.sh PENDANT son exécution ferait exécuter des fragments du nouveau fichier.
# Ici, une fois cette ligne lue, plus rien n'est relu depuis le disque (« exit » est dans le même
# bloc). Sourcé (tests), `main` n'est pas lancé.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then main "$@"; exit $?; fi
