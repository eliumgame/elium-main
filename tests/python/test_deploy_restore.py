# ruff: noqa: S603, S607  # sous-processus de test : binaires et scripts du dépôt, jamais d'entrée non fiable
"""Chaîne de déploiement : restauration atomique, rollback, pré-vérifications, .env, réécriture du script.

Rien ici ne touche à l'.env de l'opérateur ni à Docker : tout se joue dans un dossier jetable, avec
des faux `psql`/`pg_dump`, et — si un binaire PostgreSQL est disponible — avec un vrai cluster.
"""

import glob
import gzip
import os
import shutil
import socket
import subprocess
import textwrap
from pathlib import Path

import pytest


def write_lf(path, text):
    """Écrit `text` en LF partout (Path.write_text(newline=) exige Python 3.10+)."""
    path.write_bytes(text.encode("utf-8"))


ROOT = Path(__file__).resolve().parents[2]
BASH = shutil.which("bash") or ("C:/Program Files/Git/bin/bash.exe" if os.name == "nt" else None)

DUMP_OK = (
    "--\n-- PostgreSQL database dump\n--\n"
    "DROP TABLE IF EXISTS public.users;\n"
    "CREATE TABLE public.users (\n    id integer NOT NULL,\n    email text\n);\n"
    "CREATE TABLE public.empty_t (\n    id integer\n);\n"
    "COPY public.users (id, email) FROM stdin;\n1\ta@x.fr\n\\.\n"
    "COPY public.empty_t (id) FROM stdin;\n\\.\n"
    "--\n-- PostgreSQL database dump complete\n--\n"
)


def posix(p):
    return Path(p).as_posix()


def need_bash():
    if not BASH or not Path(BASH).is_file():
        pytest.skip("bash unavailable")


def sh(tmp_path, body, env=None, timeout=60):
    """Source install.sh (copie jetable) puis exécute `body`."""
    need_bash()
    (tmp_path / "install.sh").write_bytes((ROOT / "install.sh").read_bytes())
    full_env = {**os.environ, "ELIUM_NO_UPDATE": "1"}
    full_env.update(env or {})
    return subprocess.run(  # noqa: S603
        [BASH, "-c", "source ./install.sh help >/dev/null\nset +e\n" + body],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        timeout=timeout,
        env=full_env,
        stdin=subprocess.DEVNULL,
    )


def write_gz(path, text):
    with gzip.open(path, "wb") as f:
        f.write(text.encode("utf-8"))


def fake_psql(tmp_path):
    script = tmp_path / "fakepsql"
    write_lf(
        script,
        textwrap.dedent("""\
        #!/usr/bin/env bash
        printf 'ARGS %s\\n' "$*" >> "$FAKE_LOG"
        data="$(cat)"
        if [ -n "$data" ]; then printf 'STDIN-BEGIN\\n%s\\nSTDIN-END\\n' "$data" >> "$FAKE_LOG"; fi
        exit 0
        """),
    )
    script.chmod(0o755)
    return script


# --- 1. restauration atomique (commandes enregistrées) ------------------------------------------


