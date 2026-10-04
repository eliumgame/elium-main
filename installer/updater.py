"""
Auto-update client d'Elium — vérifie GitHub Releases, télécharge et applique les
mises à jour, en vérifiant leur signature Ed25519 avant toute écriture/exécution.

Architecture « overlay LocalAppData + handoff » (voir la Documentation §Mises à jour) :
  - Le binaire installé (Program Files) est la BASE, non modifiable sans admin.
  - Toutes les màj se déposent dans %LOCALAPPDATA%\\Elium\\ (accessible sans admin) :
      web\\<version>\\               interface React mise à jour (cas courant, léger)
      web\\<version>.manifest.json   manifeste SIGNÉ (+ .sig) ayant autorisé cette version
      web\\current.txt              pointeur vers la version web active
      assets\\<hash>\\               pack d'assets lourds (polices, pdf.js, OCR), partagé
      bin\\Elium-<version>.exe       nouveau lanceur complet (cas rare)
      bin\\Elium-<version>.manifest.json (+ .sig)   manifeste signé du lanceur
      bin\\pending.json             {version, sha256} du lanceur en attente (indicatif)
      boot-state.json              garde anti boucle de plantage (tentatives / « boot ok »)
      update-settings.json         canal (stable/beta) et versions mises en quarantaine
      update-cache.json            ETag + backoff de l'API GitHub (limite 60 req/h)
  - Le lanceur sert le web le plus récent (overlay si strictement plus récent que
    la version embarquée ET vérifié) et, au démarrage, relance l'exe le plus récent
    (handoff) s'il est vérifié.

Sécurité :
  - Un manifeste `latest.json` signé (Ed25519) liste version + sha256 de chaque artefact.
  - La signature du manifeste est vérifiée avec une clé de la liste embarquée (identifiant
    `keyId` porté par le manifeste ; rotation = ajouter une clé à la liste), donc non
    substituable sans remplacer l'exe lui-même. Chaque artefact est ensuite vérifié par son
    sha256 présent dans le manifeste signé.
  - Ces vérifications sont REJOUÉES AU LANCEMENT : le manifeste signé (et sa signature) est
    conservé à côté de chaque exe / overlay web téléchargé, et on revérifie signature +
    hash (exe) ou empreinte d'arborescence (web) avant de s'en servir. Un pointeur ou un
    pending.json trafiqué (dossier inscriptible par l'utilisateur) ne suffit plus : au
    moindre écart on retombe sur la version embarquée.
  - Le moindre échec => artefact jeté, l'app continue sur la version courante. Jamais de crash.

Réseau : urllib (stdlib) uniquement, aucune dépendance ajoutée.
"""
from __future__ import annotations

import hashlib
import http.client
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import zipfile
from collections.abc import Iterable
from pathlib import Path
from typing import Any, Callable

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

# Identifiant de la clé ci-dessus (champ `keyId` du manifeste signé).
UPDATE_PUBLIC_KEY_ID = "k1"

# Clés SUPPLÉMENTAIRES acceptées (rotation) : {keyId: hex}. Procédure de rotation
# (voir installer/README.md) : 1) publier une release signée par l'ancienne clé qui
# AJOUTE la nouvelle ici ; 2) quand la base installée a migré, signer avec la nouvelle
# (gen_manifest.py --key-id k2) ; 3) retirer l'ancienne dans une release ultérieure.
UPDATE_EXTRA_PUBLIC_KEYS: dict[str, str] = {}

# Empreinte des sources Python figées dans CET exe (sha256, calculé au build par
# installer/stamp_version.py). Sert à décider web-only vs exe complet : si le manifeste
# annonce un codeHash différent, c'est que le lanceur/Python a changé -> màj exe.
# Reste le placeholder en dev/non-stampé -> on n'applique alors que les màj web.
BUILD_CODE_HASH = "b5ec0b4798aeae9e05aacdb4bfc7314f356a889ab3f1022ec989c6b28002a214"
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

_USER_AGENT = "Elium-Updater/1.1"

# Garde anti boucle de plantage : au-delà de ce nombre de démarrages SANS « boot ok »
# d'un exe remis en main, on revient à la version embarquée.
MAX_BOOT_ATTEMPTS = 3

CHANNELS = ("stable", "beta")
DEFAULT_CHANNEL = "stable"


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


def _assets_root() -> Path:
    return data_dir() / "assets"


def _pointer_file() -> Path:
    return _web_root() / "current.txt"


def _pending_file() -> Path:
    return _bin_root() / "pending.json"


def _log_file() -> Path:
    return data_dir() / "update.log"


def _settings_file() -> Path:
    return data_dir() / "update-settings.json"


def _cache_file() -> Path:
    return data_dir() / "update-cache.json"


def _boot_state_file() -> Path:
    return data_dir() / "boot-state.json"


def _fallback_file() -> Path:
    return data_dir() / "fallback.json"


def _log(message: str) -> None:
    """Journalisation best-effort (l'app fenêtrée n'a pas de console)."""
    try:
        data_dir().mkdir(parents=True, exist_ok=True)
        with open(_log_file(), "a", encoding="utf-8") as fh:
            fh.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')}  {message}\n")
    except Exception:  # noqa: S110 — c'est LE puits de journalisation ; rien d'autre où logguer cet échec.
        pass


