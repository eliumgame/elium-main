"""
Utilitaires partagés par les scripts de build d'update (stamp_version, gen_manifest).

Le point central est ``compute_code_hash`` : une empreinte stable des sources Python
FIGÉES dans l'exe (le lanceur + l'updater + le cœur elium), qui sert à décider si une
mise à jour peut passer par le web seul (interface React, léger) ou exige un nouvel exe
complet (le code natif a changé).

Invariants importants :
  - La version applicative (``src/elium/__init__.py``) est EXCLUE : elle change à chaque
    release, sinon toute release forcerait une màj exe et casserait les màj web légères.
  - ``installer/updater.py`` est NORMALISÉ (sa constante BUILD_CODE_HASH est neutralisée)
    avant hachage, sinon injecter le hash dedans changerait le hash (œuf/poule).
  - Les fins de ligne sont normalisées (CRLF -> LF) pour un hash identique quel que soit
    l'OS/checkout (Windows en dev, Linux en CI).
"""
from __future__ import annotations

import hashlib
import re
from pathlib import Path

CODE_HASH_PLACEHOLDER = "__BUILD_CODE_HASH__"

# Fichiers dont le contenu définit le comportement natif figé dans l'exe.
_LAUNCHER_FILES = ["installer/elium_launcher.py", "installer/updater.py"]

# Motif de la constante à neutraliser dans updater.py avant hachage.
_BUILD_HASH_RE = re.compile(r'^BUILD_CODE_HASH = "[^"]*"', re.MULTILINE)


def repo_root() -> Path:
    """Racine du dépôt (le parent de installer/)."""
    return Path(__file__).resolve().parent.parent


def _read_normalized(path: Path) -> bytes:
    data = path.read_bytes().replace(b"\r\n", b"\n").replace(b"\r", b"\n")
    if path.name == "updater.py":
        text = data.decode("utf-8")
        text = _BUILD_HASH_RE.sub(f'BUILD_CODE_HASH = "{CODE_HASH_PLACEHOLDER}"', text)
        data = text.encode("utf-8")
    return data


def _code_files(root: Path) -> list[Path]:
    files: list[Path] = []
    for rel in _LAUNCHER_FILES:
        p = root / rel
        if p.is_file():
            files.append(p)
    core = root / "src" / "elium"
    version_file = (core / "__init__.py").resolve()
    for p in sorted(core.rglob("*.py")):
        if p.resolve() == version_file:
            continue  # version exclue (change à chaque release)
        files.append(p)
    return files


def compute_code_hash(root: Path | None = None) -> str:
    """sha256 déterministe des sources Python figées (chemins POSIX triés + contenu normalisé)."""
    root = root or repo_root()
    entries: list[tuple[str, str]] = []
    for path in _code_files(root):
        rel = path.relative_to(root).as_posix()
        entries.append((rel, hashlib.sha256(_read_normalized(path)).hexdigest()))
    entries.sort()
    joined = "\n".join(f"{rel}:{digest}" for rel, digest in entries)
    return hashlib.sha256(joined.encode("utf-8")).hexdigest()


if __name__ == "__main__":
    print(compute_code_hash())