def test_restore_replays_in_temp_db_single_transaction_then_swaps(tmp_path):
    dump = tmp_path / "d.sql.gz"
    write_gz(dump, DUMP_OK)
    log = tmp_path / "log.txt"
    result = sh(
        tmp_path,
        f"""
stop_api() {{ echo STOP_API >> "$FAKE_LOG"; }}
ensure_db_running() {{ :; }}
post_restore_hook() {{ echo HOOK >> "$FAKE_LOG"; }}
restore_db_dump {posix(dump)}
""",
        env={"ELIUM_PSQL": posix(fake_psql(tmp_path)), "FAKE_LOG": posix(log)},
    )
    assert result.returncode == 0, result.stdout + result.stderr
    text = log.read_text(encoding="utf-8")
    lines = [ln for ln in text.splitlines() if ln.startswith(("ARGS", "STOP_API", "HOOK"))]
    joined = "\n".join(lines)
    # Le dump n'est JAMAIS rejoué dans la base vivante : seule la base temporaire le reçoit.
    assert "DROP TABLE IF EXISTS public.users;" in text
    replay = [ln for ln in lines if "--single-transaction" in ln]
    assert len(replay) == 1
    assert "-d elium_restore" in replay[0] and "ON_ERROR_STOP=1" in replay[0] and "-f -" in replay[0]
    assert not any(ln.startswith("ARGS -d elium ") and "-f -" in ln for ln in lines)
    # Ordre : api arrêtée -> base temporaire -> rejeu -> contrôle -> bascule -> db-init.
    order = [
        joined.index("STOP_API"),
        joined.index('CREATE DATABASE "elium_restore"'),
        joined.index("--single-transaction"),
        joined.index('RENAME TO "elium_before_restore_'),
        joined.index('ALTER DATABASE "elium_restore" RENAME TO "elium"'),
        joined.index("HOOK"),
    ]
    assert order == sorted(order)
    # Le contrôle post-restauration vérifie les tables et les tables non vides.
    assert "SELECT 1 FROM public.users LIMIT 0;" in text
    assert "SELECT 1 FROM public.users)" in text
    assert "SELECT 1 FROM public.empty_t)" not in text  # vide dans le dump : pas exigée non vide


def test_restore_refuses_incomplete_dump_without_touching_anything(tmp_path):
    dump = tmp_path / "d.sql.gz"
    write_gz(dump, DUMP_OK.replace("PostgreSQL database dump complete", "tronque"))
    log = tmp_path / "log.txt"
    result = sh(
        tmp_path,
        f"""
stop_api() {{ echo STOP_API >> "$FAKE_LOG"; }}
restore_db_dump {posix(dump)}
""",
        env={"ELIUM_PSQL": posix(fake_psql(tmp_path)), "FAKE_LOG": posix(log)},
    )
    assert result.returncode != 0
    assert not log.exists() or log.read_text(encoding="utf-8") == ""


def test_restore_failure_in_replay_leaves_live_db_alone(tmp_path):
    dump = tmp_path / "d.sql.gz"
    write_gz(dump, DUMP_OK)
    log = tmp_path / "log.txt"
    failing = tmp_path / "failpsql"
    write_lf(
        failing,
        '#!/usr/bin/env bash\nprintf \'ARGS %s\\n\' "$*" >> "$FAKE_LOG"\ncat >/dev/null\n'
        'case "$*" in *--single-transaction*) exit 3 ;; esac\nexit 0\n',
    )
    failing.chmod(0o755)
    result = sh(
        tmp_path,
        f"""
stop_api() {{ :; }}
ensure_db_running() {{ :; }}
post_restore_hook() {{ echo HOOK >> "$FAKE_LOG"; }}
restore_db_dump {posix(dump)}
""",
        env={"ELIUM_PSQL": posix(failing), "FAKE_LOG": posix(log)},
    )
    assert result.returncode != 0
    text = log.read_text(encoding="utf-8")
    assert "RENAME" not in text and "HOOK" not in text
    assert 'DROP DATABASE IF EXISTS "elium_restore"' in text  # base temporaire nettoyée


# --- 2. restauration réelle (si un binaire PostgreSQL est disponible) ----------------------------