def _load_json(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def _save_json(path: Path, obj: Any) -> None:
    """Écriture atomique best-effort (temp + remplacement)."""
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_text(json.dumps(obj), encoding="utf-8")
        tmp.replace(path)
    except OSError as exc:
        _log(f"_save_json({path.name}): {exc}")


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
    return changelog.version_key(v)


def is_newer(remote: str, local: str) -> bool:
    try:
        return _version_tuple(remote) > _version_tuple(local)
    except Exception:
        return False


def effective_version() -> str:
    """Version RÉELLEMENT active = max(version de l'exe, overlay web déjà appliqué ET vérifié).

    Indispensable : une màj web ne remplace que le dossier web (l'exe garde sa version).
    Comparer une nouvelle version à la seule version de l'exe re-proposerait en boucle une
    màj web déjà installée (bug de la carte qui revient après « Recharger »). Un overlay
    qui ne passe pas la vérification d'intégrité n'est PAS servi : sa version ne compte pas.
    """
    base = current_version()
    ptr = _verified_pointer()
    if ptr and is_newer(ptr, base):
        return ptr
    return base


# --------------------------------------------------------------------------- #
# Réglages persistants : canal de mise à jour, quarantaine
# --------------------------------------------------------------------------- #

def get_channel() -> str:
    """Canal de mise à jour actif : `stable` (défaut) ou `beta` (préversions incluses)."""
    env = (os.environ.get("ELIUM_UPDATE_CHANNEL") or "").strip().lower()
    if env in CHANNELS:
        return env
    cfg = _load_json(_settings_file(), {})
    ch = str(cfg.get("channel", DEFAULT_CHANNEL)).lower() if isinstance(cfg, dict) else DEFAULT_CHANNEL
    return ch if ch in CHANNELS else DEFAULT_CHANNEL


def _is_quarantined(version: str) -> bool:
    cfg = _load_json(_settings_file(), {})
    bad = cfg.get("quarantine", []) if isinstance(cfg, dict) else []
    return isinstance(bad, list) and version in bad


def _quarantine(version: str) -> None:
    cfg = _load_json(_settings_file(), {})
    if not isinstance(cfg, dict):
        cfg = {}
    bad = [str(v) for v in cfg.get("quarantine", []) if isinstance(v, str)]
    if version not in bad:
        bad.append(version)
    cfg["quarantine"] = bad[-20:]
    _save_json(_settings_file(), cfg)


# --------------------------------------------------------------------------- #
# Empreintes (fichier + arborescence)
# --------------------------------------------------------------------------- #

def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def _tree_digest(entries: Iterable[tuple[str, str]]) -> str:
    """Empreinte d'une arborescence = sha256 de « chemin\\0sha256\\n » triés.

    Même définition côté build (installer/split_web.py, gen_manifest.py) et côté client :
    le manifeste signé porte `treeHash`, le client le recalcule sur le dossier servi.
    """
    h = hashlib.sha256()
    for rel, digest in sorted(entries):
        h.update(f"{rel}\0{digest}\n".encode())
    return h.hexdigest()


def tree_hash_dir(root: Path) -> str:
    entries: list[tuple[str, str]] = []
    for p in root.rglob("*"):
        if p.is_file():
            entries.append((p.relative_to(root).as_posix(), _sha256(p)))
    return _tree_digest(entries)


def tree_hash_zips(*paths: Path) -> str:
    """Empreinte d'arborescence de l'UNION des fichiers de plusieurs zips (sans extraction)."""
    entries: list[tuple[str, str]] = []
    for path in paths:
        with zipfile.ZipFile(path) as zf:
            for info in zf.infolist():
                if info.is_dir():
                    continue
                h = hashlib.sha256()
                with zf.open(info) as fh:
                    for block in iter(lambda: fh.read(1024 * 1024), b""):
                        h.update(block)
                entries.append((info.filename.replace("\\", "/"), h.hexdigest()))
    return _tree_digest(entries)


# --------------------------------------------------------------------------- #
# Signature (liste de clés + keyId) et manifeste signé
# --------------------------------------------------------------------------- #

def accepted_public_keys() -> dict[str, str]:
    """Clés de vérification acceptées : {keyId: hex}. La clé primaire + les extras de rotation."""
    keys = dict(UPDATE_EXTRA_PUBLIC_KEYS)
    keys[UPDATE_PUBLIC_KEY_ID] = UPDATE_PUBLIC_KEY_HEX
    return keys


def _check_signature(message: bytes, signature_hex: str, key_id: str | None = None) -> str:
    """`ok` | `invalid` | `unknown-key`.

    Avec `key_id` (lu dans le manifeste, AVANT vérification — il ne sert qu'à choisir
    parmi des clés déjà de confiance) seule cette clé est essayée ; un identifiant
    inconnu est refusé. Sans `key_id` (anciens manifestes) toutes les clés acceptées sont
    essayées.
    """
    keys = accepted_public_keys()
    if key_id:
        if key_id not in keys:
            return "unknown-key"
        candidates = [keys[key_id]]
    else:
        candidates = list(keys.values())
    try:
        sig = bytes.fromhex(signature_hex.strip())
    except ValueError:
        return "invalid"
    for hex_key in candidates:
        try:
            Ed25519PublicKey.from_public_bytes(bytes.fromhex(hex_key)).verify(sig, message)
            return "ok"
        except (InvalidSignature, ValueError):
            continue
    return "invalid"


def _verify_signature(message: bytes, signature_hex: str, key_id: str | None = None) -> bool:
    return _check_signature(message, signature_hex, key_id) == "ok"


def _peek_key_id(raw: bytes) -> str | None:
    try:
        data = json.loads(raw)
    except ValueError:
        return None
    kid = data.get("keyId") if isinstance(data, dict) else None
    return str(kid) if kid else None


class UpdateCheckError(Exception):
    """Échec de vérification d'une mise à jour, avec une cause DISTINCTE.

    reason : `offline` | `rate-limited` | `invalid-signature` | `unknown-key` | `unavailable`
    """

    def __init__(self, reason: str, detail: str = "") -> None:
        super().__init__(f"{reason}: {detail}" if detail else reason)
        self.reason = reason
        self.detail = detail


REASON_MESSAGES = {
    "offline": "Impossible de joindre le serveur de mises à jour (hors ligne ?).",
    "rate-limited": "Trop de vérifications récentes : réessayez dans quelques minutes.",
    "invalid-signature": "La signature de la mise à jour est invalide : elle a été refusée par sécurité.",
    "unknown-key": "Cette mise à jour est signée par une clé inconnue : réinstallez Elium depuis le site officiel.",
    "unavailable": "Le service de mises à jour a répondu de façon inattendue.",
}


class SignedManifest(dict):
    """Manifeste vérifié ; conserve les octets exacts + la signature pour pouvoir REVÉRIFIER au lancement."""

    raw: bytes = b""
    sig_hex: str = ""
    key_id: str | None = None


def _parse_signed_manifest(raw: bytes, sig_hex: str) -> SignedManifest:
    key_id = _peek_key_id(raw)
    verdict = _check_signature(raw, sig_hex, key_id)
    if verdict == "unknown-key":
        raise UpdateCheckError("unknown-key", f"keyId {key_id!r} absent de la liste embarquée")
    if verdict != "ok":
        raise UpdateCheckError("invalid-signature", "SIGNATURE INVALIDE — manifeste rejeté")
    try:
        data = json.loads(raw)
    except ValueError as exc:
        raise UpdateCheckError("unavailable", f"JSON invalide ({exc})") from exc
    if not isinstance(data, dict):
        raise UpdateCheckError("unavailable", "manifeste non objet")
    manifest = SignedManifest(data)
    manifest.raw = raw
    manifest.sig_hex = sig_hex.strip()
    manifest.key_id = key_id
    return manifest


def _sidecar_paths(base: Path) -> tuple[Path, Path]:
    """(manifeste, signature) posés à côté d'un exe / dossier web : `<base>.manifest.json[.sig]`."""
    return (base.with_name(base.name + ".manifest.json"), base.with_name(base.name + ".manifest.json.sig"))


def _store_signed_manifest(manifest: Any, base: Path) -> bool:
    raw = getattr(manifest, "raw", b"")
    sig = getattr(manifest, "sig_hex", "")
    if not raw or not sig:
        _log("manifeste sans octets signés : impossible de le conserver pour revérification")
        return False
    mpath, spath = _sidecar_paths(base)
    try:
        mpath.parent.mkdir(parents=True, exist_ok=True)
        mpath.write_bytes(raw)
        spath.write_text(sig, encoding="utf-8")
    except OSError as exc:
        _log(f"écriture du manifeste signé échouée ({exc})")
        return False
    return True


def _load_signed_manifest(base: Path) -> SignedManifest | None:
    """Relit ET revérifie la signature du manifeste conservé à côté d'un artefact."""
    mpath, spath = _sidecar_paths(base)
    try:
        raw = mpath.read_bytes()
        sig = spath.read_text(encoding="utf-8")
    except OSError:
        return None
    if len(raw) > _MAX_MANIFEST_BYTES:
        return None
    try:
        return _parse_signed_manifest(raw, sig)
    except UpdateCheckError as exc:
        _log(f"manifeste conservé ({mpath.name}) rejeté : {exc.reason}")
        return None


def _remove_sidecar(base: Path) -> None:
    for p in _sidecar_paths(base):
        _safe_unlink(p)


# --------------------------------------------------------------------------- #
# Réseau
# --------------------------------------------------------------------------- #

def _urlopen_read(url: str, max_bytes: int) -> bytes:
    """UNE tentative de GET (sans retry). Isolé pour être remplaçable en test."""
    req = urllib.request.Request(url, headers={"User-Agent": _USER_AGENT})  # noqa: S310
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


def _urlopen_conditional(url: str, etag: str | None, max_bytes: int) -> tuple[int, bytes, dict[str, str]]:
    """GET d'API GitHub avec `If-None-Match`. Renvoie (statut, corps, en-têtes en minuscules).

    304 (inchangé) est un SUCCÈS ici (et ne consomme pas le quota de l'API). Toute
    autre erreur HTTP est relevée telle quelle. Isolé pour être remplaçable en test.
    """
    headers = {"User-Agent": _USER_AGENT, "Accept": "application/vnd.github+json"}
    if etag:
        headers["If-None-Match"] = etag
    req = urllib.request.Request(url, headers=headers)  # noqa: S310
    try:
        with urllib.request.urlopen(req, timeout=_HTTP_TIMEOUT) as resp:  # noqa: S310
            body = resp.read(max_bytes + 1)
            hdrs = {str(k).lower(): str(v) for k, v in resp.headers.items()}
            return 200, body, hdrs
    except urllib.error.HTTPError as exc:
        if exc.code == 304:
            hdrs = {str(k).lower(): str(v) for k, v in (exc.headers.items() if exc.headers else [])}
            return 304, b"", hdrs
        raise


def _reason_for_exception(exc: BaseException) -> str:
    if isinstance(exc, urllib.error.HTTPError):
        return "rate-limited" if exc.code in (403, 429) else "unavailable"
    if isinstance(exc, (urllib.error.URLError, http.client.HTTPException, OSError)):
        return "offline"
    return "unavailable"


def _backoff_seconds(headers: Any, now: float) -> float:
    """Délai avant de retoucher l'API après un refus de quota (Retry-After / X-RateLimit-Reset)."""
    def _get(name: str) -> str | None:
        try:
            return headers.get(name) if headers else None
        except Exception:
            return None

    wait = 900.0
    retry_after = _get("Retry-After") or _get("retry-after")
    reset = _get("X-RateLimit-Reset") or _get("x-ratelimit-reset")
    try:
        if retry_after:
            wait = float(retry_after)
        elif reset:
            wait = float(reset) - now
    except ValueError:
        pass
    return min(max(wait, 60.0), 3600.0)


# Résout la release "latest" en un seul appel API atomique (voir
# `_resolve_latest_asset_urls` ci-dessous pour la raison).
_GITHUB_API_LATEST_RELEASE = f"https://api.github.com/repos/{REPO}/releases/latest"
# Canal bêta : « latest » exclut les préversions ; on liste donc les releases récentes.
_GITHUB_API_RELEASES_RECENT = f"https://api.github.com/repos/{REPO}/releases?per_page=15"


def _reduce_release(r: Any) -> dict[str, Any]:
    assets = {}
    for a in (r.get("assets") or []) if isinstance(r, dict) else []:
        if isinstance(a, dict) and a.get("name") and a.get("browser_download_url"):
            assets[str(a["name"])] = str(a["browser_download_url"])
    return {
        "tag": str((r or {}).get("tag_name") or ""),
        "prerelease": bool((r or {}).get("prerelease")),
        "assets": assets,
    }


def _reduce_release_list(arr: Any) -> list[dict[str, Any]]:
    if not isinstance(arr, list):
        return []
    return [_reduce_release(r) for r in arr if isinstance(r, dict) and not r.get("draft")]


def _api_cached(url: str, reducer: Callable[[Any], Any]) -> Any:
    """GET d'API GitHub avec cache ETag persistant + backoff persistant sur quota épuisé.

    La limite non authentifiée est de 60 requêtes/heure/IP : un `304 Not Modified` ne la
    consomme pas, et après un refus (403/429) on s'interdit toute nouvelle tentative
    pendant le délai indiqué par GitHub (persisté : survit aux redémarrages).
    """
    now = time.time()
    cache = _load_json(_cache_file(), {})
    if not isinstance(cache, dict):
        cache = {}
    until = float(cache.get("backoffUntil") or 0)
    if until > now:
        raise UpdateCheckError("rate-limited", f"nouvel essai possible dans {int(until - now)} s")
    entry = (cache.get("releases") or {}).get(url) or {}
    etag = entry.get("etag") if entry.get("data") is not None else None

    for attempt in range(1, _HTTP_MAX_ATTEMPTS + 1):
        try:
            status, body, hdrs = _urlopen_conditional(url, etag, _MAX_RELEASES_BYTES)
            break
        except urllib.error.HTTPError as exc:
            if exc.code in (403, 429):
                cache["backoffUntil"] = now + _backoff_seconds(exc.headers, now)
                _save_json(_cache_file(), cache)
                raise UpdateCheckError("rate-limited", f"HTTP {exc.code}") from exc
            raise UpdateCheckError("unavailable", f"HTTP {exc.code}") from exc
        except Exception as exc:
            if attempt < _HTTP_MAX_ATTEMPTS and _is_transient_network_error(exc):
                time.sleep(_HTTP_RETRY_BACKOFF_BASE * (2 ** (attempt - 1)))
                continue
            raise UpdateCheckError(_reason_for_exception(exc), str(exc)) from exc
    else:  # pragma: no cover - la boucle sort par break ou raise
        raise UpdateCheckError("unavailable", "boucle de requête épuisée")

    if status == 304:
        if entry.get("data") is None:
            raise UpdateCheckError("unavailable", "304 sans copie en cache")
        return entry["data"]
    if len(body) > _MAX_RELEASES_BYTES:
        raise UpdateCheckError("unavailable", "réponse d'API trop volumineuse")
    try:
        data = reducer(json.loads(body))
    except ValueError as exc:
        raise UpdateCheckError("unavailable", f"JSON invalide ({exc})") from exc
    releases = cache.get("releases") if isinstance(cache.get("releases"), dict) else {}
    releases[url] = {"etag": hdrs.get("etag"), "data": data}
    cache["releases"] = releases
    cache.pop("backoffUntil", None)
    _save_json(_cache_file(), cache)
    return data


# --------------------------------------------------------------------------- #
# Récupération + vérification du manifeste
# --------------------------------------------------------------------------- #

def _resolve_latest_asset_urls() -> tuple[str, str] | None:
    """URLs de `latest.json` et `latest.json.sig` pour LA MÊME release.

    `releases/latest/download/<fichier>` (l'alias historique) redirige
    indépendamment pour CHAQUE fichier téléchargé — contrairement aux autres
    artefacts (exe, web.zip), dont l'URL vient du manifeste déjà vérifié et
    pointe donc directement sur le tag exact (`gen_manifest.py` : URLs en
    `releases/download/<tag>/...`, jamais l'alias). Le manifeste et sa
    signature n'ont pas ce luxe : c'est justement ce qui indique QUEL tag est
    le plus récent, donc il faut d'abord le résoudre via l'alias — ou, comme
    ici, un seul appel API. `fetch_manifest` appelait cet alias deux fois de
    suite (une pour le manifeste, une pour sa signature) : si une nouvelle
    release se publie entre les deux résolutions — ou tant que le CDN n'a pas
    convergé sur tous ses points de présence après coup — les deux requêtes
    peuvent aboutir sur DEUX releases différentes. La signature est alors
    *correctement* rejetée, mais le résultat observé est un rejet "SIGNATURE
    INVALIDE" intermittent qui n'a rien à voir avec une vraie falsification.
    Un seul appel API renvoie une release PRÉCISE avec les URLs de TOUS ses
    assets (liens épinglés à ce tag, pas l'alias) : les deux fichiers
    proviennent alors garantis de la même release.

    Canal `stable` : `/releases/latest` (GitHub exclut préversions et brouillons).
    Canal `beta` : la plus récente des releases récentes, préversions comprises.
    Lève `UpdateCheckError` (hors ligne / quota / réponse inattendue).
    """
    if get_channel() == "beta":
        candidates = [r for r in _api_cached(_GITHUB_API_RELEASES_RECENT, _reduce_release_list)
                      if _MANIFEST_NAME in r["assets"] and f"{_MANIFEST_NAME}.sig" in r["assets"] and r["tag"]]
        if not candidates:
            _log("fetch_manifest: aucune release (bêta) portant latest.json/.sig")
            return None
        candidates.sort(key=lambda r: _version_tuple(r["tag"]), reverse=True)
        assets = candidates[0]["assets"]
    else:
        assets = _api_cached(_GITHUB_API_LATEST_RELEASE, _reduce_release)["assets"]
    manifest_url = assets.get(_MANIFEST_NAME)
    sig_url = assets.get(f"{_MANIFEST_NAME}.sig")
    if not manifest_url or not sig_url:
        _log("fetch_manifest: latest.json/.sig absents des assets de la release")
        return None
    return manifest_url, sig_url


# Nombre de tentatives + délai entre elles pour une vérification de manifeste.
# Justification : même avec `_resolve_latest_asset_urls` (résolution atomique),
# une fenêtre de quelques centaines de ms subsiste entre l'appel API et les DEUX
# téléchargements qui suivent — un CDN dont tous les points de présence n'ont pas
# encore convergé après une publication très récente peut encore, rarement,
# livrer manifeste et signature légèrement désynchronisés (cf. update.log : des
# rejets "SIGNATURE INVALIDE" groupés sur de courtes fenêtres, cohérents avec une
# republication rapprochée, pas avec une falsification). Un nouvel essai quelques
# centaines de ms plus tard suffit à converger, sans jamais assouplir la
# vérification elle-même : chaque tentative est vérifiée avec la même rigueur.
# Une panne réseau (hors ligne) n'est PAS retentée ici : `_http_get` a déjà
# épuisé ses propres reprises, et la prochaine vérification périodique prendra le relais.
_MANIFEST_FETCH_ATTEMPTS = 3
_MANIFEST_FETCH_BACKOFF_S = 0.7

# Dernière cause d'échec de `fetch_manifest()` (None si la dernière tentative a réussi).
_last_check_error: UpdateCheckError | None = None


def fetch_manifest_ex() -> SignedManifest:
    """Télécharge latest.json + latest.json.sig, vérifie la signature ; lève `UpdateCheckError`.

    `ELIUM_UPDATE_MANIFEST_URL` (tests, ou une URL épinglée manuellement)
    court-circuite la résolution et télécharge directement l'URL donnée + `.sig`.
    """
    override = os.environ.get("ELIUM_UPDATE_MANIFEST_URL")
    last: UpdateCheckError | None = None
    for attempt in range(1, _MANIFEST_FETCH_ATTEMPTS + 1):
        try:
            if override:
                manifest_url, sig_url = override, override + ".sig"
            else:
                resolved = _resolve_latest_asset_urls()
                if not resolved:
                    raise UpdateCheckError("unavailable", "latest.json/.sig absents de la release")
                manifest_url, sig_url = resolved
            raw = _http_get(manifest_url, _MAX_MANIFEST_BYTES)
            sig_hex = _http_get(sig_url, _MAX_MANIFEST_BYTES).decode("ascii", "ignore")
        except UpdateCheckError:
            raise
        except Exception as exc:
            raise UpdateCheckError(_reason_for_exception(exc), str(exc)) from exc

        try:
            return _parse_signed_manifest(raw, sig_hex)
        except UpdateCheckError as exc:
            if exc.reason == "unknown-key":
                raise  # inutile de retenter : une autre livraison ne changera pas la clé
            last = exc
            if attempt < _MANIFEST_FETCH_ATTEMPTS:
                time.sleep(_MANIFEST_FETCH_BACKOFF_S * attempt)
                continue
            raise UpdateCheckError(exc.reason, f"{exc.detail} (après {attempt} tentatives)") from exc
    raise last or UpdateCheckError("unavailable")  # inatteignable


def fetch_manifest() -> SignedManifest | None:
    """Comme `fetch_manifest_ex` mais renvoie None en cas d'échec (cause dans `_last_check_error`)."""
    global _last_check_error
    try:
        manifest = fetch_manifest_ex()
    except UpdateCheckError as exc:
        _last_check_error = exc
        _log(f"fetch_manifest: {exc}")
        return None
    _last_check_error = None
    return manifest


def check_for_update() -> dict[str, Any] | None:
    """Renvoie le manifeste (vérifié) si une version plus récente est disponible, sinon None.

    Un None peut signifier « à jour » OU « vérification impossible » : voir
    `_last_check_error` (None si la vérification a abouti)."""
    manifest = fetch_manifest()
    if not manifest:
        return None
    remote = str(manifest.get("version", ""))
    if not remote or not is_newer(remote, effective_version()):
        return None
    if _is_quarantined(remote):
        _log(f"check_for_update: {remote} en quarantaine (échec de démarrage antérieur) — ignorée")
        return None
    return manifest


# --------------------------------------------------------------------------- #
# Téléchargement vérifié d'un artefact (avec reprise HTTP Range)
# --------------------------------------------------------------------------- #

def _download_verified(
    art: dict[str, Any],
    dest: Path,
    on_progress: Callable[[int], None] | None = None,
) -> bool:
    """Télécharge art['url'] en flux vers dest (progression 0-100), vérifie sha256.

    Même retry borné + backoff qu'`_http_get` sur un échec réseau TRANSITOIRE.
    REPRISE : sur une coupure transitoire le fichier `.part` est CONSERVÉ ; la
    tentative suivante (ou un nouvel essai ultérieur de l'utilisateur) envoie
    `Range: bytes=<taille>-` et ne retélécharge que le reste. Le sha256 de
    l'ensemble (partie existante re-hachée + suite) est vérifié contre le manifeste
    signé ; en cas d'écart sur un fichier repris, on repart de zéro. Une réponse
    trop volumineuse (`ValueError`) ou une erreur HTTP applicative restent des rejets
    définitifs (`.part` supprimé), jamais retentés.
    """
    url = art.get("url")
    expected = str(art.get("sha256", "")).lower()
    if not url or not expected:
        _log("_download_verified: artefact sans url/sha256")
        return False
    total = int(art.get("size", 0) or 0)
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")

    done = False
    resumed = False
    digest = hashlib.sha256()
    for attempt in range(1, _HTTP_MAX_ATTEMPTS + 1):
        digest = hashlib.sha256()
        offset = 0
        resumed = False
        if tmp.exists():
            offset = tmp.stat().st_size
            if offset <= 0 or offset > _MAX_ARTIFACT_BYTES or (total and offset >= total):
                _safe_unlink(tmp)
                offset = 0
            else:
                with open(tmp, "rb") as old:
                    for block in iter(lambda: old.read(1024 * 1024), b""):
                        digest.update(block)
        headers = {"User-Agent": _USER_AGENT}
        if offset:
            headers["Range"] = f"bytes={offset}-"
        try:
            req = urllib.request.Request(url, headers=headers)  # noqa: S310 — schéma https connu / manifeste vérifié en amont.
            with urllib.request.urlopen(req, timeout=_HTTP_TIMEOUT) as resp:  # noqa: S310
                status = getattr(resp, "status", None) or getattr(resp, "code", None) or 200
                if offset and status == 206:
                    crange = ""
                    try:
                        crange = str(resp.headers.get("Content-Range") or "")
                    except Exception:  # noqa: S110 — en-tête absent : on se fie au 206.
                        pass
                    if crange and not crange.startswith(f"bytes {offset}-"):
                        raise ValueError("Content-Range inattendu pour la reprise")
                    resumed = True
                    mode = "ab"
                else:
                    if offset:  # le serveur ignore Range : on repart de zéro
                        digest = hashlib.sha256()
                        offset = 0
                    mode = "wb"
                received = offset
                with open(tmp, mode) as out:
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
        except urllib.error.HTTPError as exc:
            _safe_unlink(tmp)
            if exc.code == 416 and attempt < _HTTP_MAX_ATTEMPTS:
                continue  # plage invalide (fichier changé / déjà complet) : retente depuis zéro
            _log(f"_download_verified: échec téléchargement {url} (HTTP {exc.code})")
            return False
        except Exception as exc:
            transient = _is_transient_network_error(exc)
            try:
                keep = transient and tmp.exists() and tmp.stat().st_size > 0
            except OSError:
                keep = False
            if not keep:
                _safe_unlink(tmp)
            if attempt < _HTTP_MAX_ATTEMPTS and transient:
                delay = _HTTP_RETRY_BACKOFF_BASE * (2 ** (attempt - 1))
                _log(
                    f"_download_verified: échec réseau transitoire ({exc}) — "
                    f"tentative {attempt}/{_HTTP_MAX_ATTEMPTS}, nouvel essai dans {delay:.1f}s ({url})"
                )
                time.sleep(delay)
                continue
            _log(f"_download_verified: échec téléchargement {url} ({exc})"
                 + (" — reprise possible au prochain essai" if keep else ""))
            return False

        if digest.hexdigest() != expected:
            _safe_unlink(tmp)
            if resumed and attempt < _HTTP_MAX_ATTEMPTS:
                _log(f"_download_verified: sha256 incorrect après reprise ({url}) — reprise depuis zéro")
                continue
            _log(f"_download_verified: sha256 mismatch {url} (attendu {expected})")
            return False
        done = True
        break

    if not done:
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


Fetcher = Callable[["dict[str, Any]", Path, "Callable[[int], None] | None"], bool]


# --------------------------------------------------------------------------- #
# Application des màj — web (avec pack d'assets partagé)
# --------------------------------------------------------------------------- #

def _web_artifacts(manifest: Any) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    """(artefact web à télécharger, pack d'assets éventuel).

    Les manifestes récents publient `webCore` (léger) + `assets` (pack lourd, rechargé
    seulement si son empreinte change). `web` reste l'archive COMPLÈTE historique,
    conservée pour les clients plus anciens.
    """
    arts = manifest.get("artifacts", {}) or {}
    if arts.get("webCore") and arts.get("assets"):
        return arts["webCore"], arts["assets"]
    return arts.get("web"), None


def _expected_tree_hash(manifest: Any) -> str | None:
    arts = manifest.get("artifacts", {}) or {}
    for key in ("webCore", "web"):
        h = (arts.get(key) or {}).get("treeHash")
        if h:
            return str(h).lower()
    return None


def _ensure_assets_pack(
    art: dict[str, Any], fetcher: Fetcher, on_progress: Callable[[int], None] | None
) -> Path | None:
    """Dossier du pack d'assets (téléchargé seulement s'il n'est pas déjà en cache et intègre)."""
    tree = str(art.get("treeHash", "")).lower()
    if not tree:
        _log("pack d'assets sans treeHash : refusé")
        return None
    final = _assets_root() / tree[:32]
    if final.is_dir() and tree_hash_dir(final) == tree:
        _log(f"pack d'assets {tree[:12]} déjà présent : aucun téléchargement")
        return final
    tmp_zip = data_dir() / "tmp" / f"assets-{tree[:32]}.zip"
    staging = _assets_root() / f".{tree[:32]}.new"
    try:
        if not fetcher(art, tmp_zip, on_progress):
            return None
        shutil.rmtree(staging, ignore_errors=True)
        staging.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(tmp_zip) as zf:
            _safe_extract_zip(zf, staging)
        if tree_hash_dir(staging) != tree:
            _log("pack d'assets : empreinte d'arborescence incorrecte — rejeté")
            shutil.rmtree(staging, ignore_errors=True)
            return None
        shutil.rmtree(final, ignore_errors=True)
        staging.replace(final)
    except Exception as exc:
        _log(f"pack d'assets : installation échouée ({exc})")
        shutil.rmtree(staging, ignore_errors=True)
        return None
    finally:
        _safe_unlink(tmp_zip)
    return final


def apply_web_update(
    manifest: Any,
    on_progress: Callable[[int], None] | None = None,
    fetcher: Fetcher | None = None,
) -> bool:
    """Télécharge et installe le paquet web dans %LOCALAPPDATA%\\Elium\\web\\<version>.

    Avec un manifeste « scindé » : `webCore` (petit) + pack d'assets (réutilisé s'il est
    déjà en cache) sont FUSIONNÉS dans un seul dossier servi, de sorte que le lanceur
    n'a qu'un répertoire à connaître. Le manifeste signé est conservé à côté pour la
    revérification au lancement.
    """
    fetcher = fetcher or _download_verified
    version = str(manifest["version"])
    web_art, assets_art = _web_artifacts(manifest)
    if not web_art:
        _log("apply_web_update: pas d'artefact web dans le manifeste")
        return False
    if not getattr(manifest, "raw", b""):
        _log("apply_web_update: manifeste non signé/non vérifié — refusé")
        return False

    assets_dir: Path | None = None
    if assets_art:
        assets_dir = _ensure_assets_pack(assets_art, fetcher, on_progress)
        if assets_dir is None:
            return False

    tmp_zip = data_dir() / "tmp" / f"web-{version}.zip"
    if not fetcher(web_art, tmp_zip, on_progress):
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
        if assets_dir is not None:
            shutil.copytree(assets_dir, root, dirs_exist_ok=True)
        actual_tree = tree_hash_dir(root)
        expected_tree = _expected_tree_hash(manifest)
        if expected_tree and actual_tree != expected_tree:
            _log("apply_web_update: empreinte d'arborescence incorrecte — paquet rejeté")
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

    if not _store_signed_manifest(manifest, _web_root() / version):
        return False
    if not expected_tree:
        # Manifeste ancien (sans treeHash signé) : on mémorise l'empreinte locale au moins
        # pour détecter une altération/corruption ultérieure (non infalsifiable).
        (_web_root() / f"{version}.tree").write_text(actual_tree, encoding="utf-8")
    _set_pointer(version)
    _overlay_memo.pop(version, None)
    _prune_old_web(keep={version, current_version()})
    _prune_assets()
    sync_arp_version(version if is_newer(version, current_version()) else current_version())
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


def _locate_web_root(staging: Path) -> Path | None:
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


def _read_pointer() -> str | None:
    try:
        return _pointer_file().read_text(encoding="utf-8").strip() or None
    except OSError:
        return None


def _prune_old_web(keep: set[str]) -> None:
    try:
        for child in _web_root().iterdir():
            if child.name.startswith(".") or child.name == _pointer_file().name:
                continue
            if child.is_dir():
                if child.name not in keep:
                    shutil.rmtree(child, ignore_errors=True)
                    _remove_sidecar(child)
                    _safe_unlink(child.with_name(child.name + ".tree"))
            else:
                # Sidecars orphelins (manifeste/signature/empreinte d'une version supprimée).
                stem = re.sub(r"\.(manifest\.json(\.sig)?|tree)$", "", child.name)
                if stem != child.name and not (child.parent / stem).is_dir():
                    _safe_unlink(child)
    except OSError:
        pass


def _prune_assets() -> None:
    """Ne garde que les packs d'assets référencés par une version web conservée."""
    keep: set[str] = set()
    try:
        for child in _web_root().iterdir():
            if child.is_dir() and not child.name.startswith("."):
                m = _load_signed_manifest(child)
                art = (m or {}).get("artifacts", {}).get("assets") if m else None
                if art and art.get("treeHash"):
                    keep.add(str(art["treeHash"]).lower()[:32])
        for d in _assets_root().iterdir():
            if d.is_dir() and d.name not in keep:
                shutil.rmtree(d, ignore_errors=True)
    except OSError:
        pass


# --------------------------------------------------------------------------- #
# Vérification de l'overlay web (rejouée au lancement)
# --------------------------------------------------------------------------- #

_overlay_memo: dict[str, tuple[tuple, bool]] = {}


def reset_verification_cache() -> None:
    """Oublie les verdicts mémorisés : la prochaine lecture re-hache tout (appelé au lancement)."""
    _overlay_memo.clear()


def _mtime_ns(path: Path) -> int:
    try:
        return path.stat().st_mtime_ns
    except OSError:
        return -1


def _verify_overlay(version: str) -> bool:
    d = _web_root() / version
    if not (d / "index.html").is_file():
        return False
    manifest = _load_signed_manifest(d)
    if manifest is None:
        _log(f"overlay web {version} : manifeste signé absent ou invalide — ignoré")
        return False
    if str(manifest.get("version", "")) != version:
        _log(f"overlay web {version} : le manifeste signé concerne {manifest.get('version')!r} — ignoré")
        return False
    actual = tree_hash_dir(d)
    expected = _expected_tree_hash(manifest)
    if expected is None:
        try:
            expected = (_web_root() / f"{version}.tree").read_text(encoding="utf-8").strip().lower()
        except OSError:
            expected = None
    if not expected or actual != expected:
        _log(f"overlay web {version} : empreinte d'arborescence incorrecte — ignoré (retour à la version embarquée)")
        return False
    return True


def _overlay_ok(version: str) -> bool:
    key = (version, _mtime_ns(_pointer_file()), _mtime_ns(_sidecar_paths(_web_root() / version)[0]))
    hit = _overlay_memo.get(version)
    if hit and hit[0] == key:
        return hit[1]
    ok = _verify_overlay(version)
    _overlay_memo[version] = (key, ok)
    return ok


def _verified_pointer() -> str | None:
    version = _read_pointer()
    if not version or not _overlay_ok(version):
        return None
    return version


def active_web_dir() -> str | None:
    """Dossier web de l'overlay s'il est strictement plus récent que la version embarquée ET vérifié."""
    version = _verified_pointer()
    if not version:
        return None
    if not is_newer(version, current_version()):
        return None  # l'exe embarque déjà un web au moins aussi récent
    candidate = _web_root() / version
    if (candidate / "index.html").is_file():
        return str(candidate)
    return None


# --------------------------------------------------------------------------- #
# Application des màj — exe
# --------------------------------------------------------------------------- #

def apply_exe_update(
    manifest: Any,
    on_progress: Callable[[int], None] | None = None,
    fetcher: Fetcher | None = None,
) -> bool:
    """Télécharge le nouveau lanceur complet dans bin\\ ; appliqué au prochain démarrage."""
    fetcher = fetcher or _download_verified
    version = str(manifest["version"])
    art = manifest.get("artifacts", {}).get("exe")
    if not art:
        _log("apply_exe_update: pas d'artefact exe dans le manifeste")
        return False
    if not getattr(manifest, "raw", b""):
        _log("apply_exe_update: manifeste non signé/non vérifié — refusé")
        return False

    dest = _bin_root() / f"Elium-{version}.exe"
    if not fetcher(art, dest, on_progress):
        return False
    if not _store_signed_manifest(manifest, dest.with_suffix("")):
        _safe_unlink(dest)
        return False

    try:
        _pending_file().write_text(
            json.dumps({"version": version, "sha256": str(art.get("sha256", "")).lower()}),
            encoding="utf-8",
        )
    except OSError as exc:
        _log(f"apply_exe_update: écriture pending.json échouée ({exc})")
        return False
    _save_json(_boot_state_file(), {"version": version, "attempts": 0, "ok": False})
    _prune_old_exe(keep_count=2)
    _log(f"apply_exe_update: lanceur {version} prêt (handoff au prochain lancement)")
    return True


def _exe_version_of(path: Path) -> str:
    return path.stem[len("Elium-"):]


def _prune_old_exe(keep_count: int = 2) -> None:
    """Ne garde que le lanceur courant + le précédent dans bin\\ (les plus récentes versions)."""
    try:
        exes = sorted(_bin_root().glob("Elium-*.exe"), key=lambda p: _version_tuple(_exe_version_of(p)), reverse=True)
    except OSError:
        return
    for old in exes[keep_count:]:
        _safe_unlink(old)
        _remove_sidecar(old.with_suffix(""))
        _log(f"prune: ancien lanceur {old.name} supprimé")


# --------------------------------------------------------------------------- #
# Handoff : relancer l'exe le plus récent au démarrage (revérifié)
# --------------------------------------------------------------------------- #

def _verified_pending_exe() -> Path | None:
    """Chemin de l'exe en attente s'il est plus récent que nous ET authentique, sinon None.

    Authentique = le manifeste SIGNÉ conservé à côté (signature revérifiée ici, au
    lancement) annonce exactement cette version et le sha256 de CE fichier. Le
    `pending.json` (inscriptible par l'utilisateur) n'est qu'un indice : sa valeur
    sha256 n'est plus une source de confiance.
    """
    pending = _load_json(_pending_file(), None)
    if not isinstance(pending, dict):
        return None
    version = str(pending.get("version", ""))
    if not version or not is_newer(version, current_version()):
        return None  # rien de plus récent que nous
    if _is_quarantined(version):
        return None
    exe = _bin_root() / f"Elium-{version}.exe"
    if not exe.is_file():
        _log(f"pending exe: {exe.name} introuvable")
        return None
    manifest = _load_signed_manifest(exe.with_suffix(""))
    if manifest is None or str(manifest.get("version", "")) != version:
        _log(f"pending exe: manifeste signé de {version} absent ou invalide — ignoré")
        return None
    expected = str((manifest.get("artifacts", {}).get("exe") or {}).get("sha256", "")).lower()
    if not expected or _sha256(exe) != expected:
        _log(f"pending exe: sha256 de {version} différent de celui du manifeste signé — supprimé")
        _safe_unlink(exe)
        _remove_sidecar(exe.with_suffix(""))
        return None
    return exe


def _boot_state(version: str) -> dict[str, Any]:
    st = _load_json(_boot_state_file(), None)
    if not isinstance(st, dict) or st.get("version") != version:
        return {"version": version, "attempts": 0, "ok": False}
    return st


def _fallback_to_base(version: str, reason: str) -> None:
    """Abandonne l'exe `version` (plantages répétés) : on reste sur la version embarquée."""
    _log(f"handoff: {version} abandonnée ({reason}) — retour à la version embarquée {current_version()}")
    _quarantine(version)
    _safe_unlink(_pending_file())
    exe = _bin_root() / f"Elium-{version}.exe"
    _safe_unlink(exe)
    _remove_sidecar(exe.with_suffix(""))
    _save_json(_fallback_file(), {"version": version, "reason": reason, "base": current_version(),
                                  "at": time.strftime("%Y-%m-%d %H:%M:%S")})


def _may_handoff(version: str) -> bool:
    """Garde anti boucle de plantage. Compte une tentative de démarrage de `version` ; refuse
    (et bascule sur la base) dès qu'elle a échoué MAX_BOOT_ATTEMPTS fois sans « boot ok »."""
    st = _boot_state(version)
    if st.get("ok"):
        return True
    attempts = int(st.get("attempts", 0))
    if attempts >= MAX_BOOT_ATTEMPTS:
        _fallback_to_base(version, f"{attempts} démarrages sans « boot ok »")
        return False
    st["attempts"] = attempts + 1
    _save_json(_boot_state_file(), st)
    return True


def mark_boot_ok() -> None:
    """Appelé par l'application une fois réellement démarrée (page servie) : remet à zéro le
    compteur de plantages de CETTE version et élague les anciens lanceurs."""
    version = current_version()
    st = _load_json(_boot_state_file(), None)
    # Seul le lanceur dont la version est suivie par la garde (celui qui vient d'être
    # remis en main) enregistre son « boot ok » ; la base n'écrase jamais l'état d'un autre.
    if isinstance(st, dict) and st.get("version") == version and not (st.get("ok") and not st.get("attempts")):
        _save_json(_boot_state_file(), {"version": version, "attempts": 0, "ok": True})
    _prune_old_exe(keep_count=2)


def consume_fallback_notice() -> dict[str, Any] | None:
    """Lit (et efface) la trace d'un retour automatique à la version embarquée, pour l'annoncer."""
    notice = _load_json(_fallback_file(), None)
    if not isinstance(notice, dict):
        return None
    _safe_unlink(_fallback_file())
    return notice


ARP_PER_USER_NAME = "Elium (installation utilisateur)"


def sync_arp_version(version: str | None = None) -> bool:
    """Recopie la version RÉELLEMENT active dans « Applications installées » (variante MSI PAR
    UTILISATEUR uniquement : son entrée vit sous HKCU, que l'application peut écrire sans droits
    administrateur). L'entrée de la variante « machine » (HKLM) n'est pas modifiable sans élévation :
    elle garde la version de l'installeur, la version active est affichée dans l'application.
    Best-effort, ne lève jamais ; renvoie True si une entrée a été mise à jour."""
    if os.name != "nt" or os.environ.get("ELIUM_NO_ARP_SYNC") == "1":
        return False
    version = version or effective_version()
    try:
        import winreg  # noqa: PLC0415 — Windows uniquement
        root = r"Software\Microsoft\Windows\CurrentVersion\Uninstall"
        updated = False
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, root) as parent:
            index = 0
            while True:
                try:
                    name = winreg.EnumKey(parent, index)
                except OSError:
                    break
                index += 1
                try:
                    with winreg.OpenKey(parent, name, 0, winreg.KEY_READ | winreg.KEY_SET_VALUE) as sub:
                        display, _ = winreg.QueryValueEx(sub, "DisplayName")
                        if display != ARP_PER_USER_NAME:
                            continue
                        current, _ = winreg.QueryValueEx(sub, "DisplayVersion")
                        if current != version:
                            winreg.SetValueEx(sub, "DisplayVersion", 0, winreg.REG_SZ, version)
                            updated = True
                except OSError:
                    continue
        return updated
    except Exception as exc:  # noqa: BLE001 — cosmétique : jamais bloquant
        _log(f"sync_arp_version: {exc}")
        return False


