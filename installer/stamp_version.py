"""
Stampe une version applicative dans tous les emplacements pertinents, et injecte le
BUILD_CODE_HASH dans installer/updater.py. Lancé par le CI juste avant le build (à partir
du tag) et utilisable en local.

Emplacements APPLICATIFS mis à jour (source unique runtime = src/elium/__init__.py) :
  - src/elium/__init__.py        __version__ = "X.Y.Z"           (version complète)
  - web-studio/package.json      "version": "X.Y.Z"             (version complète)
  - installer/elium.wxs          <?define Version = "X.Y.Z" ?>  (cœur numérique, MSI)
  - installer/elium_setup.iss    #define AppVersion "X.Y.Z"     (cœur numérique, Inno)
  - installer/updater.py         BUILD_CODE_HASH = "<sha256>"

NE TOUCHE PAS la version du FORMAT .elium (src/elium/format/package.py,
web-studio/src/format/document.ts, elium-package.ts) — c'est une autre notion.

Usage :
    python installer/stamp_version.py 4.1.0
    python installer/stamp_version.py v4.1.0
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

from build_common import CODE_HASH_PLACEHOLDER, compute_code_hash, repo_root


def _normalize(version: str) -> tuple[str, str]:
    """Renvoie (version complète sans 'v', cœur numérique X.Y.Z)."""
    v = version.strip()
    if v.lower().startswith("v"):
        v = v[1:]
    core = v.split("-", 1)[0].split("+", 1)[0]
    parts = core.split(".")
    while len(parts) < 3:
        parts.append("0")
    core = ".".join(parts[:3])
    return v, core


def _sub_in_file(path: Path, pattern: str, replacement: str, *, count: int = 0) -> bool:
    if not path.is_file():
        print(f"  [skip] {path} (absent)")
        return False
    original = path.read_text(encoding="utf-8")
    new, n = re.subn(pattern, replacement, original, count=count, flags=re.MULTILINE)
    if n == 0:
        print(f"  [warn] motif introuvable dans {path}")
        return False
    if new != original:
        path.write_text(new, encoding="utf-8")
    print(f"  [ok]   {path} ({n} remplacement(s))")
    return True


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 2

    full, core = _normalize(sys.argv[1])
    root = repo_root()
    print(f"Version applicative : {full}  (cœur MSI/Inno : {core})")

    _sub_in_file(
        root / "src" / "elium" / "__init__.py",
        r'__version__ = "[^"]*"',
        f'__version__ = "{full}"',
    )
    _sub_in_file(
        root / "web-studio" / "package.json",
        r'("version":\s*")[^"]*(")',
        rf'\g<1>{full}\g<2>',
        count=1,
    )
    _sub_in_file(
        root / "installer" / "elium.wxs",
        r'(<\?define Version = ")[^"]*(" \?>)',
        rf'\g<1>{core}\g<2>',
    )
    _sub_in_file(
        root / "installer" / "elium_setup.iss",
        r'(#define AppVersion ")[^"]*(")',
        rf'\g<1>{core}\g<2>',
    )

    # BUILD_CODE_HASH : calculé après stampage (le calcul normalise déjà __init__.py exclu
    # et la constante elle-même, donc l'ordre n'a pas d'importance).
    code_hash = compute_code_hash(root)
    print(f"BUILD_CODE_HASH : {code_hash}")
    _sub_in_file(
        root / "installer" / "updater.py",
        r'^BUILD_CODE_HASH = "[^"]*"',
        f'BUILD_CODE_HASH = "{code_hash}"',
        count=1,
    )
    if code_hash == CODE_HASH_PLACEHOLDER:  # garde-fou, ne devrait jamais arriver
        print("  [erreur] code_hash == placeholder")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