def find_pg_bin():
    names = ["initdb", "pg_ctl", "psql", "pg_dump"]
    ext = ".exe" if os.name == "nt" else ""
    dirs = []
    for pattern in (
        str(ROOT / "server/node_modules/embedded-postgres/**/bin"),
        str(ROOT / "server/node_modules/@embedded-postgres/**/bin"),
        "/usr/lib/postgresql/*/bin",
        "C:/Program Files/PostgreSQL/*/bin",
    ):
        dirs += glob.glob(pattern, recursive=True)
    which_psql = shutil.which("psql")
    if which_psql:
        dirs.append(str(Path(which_psql).parent))
    for d in dirs:
        if all((Path(d) / (n + ext)).is_file() for n in names):
            return Path(d)
    return None


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture
def pg(tmp_path):
    bindir = find_pg_bin()
    if bindir is None:
        pytest.skip("aucun binaire PostgreSQL (initdb/pg_ctl/psql/pg_dump) trouvé : test réel ignoré")
    if hasattr(os, "geteuid") and os.geteuid() == 0:
        pytest.skip("initdb refuse de tourner en root")
    if os.name == "nt":
        # Les runners Windows préinstallent PostgreSQL, mais pg_ctl n'y démarre pas sous un compte administrateur.
        # Ces tests sur vraie base tournent sous Linux (CI) ; ici ils sont ignorés plutôt que d'échouer pour rien.
        pytest.skip("démarrage d'un PostgreSQL de test non fiable sous Windows")
    ext = ".exe" if os.name == "nt" else ""
    data = tmp_path / "pgdata"
    port = free_port()
    exe = lambda n: str(bindir / (n + ext))  # noqa: E731
    subprocess.run(
        [exe("initdb"), "-D", str(data), "-U", "elium", "--auth=trust", "-E", "UTF8"],  # noqa: S603
        check=True,
        capture_output=True,
    )
    subprocess.run(
        [
            exe("pg_ctl"),
            "-D",
            str(data),
            "-o",
            f"-p {port} -c listen_addresses=127.0.0.1 -c unix_socket_directories={data}",  # noqa: E501  # noqa: S603
            "-w",
            "-l",
            str(tmp_path / "pg.log"),
            "start",
        ],
        check=True,
        capture_output=True,
    )
    wrappers = {}
    for tool in ("psql", "pg_dump"):
        w = tmp_path / f"w_{tool}"
        flags = "-X" if tool == "psql" else ""
        write_lf(w, f'#!/usr/bin/env bash\nexec "{posix(exe(tool))}" -h 127.0.0.1 -p {port} -U elium {flags} "$@"\n')
        w.chmod(0o755)
        wrappers[tool] = w
    yield {"psql": wrappers["psql"], "pg_dump": wrappers["pg_dump"], "exe": exe, "port": port}
    subprocess.run(
        [exe("pg_ctl"), "-D", str(data), "-m", "immediate", "stop"],  # noqa: S603
        capture_output=True,
    )


def q(pg, db, sql):
    r = subprocess.run(
        [BASH, posix(pg["psql"]), "-d", db, "-Atqc", sql],  # noqa: S603
        capture_output=True,
        text=True,
        stdin=subprocess.DEVNULL,
    )
    assert r.returncode == 0, r.stderr
    return r.stdout.strip()


