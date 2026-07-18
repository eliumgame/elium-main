"""
Auto-update client d'Elium — vérifie GitHub Releases, télécharge et applique les
mises à jour, en vérifiant leur signature Ed25519 avant toute écriture/exécution.

Architecture « overlay LocalAppData + handoff » (voir DOCUMENTATION.md §Mises à jour) :
  - Le binaire installé (Program Files) est la BASE, non modifiable sans admin.
  - Toutes les màj se déposent dans %LOCALAPPDATA%\\Elium\\ (accessible sans admin) :
      web\\<version>\\        interface React mise à jour (cas courant, léger)
      web\\current.txt       pointeur vers la version web active
      bin\\Elium-<version>.exe  nouveau lanceur complet (cas rare)
      bin\\pending.json      {version, sha256} du lanceur en attente de handoff
  - Le lanceur sert le web le plus récent (overlay si strictement plus récent que
    la version embarquée) et, au démarrage, relance l'exe le plus récent (handoff).

Sécurité :
  - Un manifeste `latest.json` signé (Ed25519) liste version + sha256 de chaque artefact.
  - La signature du manifeste est vérifiée avec UPDATE_PUBLIC_KEY_HEX (embarquée, donc
    non substituable sans remplacer l'exe lui-même). Puis chaque artefact téléchargé est
    vérifié par son sha256 présent dans le manifeste signé.
  - Le moindre échec => artefact jeté, l'app continue sur la version courante. Jamais de crash.

Réseau : urllib (stdlib) uniquement, aucune dépendance ajoutée.
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import urllib.request
import zipfile
from pathlib import Path
from typing import Any, Callable, Optional

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

# --------------------------------------------------------------------------- #
# Configuration (constantes embarquées dans l'exe signé)
# --------------------------------------------------------------------------- #

REPO = "eliumgame/elium-main"

# Clé publique de vérification des mises à jour (hex brut Ed25519, 32 octets).
# Générée par scripts/gen_update_keypair.py ; la clé privée correspondante est le
# secret GitHub Actions UPDATE_SIGNING_KEY. NE JAMAIS embarquer la clé privée ici.
UPDATE_PUBLIC_KEY_HEX = "137934bb39b4e6a7de258019fc980db1024bd6f5fa47e4f38bc8468c305dbbef"

# Empreinte des sources Python figées dans CET exe (sha256, calculé au build par
# installer/stamp_version.py). Sert à décider web-only vs exe complet : si le manifeste
# annonce un codeHash différent, c'est que le lanceur/Python a changé -> màj exe.
# Reste le placeholder en dev/non-stampé -> on n'applique alors que les màj web.
BUILD_CODE_HASH = "__BUILD_CODE_HASH__"
_CODE_HASH_PLACEHOLDER = "__BUILD_CODE_HASH__"

# URL « latest » stable : pointe toujours sur le dernier Release non-préversion.
_MANIFEST_NAME = "latest.json"
_DEFAULT_MANIFEST_URL = f"https://github.com/{REPO}/releases/latest/download/{_MANIFEST_NAME}"

# Bornes de sécurité sur les tailles téléchargées (défense contre un artefact géant).
_MAX_MANIFEST_BYTES = 256 * 1024        # 256 KiB
_MAX_ARTIFACT_BYTES = 400 * 1024 * 1024  # 400 MiB
_HTTP_TIMEOUT = 15  # secondes

_USER_AGENT = "Elium-Updater/1.0"


# --------------------------------------------------------------------------- #
# Emplacements
# --------------------------------------------------------------------------- #

def data_dir() -> Path:
    """Répertoire inscriptible des màj : %LOCALAPPDATA%\\Elium (repli ~/.elium)."""
    base = os.environ.get("LOCALAPPDATA")
    root = Path(base) / "Elium" if base else Path.home() / ".elium"
    return root


def _web_root() -> Path:
    return data_dir() / "web"


def _bin_root() -> Path:
    return data_dir() / "bin"


def _pointer_file() -> Path:
    return _web_root() / "current.txt"


def _pending_file() -> Path:
    return _bin_root() / "pending.json"


def _log_file() -> Path:
    return data_dir() / "update.log"


def _log(message: str) -> None:
    """Journalisation best-effort (l'app fenêtrée n'a pas de console)."""
    try:
        data_dir().mkdir(parents=True, exist_ok=True)
        with open(_log_file(), "a", encoding="utf-8") as fh:
            fh.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')}  {message}\n")
    except Exception:
        pass


# --------------------------------------------------------------------------- #
# Version
# --------------------------------------------------------------------------- #

def current_version() -> str:
    """Version applicative de CET exe (source unique : elium.__version__)."""
    override = os.environ.get("ELIUM_CURRENT_VERSION")  # tests
    if override:
        return override
    try:
        from elium import __version__ as v
        return str(v)
    except Exception:
        return "0.0.0"


def _version_tuple(v: str) -> tuple:
    """Parse 'v4.1.0' / '4.0.1-rc' en une clé comparable (préversion < version finale)."""
    v = v.strip()
    if v.lower().startswith("v"):
        v = v[1:]
    core, _, pre = v.partition("-")
    parts = []
    for chunk in core.split("."):
        digits = "".join(ch for ch in chunk if ch.isdigit())
        parts.append(int(digits) if digits else 0)
    while len(parts) < 3:
        parts.append(0)
    # (major, minor, patch, prerelease-flag) : une finale (1) > une préversion (0).
    return (parts[0], parts[1], parts[2], 0 if pre else 1)


def is_newer(remote: str, local: str) -> bool:
    try:
        return _version_tuple(remote) > _version_tuple(local)
    except Exception:
        return False


def effective_version() -> str:
    """Version RÉELLEMENT active = max(version de l'exe, overlay web déjà appliqué).

    Indispensable : une màj web ne remplace que le dossier web (l'exe garde sa version).
    Comparer une nouvelle version à la seule version de l'exe re-proposerait en boucle une
    màj web déjà installée (bug de la carte qui revient après « Recharger »).
    """
    base = current_version()
    ptr = _read_pointer()
    if ptr and is_newer(ptr, base):
        return ptr
    return base


# --------------------------------------------------------------------------- #
# Réseau + crypto
# --------------------------------------------------------------------------- #

def _http_get(url: str, max_bytes: int) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": _USER_AGENT})
    # nosec B310 : schéma https connu, URL construite à partir de constantes/manifeste vérifié.
    with urllib.request.urlopen(req, timeout=_HTTP_TIMEOUT) as resp:  # noqa: S310
        data = resp.read(max_bytes + 1)
    if len(data) > max_bytes:
        raise ValueError(f"Réponse trop volumineuse (> {max_bytes} octets) : {url}")
    return data


def _verify_signature(message: bytes, signature_hex: str) -> bool:
    try:
        pub = Ed25519PublicKey.from_public_bytes(bytes.fromhex(UPDATE_PUBLIC_KEY_HEX))
        pub.verify(bytes.fromhex(signature_hex.strip()), message)
        return True
    except (InvalidSignature, ValueError):
        return False


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


# --------------------------------------------------------------------------- #
# Récupération + vérification du manifeste
# --------------------------------------------------------------------------- #

def _manifest_url() -> str:
    return os.environ.get("ELIUM_UPDATE_MANIFEST_URL", _DEFAULT_MANIFEST_URL)


def fetch_manifest() -> Optional[dict[str, Any]]:
    """Télécharge latest.json + latest.json.sig, vérifie la signature, renvoie le dict."""
    url = _manifest_url()
    try:
        raw = _http_get(url, _MAX_MANIFEST_BYTES)
        sig_hex = _http_get(url + ".sig", _MAX_MANIFEST_BYTES).decode("ascii", "ignore")
    except Exception as exc:
        _log(f"fetch_manifest: échec réseau ({exc})")
        return None

    if not _verify_signature(raw, sig_hex):
        _log("fetch_manifest: SIGNATURE INVALIDE — manifeste rejeté")
        return None

    try:
        manifest = json.loads(raw)
    except Exception as exc:
        _log(f"fetch_manifest: JSON invalide ({exc})")
        return None
    return manifest


def check_for_update() -> Optional[dict[str, Any]]:
    """Renvoie le manifeste (vérifié) si une version plus récente est disponible, sinon None."""
    manifest = fetch_manifest()
    if not manifest:
        return None
    remote = str(manifest.get("version", ""))
    if not remote or not is_newer(remote, effective_version()):
        return None
    return manifest


# --------------------------------------------------------------------------- #
# Téléchargement vérifié d'un artefact
# --------------------------------------------------------------------------- #

def _download_verified(
    art: dict[str, Any],
    dest: Path,
    on_progress: Optional[Callable[[int], None]] = None,
) -> bool:
    """Télécharge art['url'] en flux vers dest (progression 0-100), vérifie sha256."""
    url = art.get("url")
    expected = str(art.get("sha256", "")).lower()
    if not url or not expected:
        _log("_download_verified: artefact sans url/sha256")
        return False
    total = int(art.get("size", 0) or 0)
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    digest = hashlib.sha256()
    try:
        req = urllib.request.Request(url, headers={"User-Agent": _USER_AGENT})
        # noqa: S310 — schéma https connu / manifeste vérifié en amont.
        with urllib.request.urlopen(req, timeout=_HTTP_TIMEOUT) as resp, open(tmp, "wb") as out:  # noqa: S310
            received = 0
            while True:
                chunk = resp.read(256 * 1024)
                if not chunk:
                    break
                received += len(chunk)
                if received > _MAX_ARTIFACT_BYTES:
                    raise ValueError("artefact trop volumineux")
                out.write(chunk)
                digest.update(chunk)
                if on_progress and total:
                    on_progress(min(99, int(received * 100 / total)))
    except Exception as exc:
        _log(f"_download_verified: échec téléchargement {url} ({exc})")
        _safe_unlink(tmp)
        return False

    if digest.hexdigest() != expected:
        _log(f"_download_verified: sha256 mismatch {url} (attendu {expected})")
        _safe_unlink(tmp)
        return False

    _safe_unlink(dest)
    tmp.replace(dest)
    if on_progress:
        on_progress(100)
    return True


def _safe_unlink(path: Path) -> None:
    try:
        path.unlink()
    except OSError:
        pass


# --------------------------------------------------------------------------- #
# Application des màj
# --------------------------------------------------------------------------- #

def apply_web_update(
    manifest: dict[str, Any],
    on_progress: Optional[Callable[[int], None]] = None,
) -> bool:
    """Télécharge et installe le paquet web dans %LOCALAPPDATA%\\Elium\\web\\<version>."""
    version = str(manifest["version"])
    art = manifest.get("artifacts", {}).get("web")
    if not art:
        _log("apply_web_update: pas d'artefact web dans le manifeste")
        return False

    tmp_zip = data_dir() / "tmp" / f"web-{version}.zip"
    if not _download_verified(art, tmp_zip, on_progress):
        return False

    target = _web_root() / version
    staging = _web_root() / f".{version}.new"
    try:
        if staging.exists():
            shutil.rmtree(staging, ignore_errors=True)
        staging.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(tmp_zip) as zf:
            _safe_extract_zip(zf, staging)
        # Le zip peut contenir soit le contenu de dist/ à plat, soit un dossier racine.
        root = _locate_web_root(staging)
        if root is None:
            _log("apply_web_update: index.html introuvable dans le paquet web")
            shutil.rmtree(staging, ignore_errors=True)
            return False
        if target.exists():
            shutil.rmtree(target, ignore_errors=True)
        if root == staging:
            staging.replace(target)
        else:
            _move_dir(root, target)
        if staging.exists():
            shutil.rmtree(staging, ignore_errors=True)
    except Exception as exc:
        _log(f"apply_web_update: extraction échouée ({exc})")
        shutil.rmtree(staging, ignore_errors=True)
        return False
    finally:
        _safe_unlink(tmp_zip)

    _set_pointer(version)
    _prune_old_web(keep={version, current_version()})
    _log(f"apply_web_update: interface {version} installée")
    return True


def _move_dir(src: Path, dst: Path) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(src), str(dst))


def _safe_extract_zip(zf: zipfile.ZipFile, dest: Path) -> None:
    """Extraction protégée contre le zip-slip (chemins hors dest)."""
    dest_res = dest.resolve()
    for member in zf.namelist():
        target = (dest / member).resolve()
        if not str(target).startswith(str(dest_res)):
            raise ValueError(f"Entrée de zip suspecte (zip-slip) : {member}")
    zf.extractall(dest)


def _locate_web_root(staging: Path) -> Optional[Path]:
    """Trouve le dossier contenant index.html (à plat ou dans un unique sous-dossier)."""
    if (staging / "index.html").is_file():
        return staging
    entries = [p for p in staging.iterdir()]
    if len(entries) == 1 and entries[0].is_dir() and (entries[0] / "index.html").is_file():
        return entries[0]
    for p in staging.rglob("index.html"):
        return p.parent
    return None


def _set_pointer(version: str) -> None:
    _web_root().mkdir(parents=True, exist_ok=True)
    _pointer_file().write_text(version.strip(), encoding="utf-8")


def _read_pointer() -> Optional[str]:
    try:
        return _pointer_file().read_text(encoding="utf-8").strip() or None
    except OSError:
        return None


def _prune_old_web(keep: set[str]) -> None:
    try:
        for child in _web_root().iterdir():
            if child.is_dir() and child.name not in keep and not child.name.startswith("."):
                shutil.rmtree(child, ignore_errors=True)
    except OSError:
        pass


def active_web_dir() -> Optional[str]:
    """Dossier web de l'overlay s'il est strictement plus récent que la version embarquée."""
    version = _read_pointer()
    if not version:
        return None
    if not is_newer(version, current_version()):
        return None  # l'exe embarque déjà un web au moins aussi récent
    candidate = _web_root() / version
    if (candidate / "index.html").is_file():
        return str(candidate)
    return None


def apply_exe_update(
    manifest: dict[str, Any],
    on_progress: Optional[Callable[[int], None]] = None,
) -> bool:
    """Télécharge le nouveau lanceur complet dans bin\\ ; appliqué au prochain démarrage."""
    version = str(manifest["version"])
    art = manifest.get("artifacts", {}).get("exe")
    if not art:
        _log("apply_exe_update: pas d'artefact exe dans le manifeste")
        return False

    dest = _bin_root() / f"Elium-{version}.exe"
    if not _download_verified(art, dest, on_progress):
        return False

    try:
        _pending_file().write_text(
            json.dumps({"version": version, "sha256": str(art.get("sha256", "")).lower()}),
            encoding="utf-8",
        )
    except OSError as exc:
        _log(f"apply_exe_update: écriture pending.json échouée ({exc})")
        return False
    _log(f"apply_exe_update: lanceur {version} prêt (handoff au prochain lancement)")
    return True


# --------------------------------------------------------------------------- #
# Handoff : relancer l'exe le plus récent au démarrage
# --------------------------------------------------------------------------- #

def _verified_pending_exe() -> Optional[Path]:
    """Chemin de l'exe en attente s'il est plus récent que nous ET valide (sha256), sinon None."""
    try:
        pending = json.loads(_pending_file().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    version = str(pending.get("version", ""))
    expected = str(pending.get("sha256", "")).lower()
    if not version or not is_newer(version, current_version()):
        return None  # rien de plus récent que nous
    exe = _bin_root() / f"Elium-{version}.exe"
    if not exe.is_file():
        _log(f"pending exe: {exe.name} introuvable")
        return None
    if expected and _sha256(exe) != expected:
        _log(f"pending exe: sha256 de {version} invalide — ignoré")
        _safe_unlink(exe)
        return None
    return exe


def run_pending_handoff() -> None:
    """Au DÉMARRAGE : si un lanceur plus récent (vérifié) attend dans bin\\, l'exécute puis quitte."""
    if not getattr(sys, "frozen", False):
        return  # jamais de handoff en dev
    if os.environ.get("ELIUM_NO_HANDOFF") == "1":
        return
    exe = _verified_pending_exe()
    if exe is None:
        return
    try:
        _log(f"handoff: relance vers {exe.name}")
        # S603 : chemin issu de notre propre répertoire de données, binaire vérifié par sha256.
        subprocess.Popen([str(exe), *sys.argv[1:]])  # noqa: S603
    except Exception as exc:
        _log(f"handoff: échec Popen ({exc})")
        return
    sys.exit(0)


def relaunch_pending_exe() -> bool:
    """Bouton « Redémarrer » : lance l'exe en attente (vérifié) SANS quitter ; True si lancé."""
    if not getattr(sys, "frozen", False):
        return False
    exe = _verified_pending_exe()
    if exe is None:
        return False
    try:
        _log(f"relaunch: démarrage de {exe.name}")
        subprocess.Popen([str(exe), *sys.argv[1:]])  # noqa: S603
        return True
    except Exception as exc:
        _log(f"relaunch: échec Popen ({exc})")
        return False


# --------------------------------------------------------------------------- #
# Orchestration — cycle : détection (bouton) -> téléchargement animé -> prêt
# --------------------------------------------------------------------------- #

# Statut lu par l'endpoint /__update__ (la carte web s'y adapte).
#   state : idle | up-to-date | disabled | available | downloading
#           | web-ready | exe-ready | error
#   kind  : "web" | "exe" (comment la màj s'appliquera)
#   progress : 0-100 pendant le téléchargement
_status: dict[str, Any] = {"state": "idle", "version": None, "kind": None, "progress": 0}
_pending_manifest: Optional[dict[str, Any]] = None
_apply_lock = threading.Lock()
_last_check_monotonic = 0.0  # throttle des re-vérifications (secondes monotoniques)


def get_status() -> dict[str, Any]:
    return dict(_status)


def _publish(state: str, *, version: Optional[str] = None,
             kind: Optional[str] = None, progress: int = 0) -> dict[str, Any]:
    _status.update({"state": state, "version": version, "kind": kind, "progress": progress})
    return get_status()


def _needs_exe(manifest: dict[str, Any]) -> bool:
    """True si le code Python a changé (codeHash différent) -> màj exe complète."""
    remote_code = str(manifest.get("codeHash", ""))
    stamped = BUILD_CODE_HASH != _CODE_HASH_PLACEHOLDER
    return bool(stamped and remote_code and remote_code != BUILD_CODE_HASH)


def check_only() -> dict[str, Any]:
    """Détecte une màj SANS télécharger. Passe l'état à 'available' le cas échéant."""
    global _pending_manifest
    if os.environ.get("ELIUM_NO_UPDATE") == "1":
        return _publish("disabled")
    try:
        manifest = check_for_update()
    except Exception as exc:
        _log(f"check_only: {exc}")
        return _publish("error")
    if not manifest:
        _pending_manifest = None
        return _publish("up-to-date")
    _pending_manifest = manifest
    kind = "exe" if _needs_exe(manifest) else "web"
    _log(f"check_only: màj {manifest.get('version')} disponible ({kind})")
    return _publish("available", version=str(manifest.get("version")), kind=kind)


def _apply(manifest: dict[str, Any]) -> dict[str, Any]:
    """Télécharge (avec progression) puis installe. Ne lève jamais."""
    version = str(manifest.get("version"))
    kind = "exe" if _needs_exe(manifest) else "web"
    _publish("downloading", version=version, kind=kind, progress=0)

    def on_progress(pct: int) -> None:
        _status["progress"] = pct

    try:
        if kind == "exe":
            ok = apply_exe_update(manifest, on_progress)
        else:
            ok = apply_web_update(manifest, on_progress)
    except Exception as exc:
        _log(f"_apply: {exc}")
        ok = False

    if not ok:
        return _publish("error", version=version, kind=kind, progress=_status.get("progress", 0))
    return _publish(f"{kind}-ready", version=version, kind=kind, progress=100)


def start_update() -> dict[str, Any]:
    """Déclenché par le BOUTON : lance téléchargement+installation en tâche de fond."""
    global _pending_manifest
    if os.environ.get("ELIUM_NO_UPDATE") == "1":
        return _publish("disabled")
    if _status.get("state") == "downloading":
        return get_status()
    if _pending_manifest is None:
        check_only()
    if _pending_manifest is None:
        return get_status()
    threading.Thread(target=_run_apply_locked, args=(_pending_manifest,), daemon=True).start()
    return _publish("downloading", version=str(_pending_manifest.get("version")),
                    kind="exe" if _needs_exe(_pending_manifest) else "web", progress=0)


def _run_apply_locked(manifest: dict[str, Any]) -> None:
    if not _apply_lock.acquire(blocking=False):
        return
    try:
        _apply(manifest)
    finally:
        _apply_lock.release()


def check_and_apply(on_status: Optional[Callable[[dict[str, Any]], None]] = None) -> dict[str, Any]:
    """Compat/headless : vérifie ET applique immédiatement (utilisé par les tests)."""
    if os.environ.get("ELIUM_NO_UPDATE") == "1":
        return _publish("disabled")
    try:
        manifest = check_for_update()
    except Exception as exc:
        _log(f"check_and_apply: {exc}")
        return _publish("error")
    if not manifest:
        return _publish("up-to-date")
    status = _apply(manifest)
    if status["state"] in ("web-ready", "exe-ready") and on_status:
        try:
            on_status(status)
        except Exception:
            pass
    return status


def start_background_check() -> None:
    """Lance la DÉTECTION dans un thread daemon (n'impacte jamais le démarrage)."""
    global _last_check_monotonic
    try:
        _last_check_monotonic = time.monotonic()
    except Exception:
        pass
    threading.Thread(target=check_only, daemon=True).start()


def on_navigation() -> None:
    """Appelé quand une page est (re)chargée. Corrige la boucle « Recharger » :
    après application d'une màj web, on efface un état de màj périmé pour ne pas
    ré-afficher la carte, puis on re-vérifie (throttlé). `effective_version()` garantit
    qu'une version déjà appliquée n'est jamais re-proposée.
    Ne perturbe PAS un téléchargement en cours ni une màj exe prête à redémarrer."""
    global _last_check_monotonic
    state = _status.get("state")
    if state in ("downloading", "exe-ready"):
        return
    if state in ("web-ready", "available", "error", "up-to-date"):
        _publish("idle")
    try:
        now = time.monotonic()
    except Exception:
        now = 0.0
    if now - _last_check_monotonic < 30:
        return
    start_background_check()
