"""Stockage en fichiers locaux de l'app Windows (API /__files__/ du lanceur).

Logique PURE (sans HTTP) : le lanceur n'expose que ce module, restreint à un
dossier de travail (par défaut Documents\\Elium). Le client ne fournit JAMAIS un
chemin du disque, seulement un chemin LOGIQUE « Dossier/fichier.ext » validé ici
(liste blanche de dossiers et d'extensions, caractères et noms Windows interdits,
résolution réelle qui doit rester sous la racine). Écritures atomiques ; une
suppression déplace le fichier dans `.corbeille/` (purgée après 30 jours).
Conception : voir web-studio/src/docs/sections (stockage local).
"""
from __future__ import annotations

import os
import re
import shutil
import time
from collections.abc import Iterator
from pathlib import Path
from typing import BinaryIO

ALLOWED_DIRS = ("Documents", "Classeurs", "Presentations", "PDF", "Passeport", "Annexes", "Sauvegardes", "_elium")
ALLOWED_EXTS = (".elium", ".json", ".pdf", ".vault", ".elium-workspace", ".elium-extra")
MAX_FILE_BYTES = 512 * 1024 * 1024
MAX_NAME_LEN = 200
TRASH_DIR = ".corbeille"
TRASH_RETENTION_S = 30 * 24 * 3600

_FORBIDDEN_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
_RESERVED = {
    "CON", "PRN", "AUX", "NUL",
    *(f"COM{i}" for i in range(1, 10)),
    *(f"LPT{i}" for i in range(1, 10)),
}


class PathRefused(ValueError):
    """Chemin logique refusé (traversée, nom invalide, hors liste blanche…)."""


def default_root() -> Path:
    """Dossier « Documents » réel de l'utilisateur (Windows : peut être redirigé,
    ex. OneDrive) + « Elium » ; repli sur ~/Documents/Elium."""
    docs = None
    if os.name == "nt":
        try:
            import ctypes
            from ctypes import wintypes

            guid = (ctypes.c_ubyte * 16)(
                *bytes.fromhex("D0 9A D3 FD 8F 23 AF 46 AD B4 6C 85 48 03 69 C7".replace(" ", ""))
            )  # FOLDERID_Documents {FDD39AD0-238F-46AF-ADB4-6C85480369C7}
            out = ctypes.c_wchar_p()
            fn = ctypes.windll.shell32.SHGetKnownFolderPath  # type: ignore[attr-defined]
            fn.argtypes = [ctypes.c_void_p, wintypes.DWORD, wintypes.HANDLE, ctypes.POINTER(ctypes.c_wchar_p)]
            if fn(ctypes.byref(guid), 0, None, ctypes.byref(out)) == 0 and out.value:
                docs = Path(out.value)
                ctypes.windll.ole32.CoTaskMemFree(out)  # type: ignore[attr-defined]
        except Exception:
            docs = None
    return (docs or Path.home() / "Documents") / "Elium"


def validate_logical_path(p: str) -> tuple[str, str]:
    """Valide « Dossier/fichier.ext » → (dossier, fichier). Lève PathRefused."""
    if not isinstance(p, str) or not p or len(p) > 400:
        raise PathRefused("chemin vide ou trop long")
    parts = p.split("/")
    if len(parts) != 2:
        raise PathRefused("un chemin = un dossier + un fichier")
    folder, name = parts
    if folder not in ALLOWED_DIRS:
        raise PathRefused("dossier non autorisé")
    if not name or len(name) > MAX_NAME_LEN or name in (".", ".."):
        raise PathRefused("nom de fichier invalide")
    if _FORBIDDEN_CHARS.search(name) or name != name.strip() or name.endswith("."):
        raise PathRefused("caractère interdit dans le nom")
    if name.split(".", 1)[0].rstrip(" ").upper() in _RESERVED:
        raise PathRefused("nom réservé par Windows")
    if not name.lower().endswith(ALLOWED_EXTS):
        raise PathRefused("extension non autorisée")
    return folder, name