def test_real_postgres_restore_of_old_schema_dump_into_migrated_db(tmp_path, pg):
    need_bash()
    q(pg, "postgres", "CREATE ROLE elium_app LOGIN")
    q(pg, "postgres", "CREATE DATABASE elium")
    q(
        pg,
        "elium",
        """
        CREATE TABLE organizations (id serial PRIMARY KEY, name text);
        CREATE TABLE users (id serial PRIMARY KEY, email text, org int REFERENCES organizations(id));
        INSERT INTO organizations (name) VALUES ('acme'), ('globex');
        INSERT INTO users (email, org) VALUES ('a@x.fr', 1), ('b@x.fr', 2), ('c@x.fr', 1);
    """,
    )
    dump = tmp_path / "old.sql.gz"
    r = subprocess.run(
        [BASH, "-c", f'"{posix(pg["pg_dump"])}" --clean --if-exists elium | gzip > "{posix(dump)}"'],  # noqa: S603
        capture_output=True,
        text=True,
        stdin=subprocess.DEVNULL,
    )
    assert r.returncode == 0, r.stderr
    # « Migration » : nouvelles tables avec FK vers users/organizations (le cas 0009 / 0019), et une
    # modification de données qui doit être annulée par la restauration.
    q(
        pg,
        "elium",
        """
        CREATE TABLE password_resets (id serial PRIMARY KEY, user_id int REFERENCES users(id));
        CREATE TABLE sso_nonces (id serial PRIMARY KEY, org_id int REFERENCES organizations(id));
        INSERT INTO password_resets (user_id) VALUES (1);
        INSERT INTO sso_nonces (org_id) VALUES (1);
        DELETE FROM password_resets; DELETE FROM sso_nonces; DELETE FROM users WHERE id = 3;
    """,
    )
    result = sh(
        tmp_path,
        f"""
stop_api() {{ :; }}
ensure_db_running() {{ :; }}
post_restore_hook() {{ :; }}
restore_db_dump {posix(dump)}
echo "KEPT=$PREVIOUS_DB_KEPT_AS"
""",
        env={"ELIUM_PSQL": posix(pg["psql"]), "ELIUM_PGDUMP": posix(pg["pg_dump"]), "ELIUM_DB_WAIT_TRIES": "3"},
    )
    assert result.returncode == 0, result.stdout + result.stderr
    # Données d'origine intactes (3 utilisateurs, 2 organisations), tables ajoutées absentes.
    assert q(pg, "elium", "SELECT count(*) FROM users") == "3"
    assert q(pg, "elium", "SELECT count(*) FROM organizations") == "2"
    assert q(pg, "elium", "SELECT to_regclass('public.password_resets') IS NULL") == "t"
    assert q(pg, "elium", "SELECT to_regclass('public.sso_nonces') IS NULL") == "t"
    # L'ancienne base (migrée) est conservée, avec ses tables ajoutées.
    kept = [ln for ln in result.stdout.splitlines() if ln.startswith("KEPT=")][0][5:]
    assert kept.startswith("elium_before_restore_")
    assert q(pg, kept, "SELECT to_regclass('public.password_resets') IS NOT NULL") == "t"
    assert q(pg, kept, "SELECT count(*) FROM users") == "2"
    assert q(pg, "postgres", "SELECT count(*) FROM pg_database WHERE datname = 'elium_restore'") == "0"


def test_real_postgres_failed_restore_leaves_live_db_untouched(tmp_path, pg):
    need_bash()
    q(pg, "postgres", "CREATE DATABASE elium")
    q(pg, "elium", "CREATE TABLE users (id int); INSERT INTO users VALUES (1),(2)")
    bad = tmp_path / "bad.sql.gz"
    write_gz(
        bad,
        "CREATE TABLE public.users (id integer);\nINSERT INTO nope VALUES (1);\n-- PostgreSQL database dump complete\n",
    )
    result = sh(
        tmp_path,
        f"""
stop_api() {{ :; }}
ensure_db_running() {{ :; }}
post_restore_hook() {{ :; }}
restore_db_dump {posix(bad)}
""",
        env={"ELIUM_PSQL": posix(pg["psql"]), "ELIUM_DB_WAIT_TRIES": "3"},
    )
    assert result.returncode != 0
    assert q(pg, "elium", "SELECT count(*) FROM users") == "2"
    assert q(pg, "postgres", "SELECT count(*) FROM pg_database WHERE datname LIKE 'elium_%'") == "0"


# --- 3. rollback : décision de restauration --------------------------------------------------------


@pytest.mark.parametrize(
    "before,after,expected",
    [
        ("0018", "0019", 0),  # schéma changé
        ("0019", "0019", 1),  # inchangé
        ("0018", "", 0),  # base illisible après : considéré migré
        ("", "0019", 0),  # état d'avant inconnu
        ("", "", 0),
    ],
)
def test_rollback_restores_when_state_unreadable(tmp_path, before, after, expected):
    result = sh(tmp_path, f'rollback_needs_db_restore "{before}" "{after}"; echo $?')
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == str(expected)