def startup_checks() -> None:
    """À l'initialisation du lanceur : repart de verdicts neufs et prépare l'annonce d'un repli éventuel."""
    reset_verification_cache()
    notice = consume_fallback_notice()
    if notice:
        _status["fallback"] = notice
    sync_arp_version()


def run_pending_handoff() -> None:
    """Au DÉMARRAGE : si un lanceur plus récent (vérifié) attend dans bin\\, l'exécute puis quitte."""
    if not getattr(sys, "frozen", False):
        return  # jamais de handoff en dev
    if os.environ.get("ELIUM_NO_HANDOFF") == "1":
        return
    exe = _verified_pending_exe()
    if exe is None:
        return
    if not _may_handoff(_exe_version_of(exe)):
        return
    try:
        _log(f"handoff: relance vers {exe.name}")
        # S603 : chemin issu de notre propre répertoire de données, binaire revérifié (signature + sha256).
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
    if not _may_handoff(_exe_version_of(exe)):
        return False
    try:
        _log(f"relaunch: démarrage de {exe.name}")
        subprocess.Popen([str(exe), *sys.argv[1:]])  # noqa: S603
        return True
    except Exception as exc:
        _log(f"relaunch: échec Popen ({exc})")
        return False


# --------------------------------------------------------------------------- #
# Mise à jour depuis un fichier (paquet hors ligne signé « .eliumupdate »)
# --------------------------------------------------------------------------- #

