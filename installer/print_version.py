"""Affiche la version applicative courante (source unique : src/elium/__init__.py).

Utilise par build_msi.bat pour nommer dynamiquement Elium-X.Y.Z-Setup.msi sans
dupliquer/coder-en-dur la version (evite la derive vue avant ce script, ou le
nom de fichier restait fige a "4.0.0" alors que stamp_version.py avait bien
mis a jour toutes les autres sources).
"""
from __future__ import annotations

from build_common import repo_root


def main() -> None:
    init_path = repo_root() / "src" / "elium" / "__init__.py"
    text = init_path.read_text(encoding="utf-8")
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("__version__"):
            print(line.split("=", 1)[1].strip().strip('"').strip("'"))
            return
    raise SystemExit(f"__version__ introuvable dans {init_path}")


if __name__ == "__main__":
    main()