def test_rollback_stops_api_before_reading_schema(tmp_path):
    result = sh(
        tmp_path,
        """
stop_api() { echo stop >> "$PWD/calls"; }
db_schema_version() { echo read >> "$PWD/calls"; }
restore_db_dump() { echo restore >> "$PWD/calls"; }
compose_up_stack() { echo up; }
wait_health() { return 0; }
set_env_var() { :; }
perform_rollback "" 4.31.0 "" "" /nonexistent ""
""",
    )
    assert result.returncode == 0, result.stdout + result.stderr
    out = (tmp_path / "calls").read_text(encoding="utf-8").split()
    assert out.index("stop") < out.index("read")
    assert "restore" in out  # schéma d'avant vide => restauration


# --- 4. wait_health --------------------------------------------------------------------------------


def test_wait_health_times_out_without_migration(tmp_path):
    result = sh(
        tmp_path,
        """
api_healthy() { return 1; }
migration_in_progress() { return 1; }
wait_health; echo rc=$?
""",
        env={"ELIUM_HEALTH_TIMEOUT_S": "2", "ELIUM_HEALTH_STEP_S": "1"},
    )
    assert "rc=1" in result.stdout


def test_wait_health_extends_while_migration_runs(tmp_path):
    result = sh(
        tmp_path,
        """
n=0
api_healthy() { n=$((n+1)); [ "$n" -ge 6 ]; }
migration_in_progress() { return 0; }
wait_health; echo rc=$?
""",
        env={"ELIUM_HEALTH_TIMEOUT_S": "2", "ELIUM_HEALTH_MAX_S": "20", "ELIUM_HEALTH_STEP_S": "1"},
    )
    assert "rc=0" in result.stdout
    assert "migration" in result.stdout.lower()


def test_wait_health_default_is_300_seconds():
    text = (ROOT / "install.sh").read_text(encoding="utf-8")
    assert "ELIUM_HEALTH_TIMEOUT_S:-300" in text


# --- 5. sauvegarde pré-opération -------------------------------------------------------------------


def make_dump_cmd(tmp_path, text, rc=0):
    src = tmp_path / "dump.txt"
    write_lf(src, text)
    cmd = tmp_path / "fakedump"
    write_lf(cmd, f'#!/usr/bin/env bash\ncat "{posix(src)}"\nexit {rc}\n')
    cmd.chmod(0o755)
    return cmd


PAD = "-- " + "x" * 3000 + "\n"


def test_preupdate_backup_copies_env_and_verifies_dump(tmp_path):
    (tmp_path / ".env").write_text("TOKEN_SECRET=s\n", encoding="utf-8")
    cmd = make_dump_cmd(tmp_path, PAD + DUMP_OK)
    result = sh(
        tmp_path,
        """
running_version() { echo 4.31.0; }
db_schema_version() { echo 0018; }
check_disk_space() { return 0; }
d="$(backup_db_preupdate 2>/dev/null)"; echo "DUMP=$d"
""",
        env={"ELIUM_PGDUMP": posix(cmd)},
    )
    assert result.returncode == 0, result.stderr
    dump = [ln for ln in result.stdout.splitlines() if ln.startswith("DUMP=")][0][5:]
    dump = str(tmp_path / "backups" / Path(dump).name)
    assert Path(dump).is_file() and dump.endswith(".sql.gz")
    envs = list((tmp_path / "backups").glob("env-*"))
    assert len(envs) == 1 and envs[0].read_text(encoding="utf-8") == "TOKEN_SECRET=s\n"
    assert "schema_version=0018" in Path(dump[:-7] + ".meta").read_text(encoding="utf-8")