BUNDLE_EXTENSION = ".eliumupdate"
_BUNDLE_MANIFEST = "latest.json"
_BUNDLE_SIG = "latest.json.sig"


def open_update_bundle(path: Path) -> tuple[SignedManifest, zipfile.ZipFile]:
    """Ouvre un paquet hors ligne et vérifie la signature de son manifeste EXACTEMENT comme en ligne.

    Le paquet est un zip : latest.json + latest.json.sig + les artefacts nommés par le
    manifeste. Lève `UpdateCheckError` si le paquet est illisible ou mal signé (le
    ZipFile ouvert est alors refermé).
    """
    try:
        zf = zipfile.ZipFile(path)
    except (OSError, zipfile.BadZipFile) as exc:
        raise UpdateCheckError("unavailable", f"paquet illisible ({exc})") from exc
    try:
        for name in (_BUNDLE_MANIFEST, _BUNDLE_SIG):
            if name not in zf.namelist():
                raise UpdateCheckError("unavailable", f"{name} absent du paquet")
            if zf.getinfo(name).file_size > _MAX_MANIFEST_BYTES:
                raise UpdateCheckError("unavailable", f"{name} trop volumineux")
        raw = zf.read(_BUNDLE_MANIFEST)
        sig = zf.read(_BUNDLE_SIG).decode("ascii", "ignore")
        return _parse_signed_manifest(raw, sig), zf
    except BaseException:
        zf.close()
        raise


