"""
Auto-update client d'Elium — vérifie GitHub Releases, télécharge et applique les
mises à jour, en vérifiant leur signature Ed25519 avant toute écriture/exécution.

Architecture « overlay LocalAppData + handoff » (voir la Documentation §Mises à jour) :
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
import http.client
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path
from typing import Any, Callable, Optional

import changelog

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
BUILD_CODE_HASH = "f7e922cf62b4fd0d24a346610e0eeda25310d09b6f65797e2ba985d2333caea0"
_CODE_HASH_PLACEHOLDER = "__BUILD_CODE_HASH__"

_MANIFEST_NAME = "latest.json"

# Bornes de sécurité sur les tailles téléchargées (défense contre un artefact géant).
_MAX_MANIFEST_BYTES = 256 * 1024        # 256 KiB
_MAX_ARTIFACT_BYTES = 400 * 1024 * 1024  # 400 MiB
_HTTP_TIMEOUT = 15  # secondes

# Retry borné + backoff sur un échec réseau TRANSITOIRE d'UNE requête _http_get
# donnée (timeout, connexion refusée/réinitialisée, DNS temporairement
# indisponible...). _HTTP_MAX_ATTEMPTS compte la tentative initiale : 3 = 1
# essai + jusqu'à 2 reprises. Ce retry ne re-résout JAMAIS "quelle release est
# la dernière" entre deux tentatives : chaque tentative reste sur exactement la
# même URL déjà figée par l'appelant (voir docstring de `_http_get`), donc il
# ne peut pas rouvrir la course corrigée dans `_resolve_latest_asset_urls`
# (commit 4cf9654).
_HTTP_MAX_ATTEMPTS = 3
_HTTP_RETRY_BACKOFF_BASE = 0.5  # secondes ; doublé à chaque reprise (0.5s, 1s, ...)

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
    """
    Parse 'v4.1.0' / '4.0.1-rc' en une clé comparable (préversion < version finale).

    Délègue à `changelog.version_tuple`, source unique de cette comparaison : la
    carte de mise à jour trie l'historique avec la même fonction, et deux
    implémentations divergentes voudraient dire que l'interface et le
    téléchargeur ne s'accordent pas sur ce qui est « plus récent ».
    """
    return changelog.version_tuple(v)


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

def _urlopen_read(url: str, max_bytes: int) -> bytes:
    """UNE tentative de GET (sans retry). Isolé pour être remplaçable en test."""
    req = urllib.request.Request(url, headers={"User-Agent": _USER_AGENT})
    # nosec B310 : schéma https connu, URL construite à partir de constantes/manifeste vérifié.
    with urllib.request.urlopen(req, timeout=_HTTP_TIMEOUT) as resp:  # noqa: S310
        return resp.read(max_bytes + 1)


def _is_transient_network_error(exc: BaseException) -> bool:
    """Vrai pour un incident réseau où retenter LA MÊME requête a une chance de
    réussir (timeout, connexion refusée/réinitialisée, DNS temporairement
    indisponible, coupure en cours de lecture).

    FAUX pour une réponse HTTP d'erreur (`HTTPError`, ex. 404/500) : c'est une
    réponse applicative reçue avec succès, pas un incident réseau — retenter ne
    changerait rien tant que le serveur répond ainsi, et certains statuts
    (401/403/404) ne doivent jamais être masqués par un retry silencieux.
    """
    if isinstance(exc, urllib.error.HTTPError):
        return False
    return isinstance(exc, (urllib.error.URLError, http.client.HTTPException, OSError))


def _http_get(url: str, max_bytes: int) -> bytes:
    """GET borné en taille (stdlib urllib), avec retry borné + backoff exponentiel
    sur un échec réseau TRANSITOIRE (voir `_is_transient_network_error`).

    Ce qui n'est JAMAIS retenté ici :
      - une réponse HTTP d'erreur (`HTTPError`) : réponse applicative reçue avec
        succès, pas un incident réseau ;
      - une réponse trop volumineuse (`ValueError` ci-dessous) : rejet définitif,
        la taille ne change pas en réessayant ;
      - un échec de vérification de signature (`_verify_signature`) : il se
        produit APRÈS le retour de cette fonction, sur les octets déjà reçus —
        jamais retenté, car les octets n'ont pas changé, et cette fonction ne
        rappelle JAMAIS `_resolve_latest_asset_urls` entre deux tentatives :
        chaque tentative reste sur la même URL déjà figée par l'appelant, donc
        ce retry ne peut pas rouvrir la course "quelle release est la plus
        récente" corrigée dans `_resolve_latest_asset_urls` (commit 4cf9654).
    """
    for attempt in range(1, _HTTP_MAX_ATTEMPTS + 1):
        try:
            data = _urlopen_read(url, max_bytes)
        except Exception as exc:
            if attempt >= _HTTP_MAX_ATTEMPTS or not _is_transient_network_error(exc):
                raise
            delay = _HTTP_RETRY_BACKOFF_BASE * (2 ** (attempt - 1))
            _log(
                f"_http_get: échec réseau transitoire ({exc}) — "
                f"tentative {attempt}/{_HTTP_MAX_ATTEMPTS}, nouvel essai dans {delay:.1f}s ({url})"
            )
            time.sleep(delay)
            continue
        if len(data) > max_bytes:
            raise ValueError(f"Réponse trop volumineuse (> {max_bytes} octets) : {url}")
        return data
    raise AssertionError("_http_get: boucle de retry terminée sans retour")  # pragma: no cover


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

# Résout la release "latest" en un seul appel API atomique (voir
# `_resolve_latest_asset_urls` ci-dessous pour la raison).
_GITHUB_API_LATEST_RELEASE = f"https://api.github.com/repos/{REPO}/releases/latest"


def _resolve_latest_asset_urls() -> Optional[tuple[str, str]]:
    """URLs de `latest.json` et `latest.json.sig` pour LA MÊME release "latest".

    `releases/latest/download/<fichier>` (l'alias historique) redirige
    indépendamment pour CHAQUE fichier téléchargé — contrairement aux autres
    artefacts (exe, web.zip), dont l'URL vient du manifeste déjà vérifié et
    pointe donc directement sur le tag exact (`gen_manifest.py` : URLs en
    `releases/download/<tag>/...`, jamais l'alias). Le manifeste et sa
    signature n'ont pas ce luxe : c'est justement ce qui indique QUEL tag est
    le plus récent, donc il faut d'abord le résoudre via l'alias — ou, comme
    ici, un seul appel API. `fetch_manifest` appelait cet alias deux fois de
    suite (une pour le manifeste,
    une pour sa signature) : si une nouvelle release se publie entre les deux
    résolutions — ou tant que le CDN n'a pas convergé sur tous ses points de
    présence après coup — les deux requêtes peuvent aboutir sur DEUX releases
    différentes. La signature est alors *correctement* rejetée (ce sont de vrais
    octets non appariés, pas un faux positif du vérificateur), mais le résultat
    observé est un rejet "SIGNATURE INVALIDE" intermittent qui n'a rien à voir
    avec une vraie tentative de falsification — exactement le schéma vu dans
    `update.log` (des rejets espacés de plusieurs jours, sans lien avec une
    publication en cours, aux côtés de mises à jour qui finissent par passer).
    Un seul appel à `/releases/latest` renvoie une release PRÉCISE avec les URLs
    de TOUS ses assets (des liens de téléchargement épinglés à ce tag, pas
    l'alias) : les deux fichiers proviennent alors garantis de la même release.
    """
    try:
        raw = _http_get(_GITHUB_API_LATEST_RELEASE, _MAX_RELEASES_BYTES)
        release = json.loads(raw)
    except Exception as exc:
        _log(f"fetch_manifest: résolution de la release latest échouée ({exc})")
        return None
    assets = {
        a.get("name"): a.get("browser_download_url")
        for a in (release.get("assets") or [])
        if isinstance(a, dict)
    }
    manifest_url = assets.get(_MANIFEST_NAME)
    sig_url = assets.get(f"{_MANIFEST_NAME}.sig")
    if not manifest_url or not sig_url:
        _log("fetch_manifest: latest.json/.sig absents des assets de la release")
        return None
    return manifest_url, sig_url


def fetch_manifest() -> Optional[dict[str, Any]]:
    """Télécharge latest.json + latest.json.sig, vérifie la signature, renvoie le dict.

    Par défaut, résout la release latest UNE fois puis télécharge les deux
    fichiers depuis CETTE même release (voir `_resolve_latest_asset_urls`).
    `ELIUM_UPDATE_MANIFEST_URL` (tests, ou une URL épinglée manuellement)
    court-circuite cette résolution et télécharge directement l'URL donnée
    + `.sig`, comme avant — ce chemin n'a pas la course puisqu'il désigne déjà
    une paire de fichiers fixe.
    """
    override = os.environ.get("ELIUM_UPDATE_MANIFEST_URL")
    try:
        if override:
            manifest_url, sig_url = override, override + ".sig"
        else:
            resolved = _resolve_latest_asset_urls()
            if not resolved:
                return None
            manifest_url, sig_url = resolved
        raw = _http_get(manifest_url, _MAX_MANIFEST_BYTES)
        sig_hex = _http_get(sig_url, _MAX_MANIFEST_BYTES).decode("ascii", "ignore")
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
#   releases : [{version, date, changes[]}] — tout ce que l'utilisateur n'a pas
#              encore, de la plus récente à la plus ancienne (pas seulement la
#              dernière release), pour que la carte annonce l'ensemble des
#              nouveautés apportées.
#   summary  : « 3 versions, 12 nouveautés »
_status: dict[str, Any] = {
    "state": "idle", "version": None, "kind": None, "progress": 0,
    "releases": [], "summary": "", "notes": "",
}
_pending_manifest: Optional[dict[str, Any]] = None
_apply_lock = threading.Lock()
_last_check_monotonic = 0.0  # throttle des re-vérifications (secondes monotoniques)


def get_status() -> dict[str, Any]:
    return dict(_status)


def _publish(state: str, *, version: Optional[str] = None,
             kind: Optional[str] = None, progress: int = 0,
             releases: Optional[list] = None, summary: Optional[str] = None,
             notes: Optional[str] = None) -> dict[str, Any]:
    _status.update({"state": state, "version": version, "kind": kind, "progress": progress})
    # Les nouveautés PERSISTENT d'un état à l'autre : elles sont calculées une
    # fois à la détection, et la carte continue de les afficher pendant le
    # téléchargement puis sur l'écran « prête ».
    if releases is not None:
        _status["releases"] = releases
    if summary is not None:
        _status["summary"] = summary
    if notes is not None:
        _status["notes"] = notes
    return get_status()


def release_notes(manifest: dict[str, Any], local_version: str = "") -> list[dict[str, Any]]:
    """
    Nouveautés à annoncer : l'historique du manifeste réduit à ce qui est plus
    récent que la version installée.

    Un manifeste antérieur à `history` n'a que `changes` (ou rien) : on retombe
    alors sur une entrée unique pour la version proposée, plutôt que de n'afficher
    aucune information.
    """
    local = local_version or effective_version()
    history = manifest.get("history") or []
    if history:
        return changelog.changes_since(history, local)
    changes = manifest.get("changes") or []
    if not changes:
        return []
    return [changelog.build_entry(
        str(manifest.get("version", "")), str(manifest.get("pubDate", "")), changes,
    )]


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
    releases = release_notes(manifest)
    return _publish(
        "available", version=str(manifest.get("version")), kind=kind,
        releases=releases, summary=changelog.summarize(releases),
        notes=str(manifest.get("notes") or ""),
    )


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


# --------------------------------------------------------------------------- #
# Version installée + retour à une version antérieure (rollback)
# --------------------------------------------------------------------------- #

_GITHUB_API_RELEASES = f"https://api.github.com/repos/{REPO}/releases?per_page=40"
# Les corps de release (changelogs) peuvent être volumineux : plafond dédié.
_MAX_RELEASES_BYTES = 2 * 1024 * 1024  # 2 MiB


def version_info() -> dict[str, Any]:
    """Version installée + si elle est à jour (pour le pied de l'accueil).

    NON bloquant : lit le dernier statut connu de la vérification d'arrière-plan
    (start_background_check au lancement + carte de màj qui sonde /__update__),
    plutôt que de refaire un appel réseau qui figerait la requête du pied.
    """
    installed = effective_version()
    base = current_version()
    st = get_status()
    state = st.get("state")
    latest: Optional[str] = None
    up_to_date = True
    if state == "available" and st.get("version"):
        latest = str(st["version"])
        up_to_date = not is_newer(latest, installed)
    elif state in ("web-ready", "exe-ready") and st.get("version"):
        latest = str(st["version"])  # màj téléchargée, en attente d'application
        up_to_date = False
    # état inconnu (idle/up-to-date/error/downloading) -> considéré à jour ;
    # la vérification d'arrière-plan met _status à jour peu après le lancement.
    return {"installed": installed, "base": base, "latest": latest, "upToDate": up_to_date}


def _manifest_url_for(version: str) -> str:
    v = version if version.startswith("v") else f"v{version}"
    return f"https://github.com/{REPO}/releases/download/{v}/{_MANIFEST_NAME}"


def fetch_manifest_for(version: str) -> Optional[dict[str, Any]]:
    """Comme fetch_manifest mais pour une version PRÉCISE (rollback). Signée par la même clé."""
    url = _manifest_url_for(version)
    try:
        raw = _http_get(url, _MAX_MANIFEST_BYTES)
        sig_hex = _http_get(url + ".sig", _MAX_MANIFEST_BYTES).decode("ascii", "ignore")
    except Exception as exc:
        _log(f"fetch_manifest_for({version}): échec réseau ({exc})")
        return None
    if not _verify_signature(raw, sig_hex):
        _log(f"fetch_manifest_for({version}): SIGNATURE INVALIDE — rejeté")
        return None
    try:
        return json.loads(raw)
    except Exception as exc:
        _log(f"fetch_manifest_for({version}): JSON invalide ({exc})")
        return None


def list_releases() -> list[dict[str, Any]]:
    """Versions publiées (API GitHub), plus récentes d'abord, hors brouillons/préversions.

    Chaque entrée : {version, date, name, installed, canRollback}. `canRollback`
    est faux pour les versions strictement antérieures à la version EMBARQUÉE :
    l'overlay LocalAppData ne va que vers l'avant, revenir plus bas exige de
    réinstaller le programme d'installation (MSI).
    """
    try:
        raw = _http_get(_GITHUB_API_RELEASES, _MAX_RELEASES_BYTES)
        arr = json.loads(raw)
    except Exception as exc:
        _log(f"list_releases: {exc}")
        return []
    base = current_version()
    installed = effective_version()
    out: list[dict[str, Any]] = []
    for r in arr if isinstance(arr, list) else []:
        if r.get("draft") or r.get("prerelease"):
            continue
        tag = str(r.get("tag_name") or "").lstrip("v")
        if not tag:
            continue
        out.append({
            "version": tag,
            "date": str(r.get("published_at") or "")[:10],
            "name": str(r.get("name") or ""),
            "installed": tag == installed,
            # Applicable via l'overlay uniquement si >= version de base embarquée.
            "canRollback": not is_newer(base, tag),
        })
    try:
        out.sort(key=lambda x: _version_tuple(str(x["version"])), reverse=True)
    except Exception:
        pass
    return out


def undo_last_update() -> dict[str, Any]:
    """« Désinstaller la dernière mise à jour » : revient à la version EMBARQUÉE.

    Efface le pointeur web + le lanceur en attente (et les exe téléchargés) : au
    prochain rechargement/redémarrage, l'app sert la version de base. Purement
    local, aucun téléchargement.
    """
    _safe_unlink(_pointer_file())
    _safe_unlink(_pending_file())
    try:
        for child in _bin_root().glob("Elium-*.exe"):
            _safe_unlink(child)
    except OSError:
        pass
    _prune_old_web(keep={current_version()})
    _log("undo_last_update: retour à la version de base")
    return _publish("web-ready", version=current_version(), kind="web", progress=100)


def _run_rollback(version: str) -> None:
    if not _apply_lock.acquire(blocking=False):
        return
    try:
        manifest = fetch_manifest_for(version)
        if not manifest:
            _publish("error", version=version, notes="Manifeste introuvable ou signature invalide.")
            return
        needs_exe = _needs_exe(manifest)
        # Un retour vers une version dont le CODE diffère et qui n'est PAS plus
        # récente que l'exe courant ne peut pas se faire par overlay/handoff
        # (le handoff refuse un exe plus ancien) : il faut réinstaller le MSI.
        if needs_exe and not is_newer(version, current_version()):
            _publish("error", version=version,
                     notes="Cette version nécessite une réinstallation via le programme d'installation (MSI).")
            return

        def on_progress(pct: int) -> None:
            _status["progress"] = pct

        _publish("downloading", version=version, kind="exe" if needs_exe else "web", progress=0)
        if needs_exe:
            ok = apply_exe_update(manifest, on_progress)
            kind = "exe"
        else:
            # apply_web_update pose le pointeur sur la version cible sans exiger
            # qu'elle soit plus récente -> gère le retour arrière (dans la plage
            # >= base ; sous la base, l'overlay est ignoré et la base est servie).
            ok = apply_web_update(manifest, on_progress)
            kind = "web"
        if not ok:
            _publish("error", version=version, kind=kind, progress=_status.get("progress", 0))
        else:
            _log(f"rollback: version {version} appliquée ({kind})")
            _publish(f"{kind}-ready", version=version, kind=kind, progress=100)
    finally:
        _apply_lock.release()


def start_rollback(version: str) -> dict[str, Any]:
    """Déclenche le retour à `version` en tâche de fond (téléchargement vérifié)."""
    if os.environ.get("ELIUM_NO_UPDATE") == "1":
        return _publish("disabled")
    if _status.get("state") == "downloading":
        return get_status()
    threading.Thread(target=_run_rollback, args=(version,), daemon=True).start()
    return _publish("downloading", version=version, progress=0)


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