@pytest.mark.parametrize(
    "text,rc",
    [
        (PAD + DUMP_OK.replace("PostgreSQL database dump complete", "stop"), 0),  # tronqué
        ("-- PostgreSQL database dump complete\n", 0),  # trop petit
        (PAD + DUMP_OK, 1),  # pg_dump en erreur
    ],
)
def test_preupdate_backup_aborts_on_bad_dump(tmp_path, text, rc):
    (tmp_path / ".env").write_text("TOKEN_SECRET=s\n", encoding="utf-8")
    cmd = make_dump_cmd(tmp_path, text, rc)
    result = sh(
        tmp_path,
        """
check_disk_space() { return 0; }
if d="$(backup_db_preupdate 2>/dev/null)"; then echo "OK $d"; else echo FAILED; fi
""",
        env={"ELIUM_PGDUMP": posix(cmd)},
    )
    assert "FAILED" in result.stdout
    assert not list((tmp_path / "backups").glob("*.sql.gz*"))


def test_disk_space_check_refuses_when_too_little_free(tmp_path):
    result = sh(tmp_path, 'free_kb() { echo 1000; }\ncheck_disk_space "$PWD"; echo rc=$?')
    assert "rc=1" in result.stdout


def test_backups_and_env_are_gitignored():
    ignore = (ROOT / ".gitignore").read_text(encoding="utf-8").splitlines()
    assert ".env" in ignore and "backups/" in ignore


# --- 6. .env préservé par `install.sh drive` --------------------------------------------------------