def _bundle_fetcher(zf: zipfile.ZipFile) -> Fetcher:
    def fetch(art: dict[str, Any], dest: Path, on_progress: Callable[[int], None] | None = None) -> bool:
        name = str(art.get("name") or "")
        expected = str(art.get("sha256", "")).lower()
        if not name or not expected or name not in zf.namelist():
            _log(f"paquet : artefact {name!r} absent")
            return False
        info = zf.getinfo(name)
        if info.file_size > _MAX_ARTIFACT_BYTES or (art.get("size") and info.file_size != int(art["size"])):
            _log(f"paquet : taille de {name!r} incohérente avec le manifeste signé")
            return False
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.with_suffix(dest.suffix + ".part")
        digest = hashlib.sha256()
        done = 0
        try:
            with zf.open(info) as src, open(tmp, "wb") as out:
                for block in iter(lambda: src.read(256 * 1024), b""):
                    out.write(block)
                    digest.update(block)
                    done += len(block)
                    if on_progress and info.file_size:
                        on_progress(min(99, int(done * 100 / info.file_size)))
        except (OSError, zipfile.BadZipFile) as exc:
            _safe_unlink(tmp)
            _log(f"paquet : lecture de {name!r} échouée ({exc})")
            return False
        if digest.hexdigest() != expected:
            _safe_unlink(tmp)
            _log(f"paquet : sha256 de {name!r} différent de celui du manifeste signé")
            return False
        _safe_unlink(dest)
        tmp.replace(dest)
        if on_progress:
            on_progress(100)
        return True

    return fetch