class LocalFiles:
    def __init__(self, root: Path):
        self.root = Path(root)

    # -- racine / résolution -------------------------------------------------
    def ensure_root(self) -> None:
        self.root.mkdir(parents=True, exist_ok=True)

    def resolve(self, p: str) -> Path:
        folder, name = validate_logical_path(p)
        base = self.root.resolve()
        target = (base / folder / name).resolve()
        # Un lien symbolique / jonction qui sortirait de la racine est refusé.
        if base != target and base not in target.parents:
            raise PathRefused("chemin hors du dossier de travail")
        return target

    # -- opérations ----------------------------------------------------------
    def list(self) -> list[dict]:
        out: list[dict] = []
        for folder in ALLOWED_DIRS:
            d = self.root / folder
            if not d.is_dir():
                continue
            for entry in d.iterdir():
                try:
                    if not entry.is_file() or entry.is_symlink():
                        continue
                    validate_logical_path(f"{folder}/{entry.name}")
                    st = entry.stat()
                except (OSError, PathRefused):
                    continue
                out.append({"p": f"{folder}/{entry.name}", "size": st.st_size, "mtime": int(st.st_mtime * 1000)})
        return sorted(out, key=lambda e: e["p"])

    def read(self, p: str) -> bytes:
        target = self.resolve(p)
        if not target.is_file():
            raise FileNotFoundError(p)
        if target.stat().st_size > MAX_FILE_BYTES:
            raise PathRefused("fichier trop volumineux")
        return target.read_bytes()

    def write_stream(self, p: str, src: BinaryIO, length: int) -> int:
        """Écrit `length` octets lus dans `src` : fichier temporaire puis os.replace
        (jamais de fichier à moitié écrit à la place d'un bon)."""
        if not 0 <= length <= MAX_FILE_BYTES:
            raise PathRefused("taille invalide")
        target = self.resolve(p)
        target.parent.mkdir(parents=True, exist_ok=True)
        tmp = target.with_name(f".{target.name}.{os.getpid()}.tmp")
        remaining = length
        try:
            with open(tmp, "wb") as f:
                while remaining:
                    chunk = src.read(min(1 << 20, remaining))
                    if not chunk:
                        raise OSError("corps de requête tronqué")
                    f.write(chunk)
                    remaining -= len(chunk)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, target)
        except BaseException:
            try:
                tmp.unlink()
            except OSError:
                pass
            raise
        return length

    def write(self, p: str, data: bytes) -> int:
        import io

        return self.write_stream(p, io.BytesIO(data), len(data))

    def remove(self, p: str, hard: bool = False) -> bool:
        """« Supprime » = déplace dans .corbeille/ (horodaté). False si absent.
        `hard` : effacement définitif (ex. copie en clair remplacée par une copie
        chiffrée : elle ne doit pas survivre dans la corbeille)."""
        target = self.resolve(p)
        if not target.is_file():
            return False
        if hard:
            target.unlink()
            return True
        trash = self.root / TRASH_DIR
        trash.mkdir(parents=True, exist_ok=True)
        stamp = time.strftime("%Y%m%d-%H%M%S")
        dest = trash / f"{stamp}-{p.replace('/', '__')}"
        n = 1
        while dest.exists():
            n += 1
            dest = trash / f"{stamp}-{n}-{p.replace('/', '__')}"
        shutil.move(str(target), str(dest))
        return True

    def purge_trash(self, now: float | None = None) -> int:
        trash = self.root / TRASH_DIR
        if not trash.is_dir():
            return 0
        limit = (now if now is not None else time.time()) - TRASH_RETENTION_S
        removed = 0
        for entry in self._iter_files(trash):
            try:
                if entry.stat().st_mtime < limit:
                    entry.unlink()
                    removed += 1
            except OSError:
                continue
        return removed

    @staticmethod
    def _iter_files(d: Path) -> Iterator[Path]:
        for e in d.iterdir():
            if e.is_file() and not e.is_symlink():
                yield e