def test_drive_rerun_preserves_unknown_keys_and_secrets(tmp_path):
    need_bash()
    (tmp_path / "install.sh").write_bytes((ROOT / "install.sh").read_bytes())
    original = textwrap.dedent("""\
        SITE_ADDRESS=drive.exemple.fr
        TOKEN_SECRET=tok-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789
        POSTGRES_PASSWORD=pgpw
        POSTGRES_APP_PASSWORD=apppw
        CORS_ORIGINS=https://autre.exemple.fr,https://drive.exemple.fr
        STORAGE_DRIVER=s3
        S3_ACCESS_KEY=cleunique
        S3_SECRET_KEY=s3secret
        OWNER_EMAIL=moi@exemple.fr
        SINGLE_DRIVE=true
        TRUST_PROXY=loopback
        S3_ENDPOINT=http://minio:9000
        MINIO_IMAGE=reg/minio@sha256:abc
        UPDATE_INTERVAL_MIN=15
        REDIS_URL=redis://:pw@redis:6379
        WS_ALLOW_QUERY_TOKEN=true
        REDIS_PASSWORD=rpw
        WEBAUTHN_RP_ID=drive.exemple.fr
        """)
    write_lf((tmp_path / ".env"), original)
    result = subprocess.run(  # noqa: S603
        [BASH, "install.sh", "drive", "--dry-run", "--yes", "--domain", "drive.exemple.fr"],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        timeout=60,
        stdin=subprocess.DEVNULL,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    new = dict(
        ln.split("=", 1)
        for ln in (tmp_path / ".env").read_text(encoding="utf-8").splitlines()
        if "=" in ln and not ln.startswith("#")
    )
    old = dict(ln.split("=", 1) for ln in original.splitlines())
    for key, value in old.items():
        assert new[key] == value, key  # rien perdu, rien régénéré, rien recalculé (CORS compris)
    backups = list((tmp_path / "backups").glob("env-*"))
    assert len(backups) == 1 and backups[0].read_text(encoding="utf-8") == original


def test_set_env_var_handles_special_characters(tmp_path):
    (tmp_path / ".env").write_text("A=1\nB=2", encoding="utf-8")  # sans retour ligne final
    result = sh(tmp_path, 'ENV_FILE="$PWD/.env"\nset_env_var A "x&y|z\\\\w"\nset_env_var C new\ncat .env')
    assert result.returncode == 0, result.stderr
    assert result.stdout.splitlines() == ["A=x&y|z\\w", "B=2", "C=new"]


# --- 7. pré-vérifications --------------------------------------------------------------------------


def preflight(tmp_path, env_text, compose=""):
    (tmp_path / ".env").write_text(env_text, encoding="utf-8")
    return sh(
        tmp_path,
        f"""
ENV_FILE="$PWD/.env"
check_disk_space() {{ return 0; }}
preflight_update '{compose}'; echo rc=$?
""",
    )


BASE_ENV = "TOKEN_SECRET=" + "t" * 40 + "\nPOSTGRES_PASSWORD=p\nCORS_ORIGINS=https://x\nS3_SECRET_KEY=s\n"


def test_preflight_ok_for_fs_storage(tmp_path):
    assert "rc=0" in preflight(tmp_path, BASE_ENV + "STORAGE_DRIVER=fs\n").stdout


def test_preflight_rejects_default_s3_key_and_unpinned_minio(tmp_path):
    out = preflight(tmp_path, BASE_ENV + "STORAGE_DRIVER=s3\nS3_ACCESS_KEY=elium\n").stdout
    assert "rc=1" in out and "S3_ACCESS_KEY=elium" in out and "MINIO_IMAGE" in out


def test_preflight_accepts_pinned_minio_with_custom_key(tmp_path):
    env = BASE_ENV + "STORAGE_DRIVER=s3\nS3_ACCESS_KEY=cle-unique\nMINIO_IMAGE=r/minio@sha256:abc\n"
    assert "rc=0" in preflight(tmp_path, env).stdout


def test_preflight_flags_variable_required_by_target_compose(tmp_path):
    out = preflight(tmp_path, BASE_ENV, compose="x: ${NOUVELLE_VAR:?Set it} ${REDIS_PASSWORD:?r}").stdout
    assert "rc=1" in out and "NOUVELLE_VAR" in out and "REDIS_PASSWORD" not in out


def test_preflight_modifies_nothing(tmp_path):
    env = BASE_ENV + "STORAGE_DRIVER=s3\nS3_ACCESS_KEY=elium\n"
    preflight(tmp_path, env)
    assert (tmp_path / ".env").read_text(encoding="utf-8") == env
    assert not (tmp_path / "backups").exists()


def test_images_pinned_only_for_digests(tmp_path):
    def pinned(env_text):
        (tmp_path / ".env").write_text(env_text, encoding="utf-8")
        r = sh(tmp_path, 'ENV_FILE="$PWD/.env"\nimages_pinned && echo yes || echo no')
        return r.stdout.strip()

    assert pinned("ELIUM_API_IMAGE=elium-api:local\nELIUM_WEB_IMAGE=elium-web:local\n") == "no"
    assert pinned("ELIUM_API_IMAGE=ghcr.io/a@sha256:1\nELIUM_WEB_IMAGE=ghcr.io/w@sha256:2\n") == "yes"
    assert pinned("") == "no"


def test_compose_up_never_pulls_local_images(tmp_path):
    (tmp_path / ".env").write_text(
        "ELIUM_API_IMAGE=elium-api:local\nELIUM_WEB_IMAGE=elium-web:local\n", encoding="utf-8"
    )
    result = sh(tmp_path, 'ENV_FILE="$PWD/.env"\nDC="echo DC"\ncompose_up_stack')
    assert "pull" not in result.stdout and "--build" in result.stdout


def test_compose_up_returns_failure_instead_of_dying_on_unpinned_minio(tmp_path):
    (tmp_path / ".env").write_text("STORAGE_DRIVER=s3\n", encoding="utf-8")
    result = sh(tmp_path, 'ENV_FILE="$PWD/.env"\nDC="echo DC"\ncompose_up_stack; echo rc=$?')
    assert "rc=1" in result.stdout


# --- 8. réécriture du script pendant son exécution ----------------------------------------------------


def test_self_rewriting_script_with_main_idiom_terminates_cleanly(tmp_path):
    need_bash()
    script = tmp_path / "s.sh"
    write_lf(
        script,
        textwrap.dedent("""\
        #!/usr/bin/env bash
        set -euo pipefail
        main() {
          printf 'echo CLOBBERED; exit 9\\n%.0s' 1 2 3 > "$0"
          printf 'padding padding padding padding padding\\n' >> "$0"
          echo step-after-rewrite
        }
        if [ "${BASH_SOURCE[0]}" = "$0" ]; then main "$@"; exit $?; fi
        """),
    )
    result = subprocess.run([BASH, str(script)], capture_output=True, text=True, timeout=30)  # noqa: S603
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "step-after-rewrite"


def test_real_install_sh_survives_being_rewritten_while_running(tmp_path):
    """install.sh réel : un `sed` factice (appelé par repo_version) réécrit le script en cours d'exécution."""
    need_bash()
    work = tmp_path / "w"
    work.mkdir()
    (work / "install.sh").write_bytes((ROOT / "install.sh").read_bytes())
    real_sed = shutil.which("sed")
    bindir = tmp_path / "bin"
    bindir.mkdir()
    stub = bindir / "sed"
    write_lf(
        stub,
        f'#!/usr/bin/env bash\nif [ ! -e "{posix(tmp_path)}/done" ]; then : > "{posix(tmp_path)}/done"\n'
        f'  printf \'echo CLOBBERED\\nexit 99\\n\' > "{posix(work)}/install.sh"\nfi\nexec "{posix(real_sed)}" "$@"\n',
    )
    stub.chmod(0o755)
    env = {**os.environ, "PATH": f"{posix(bindir)}{os.pathsep}{os.environ['PATH']}"}
    result = subprocess.run(
        [BASH, "install.sh", "auto-update", "status"],
        cwd=work,  # noqa: S603
        capture_output=True,
        text=True,
        timeout=30,
        env=env,
        stdin=subprocess.DEVNULL,
    )
    assert (tmp_path / "done").exists(), "le sed factice n'a pas été appelé"
    assert "CLOBBERED" not in result.stdout + result.stderr
    assert result.returncode == 0, result.stdout + result.stderr


def test_install_sh_has_no_toplevel_code_after_main_guard():
    lines = (ROOT / "install.sh").read_text(encoding="utf-8").rstrip("\n").split("\n")
    assert lines[-1] == 'if [ "${BASH_SOURCE[0]}" = "$0" ]; then main "$@"; exit $?; fi'
    assert 'case "$CMD" in' in "\n".join(lines[:-1]) and "\nmain() {" in "\n".join(lines)


# --- 9. compose / .env.example --------------------------------------------------------------------------


def test_compose_transition_defaults():
    yaml = pytest.importorskip("yaml")
    compose = yaml.safe_load((ROOT / "docker-compose.yml").read_text(encoding="utf-8"))
    api_env = compose["services"]["api"]["environment"]
    assert api_env["WS_ALLOW_QUERY_TOKEN"] == "${WS_ALLOW_QUERY_TOKEN:-true}"
    # POSTGRES_APP_PASSWORD absent ne casse plus `up` : repli explicite sur TOKEN_SECRET.
    assert "${POSTGRES_APP_PASSWORD:-${TOKEN_SECRET:?" in api_env["DATABASE_URL"]
    assert "${POSTGRES_APP_PASSWORD:-${TOKEN_SECRET:?" in compose["services"]["db-init"]["environment"]["APP_PASSWORD"]
    example = (ROOT / "deploy/.env.example").read_text(encoding="utf-8")
    assert "WS_ALLOW_QUERY_TOKEN=true" in example and "WS_ALLOW_QUERY_TOKEN=false" not in example


def test_compose_keys_an_operator_override_relies_on_are_still_present():
    """docker-compose.override.yml du VPS (healthcheck api, build réseau host, web, caddy ports, cap_add)."""
    yaml = pytest.importorskip("yaml")
    services = yaml.safe_load((ROOT / "docker-compose.yml").read_text(encoding="utf-8"))["services"]
    assert {"api", "web", "caddy", "db", "db-init", "redis"} <= set(services)
    assert "healthcheck" in services["api"] and "build" in services["api"] and "ports" in services["caddy"]