def apply_update_bundle(path: Path, on_progress: Callable[[int], None] | None = None) -> dict[str, Any]:
    """Applique un paquet hors ligne : même vérifications, même installation que la voie en ligne."""
    if os.environ.get("ELIUM_NO_UPDATE") == "1":
        return _publish("disabled")
    try:
        manifest, zf = open_update_bundle(Path(path))
    except UpdateCheckError as exc:
        _log(f"apply_update_bundle: {exc}")
        return _publish("error", reason=f"bundle-{exc.reason}", message=_bundle_message(exc.reason))
    try:
        version = str(manifest.get("version", ""))
        if not version or not is_newer(version, effective_version()):
            return _publish("error", version=version or None, reason="bundle-not-newer",
                            message="Ce paquet n'est pas plus récent que la version installée.")
        kind = "exe" if _needs_exe(manifest) else "web"
        if kind == "exe" and not (manifest.get("artifacts") or {}).get("exe"):
            return _publish("error", version=version, reason="bundle-incomplete",
                            message="Le paquet ne contient pas l'application complète requise.")
        _publish("downloading", version=version, kind=kind, progress=0)

        def prog(pct: int) -> None:
            _status["progress"] = pct
            if on_progress:
                on_progress(pct)

        fetcher = _bundle_fetcher(zf)
        try:
            ok = (apply_exe_update(manifest, prog, fetcher) if kind == "exe"
                  else apply_web_update(manifest, prog, fetcher))
        except Exception as exc:
            _log(f"apply_update_bundle: {exc}")
            ok = False
        if not ok:
            return _publish("error", version=version, kind=kind, reason="bundle-failed",
                            message="Le contenu du paquet est invalide ou incomplet : rien n'a été installé.")
        _log(f"apply_update_bundle: version {version} installée depuis un fichier ({kind})")
        releases = release_notes(manifest)
        return _publish(f"{kind}-ready", version=version, kind=kind, progress=100,
                        releases=releases, summary=changelog.summarize(releases))
    finally:
        zf.close()


def _bundle_message(reason: str) -> str:
    return {
        "invalid-signature": "La signature de ce paquet est invalide : il a été refusé par sécurité.",
        "unknown-key": "Ce paquet est signé par une clé inconnue de cette version d'Elium.",
    }.get(reason, "Ce fichier n'est pas un paquet de mise à jour Elium valide.")


def start_bundle_update(path: Path) -> dict[str, Any]:
    """Lance l'application d'un paquet hors ligne en tâche de fond (bouton « Mettre à jour depuis un fichier »)."""
    if os.environ.get("ELIUM_NO_UPDATE") == "1":
        return _publish("disabled")
    if _status.get("state") == "downloading":
        if Path(path).parent == data_dir() / "tmp":
            _safe_unlink(Path(path))
        return get_status()

    def run() -> None:
        if not _apply_lock.acquire(blocking=False):
            return
        try:
            apply_update_bundle(path)
        finally:
            _apply_lock.release()
            if Path(path).parent == data_dir() / "tmp":  # copie de travail déposée par le lanceur
                _safe_unlink(Path(path))

    threading.Thread(target=run, daemon=True).start()
    return _publish("downloading", progress=0)


# --------------------------------------------------------------------------- #
# Orchestration — cycle : détection (bouton) -> téléchargement animé -> prêt
# --------------------------------------------------------------------------- #

# Statut lu par l'endpoint /__update__ (la carte web s'y adapte).
#   state : idle | up-to-date | disabled | available | downloading
#           | web-ready | exe-ready | check-failed | error
#   reason : cause précise (état check-failed : offline | rate-limited |
#            invalid-signature | unknown-key | unavailable ; état error : bundle-*)
#   message : phrase française explicative associée à `reason`
#   kind  : "web" | "exe" (comment la màj s'appliquera)
#   progress : 0-100 pendant le téléchargement
#   channel : "stable" | "beta"
#   fallback : {version, reason, base} si un exe a été abandonné (plantages) au dernier démarrage
#   releases : [{version, date, changes[]}] — tout ce que l'utilisateur n'a pas
#              encore, de la plus récente à la plus ancienne (pas seulement la
#              dernière release), pour que la carte annonce l'ensemble des
#              nouveautés apportées.
#   summary  : « 3 versions, 12 nouveautés »
_status: dict[str, Any] = {
    "state": "idle", "version": None, "kind": None, "progress": 0,
    "releases": [], "summary": "", "notes": "", "reason": None, "message": "",
}
_pending_manifest: dict[str, Any] | None = None
_apply_lock = threading.Lock()
_last_check_monotonic = 0.0  # throttle des re-vérifications (secondes monotoniques)
_consecutive_check_failures = 0


def get_status() -> dict[str, Any]:
    st = dict(_status)
    st["channel"] = get_channel()
    return st


def _publish(state: str, *, version: str | None = None,
             kind: str | None = None, progress: int = 0,
             releases: list | None = None, summary: str | None = None,
             notes: str | None = None, reason: str | None = None,
             message: str = "") -> dict[str, Any]:
    _status.update({"state": state, "version": version, "kind": kind, "progress": progress,
                    "reason": reason, "message": message})
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
    """Détecte une màj SANS télécharger. Passe l'état à 'available' le cas échéant.

    Si la vérification ELLE-MÊME échoue (hors ligne, quota GitHub, signature invalide...),
    l'état est `check-failed` avec la cause : ce n'est PAS « à jour »."""
    global _pending_manifest, _consecutive_check_failures
    if os.environ.get("ELIUM_NO_UPDATE") == "1":
        return _publish("disabled")
    try:
        manifest = check_for_update()
    except Exception as exc:
        _log(f"check_only: {exc}")
        return _publish("error")
    if not manifest:
        _pending_manifest = None
        err = _last_check_error
        if err is not None:
            _consecutive_check_failures += 1
            return _publish("check-failed", reason=err.reason,
                            message=REASON_MESSAGES.get(err.reason, REASON_MESSAGES["unavailable"]))
        _consecutive_check_failures = 0
        return _publish("up-to-date")
    _consecutive_check_failures = 0
    _pending_manifest = manifest
    kind = "exe" if _needs_exe(manifest) else "web"
    _log(f"check_only: màj {manifest.get('version')} disponible ({kind}, canal {get_channel()})")
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


def check_and_apply(on_status: Callable[[dict[str, Any]], None] | None = None) -> dict[str, Any]:
    """Compat/headless : vérifie ET applique immédiatement (utilisé par les tests)."""
    if os.environ.get("ELIUM_NO_UPDATE") == "1":
        return _publish("disabled")
    try:
        manifest = check_for_update()
    except Exception as exc:
        _log(f"check_and_apply: {exc}")
        return _publish("error")
    if not manifest:
        err = _last_check_error
        if err is not None:
            return _publish("check-failed", reason=err.reason,
                            message=REASON_MESSAGES.get(err.reason, REASON_MESSAGES["unavailable"]))
        return _publish("up-to-date")
    status = _apply(manifest)
    if status["state"] in ("web-ready", "exe-ready") and on_status:
        try:
            on_status(status)
        except Exception as e:
            _log(f"check_and_apply: le callback on_status a échoué ({e})")
    return status


def set_channel(name: str) -> dict[str, Any]:
    """Change de canal (persisté) puis relance une détection : la carte reflète aussitôt le nouveau canal."""
    global _pending_manifest
    name = (name or "").strip().lower()
    if name not in CHANNELS:
        return get_status()
    cfg = _load_json(_settings_file(), {})
    if not isinstance(cfg, dict):
        cfg = {}
    cfg["channel"] = name
    _save_json(_settings_file(), cfg)
    _pending_manifest = None
    _log(f"canal de mise à jour : {name}")
    if _status.get("state") not in ("downloading", "exe-ready"):
        _publish("idle")
        start_background_check()
    return get_status()


def start_background_check() -> None:
    """Lance la DÉTECTION dans un thread daemon (n'impacte jamais le démarrage)."""
    global _last_check_monotonic
    try:
        _last_check_monotonic = time.monotonic()
    except Exception as e:
        _log(f"start_background_check: time.monotonic() a échoué ({e})")
    threading.Thread(target=check_only, daemon=True).start()


# Avant ce correctif, la SEULE revérification passé le lancement était celle,
# THROTTLÉE à 30s, déclenchée par une navigation dans l'app (`on_navigation`) —
# une session ouverte plusieurs jours sans jamais recharger de page pouvait donc
# ne JAMAIS revoir la vérification initiale si elle avait échoué (ou simplement
# rater une publication récente pendant des jours). Un vrai minuteur périodique,
# indépendant de l'usage de l'app, corrige les deux.
_PERIODIC_CHECK_INTERVAL_S = 30 * 60  # 30 min : largement sous la limite API GitHub non authentifiée (60/h)
_periodic_check_started = False
# Entre deux navigations, on ne retouche le réseau qu'au bout de ce délai de base,
# doublé à chaque échec consécutif (plafonné) : jamais de martèlement quand on est hors ligne.
_NAV_CHECK_INTERVAL_S = 300.0


def start_periodic_check(interval_s: float = _PERIODIC_CHECK_INTERVAL_S) -> None:
    """Revérifie automatiquement toutes les `interval_s` secondes, tant que le
    process tourne. Idempotent (un seul minuteur actif, même appelé plusieurs fois)."""
    global _periodic_check_started
    if _periodic_check_started:
        return
    _periodic_check_started = True

    def _loop() -> None:
        while True:
            time.sleep(interval_s)
            # N'écrase jamais un téléchargement en cours ni une màj déjà prête :
            # check_only() lui-même ne fait que détecter, mais évite le bruit
            # inutile si l'utilisateur est déjà en train d'appliquer une màj.
            if _status.get("state") in ("downloading", "web-ready", "exe-ready"):
                continue
            try:
                check_only()
            except Exception as e:
                _log(f"start_periodic_check: check_only() a échoué ({e})")

    threading.Thread(target=_loop, daemon=True).start()


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
    latest: str | None = None
    up_to_date = True
    check_failed: str | None = None
    if state == "available" and st.get("version"):
        latest = str(st["version"])
        up_to_date = not is_newer(latest, installed)
    elif state in ("web-ready", "exe-ready") and st.get("version"):
        latest = str(st["version"])  # màj téléchargée, en attente d'application
        up_to_date = False
    elif state == "check-failed":
        check_failed = str(st.get("reason") or "unavailable")
    # état inconnu (idle/up-to-date/error/downloading) -> considéré à jour ;
    # la vérification d'arrière-plan met _status à jour peu après le lancement.
    # `upToDate` reste True en `check-failed` (compat) : l'interface lit `checkFailed`
    # pour NE PAS afficher « à jour » quand la vérification n'a pas pu avoir lieu.
    return {
        "installed": installed, "base": base, "latest": latest, "upToDate": up_to_date,
        "checkFailed": check_failed,
        "checkMessage": REASON_MESSAGES.get(check_failed or "", "") if check_failed else "",
        "channel": st.get("channel"),
    }


def _manifest_url_for(version: str) -> str:
    v = version if version.startswith("v") else f"v{version}"
    return f"https://github.com/{REPO}/releases/download/{v}/{_MANIFEST_NAME}"


def fetch_manifest_for(version: str) -> SignedManifest | None:
    """Comme fetch_manifest mais pour une version PRÉCISE (rollback). Signée par la même liste de clés."""
    url = _manifest_url_for(version)
    try:
        raw = _http_get(url, _MAX_MANIFEST_BYTES)
        sig_hex = _http_get(url + ".sig", _MAX_MANIFEST_BYTES).decode("ascii", "ignore")
    except Exception as exc:
        _log(f"fetch_manifest_for({version}): échec réseau ({exc})")
        return None
    try:
        return _parse_signed_manifest(raw, sig_hex)
    except UpdateCheckError as exc:
        _log(f"fetch_manifest_for({version}): {exc.reason} — rejeté")
        return None


def list_releases() -> list[dict[str, Any]]:
    """Versions publiées (API GitHub), plus récentes d'abord, hors brouillons.

    Les préversions n'apparaissent que sur le canal bêta. Chaque entrée :
    {version, date, name, prerelease, installed, canRollback}. `canRollback`
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
    beta = get_channel() == "beta"
    out: list[dict[str, Any]] = []
    for r in arr if isinstance(arr, list) else []:
        if r.get("draft") or (r.get("prerelease") and not beta):
            continue
        tag = str(r.get("tag_name") or "").lstrip("v")
        if not tag:
            continue
        out.append({
            "version": tag,
            "date": str(r.get("published_at") or "")[:10],
            "name": str(r.get("name") or ""),
            "prerelease": bool(r.get("prerelease")),
            "installed": tag == installed,
            # Applicable via l'overlay uniquement si >= version de base embarquée.
            "canRollback": not is_newer(base, tag),
        })
    try:
        out.sort(key=lambda x: _version_tuple(str(x["version"])), reverse=True)
    except Exception as e:
        _log(f"list_releases: tri par version a échoué, ordre GitHub conservé ({e})")
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
            _remove_sidecar(child.with_suffix(""))
    except OSError:
        pass
    _safe_unlink(_boot_state_file())
    _prune_old_web(keep={current_version()})
    _prune_assets()
    reset_verification_cache()
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
    ré-afficher la carte, puis on re-vérifie (throttlé, avec backoff après échecs).
    `effective_version()` garantit qu'une version déjà appliquée n'est jamais
    re-proposée. Ne perturbe PAS un téléchargement en cours ni une màj exe prête
    à redémarrer."""
    global _last_check_monotonic
    state = _status.get("state")
    if state in ("downloading", "exe-ready"):
        return
    if state in ("web-ready", "available", "error", "up-to-date", "check-failed"):
        _publish("idle")
    try:
        now = time.monotonic()
    except Exception:
        now = 0.0
    interval = _NAV_CHECK_INTERVAL_S * (2 ** min(_consecutive_check_failures, 4))
    if now - _last_check_monotonic < interval:
        return
    start_background_check()
