"""
Calcule la PROCHAINE version à publier à partir des commits « conventionnels » depuis la
dernière release — pour le workflow « Release » déclenché à la main (bump automatique).

Règles (SemVer, commits au format `type(scope)!: sujet`) :
  - `BREAKING CHANGE` dans le corps, ou `!` après le type  -> majeur
  - `feat`                                                  -> mineur
  - `fix`, `perf`, `refactor`, `security`, ou tout autre sujet non « bruit » -> correctif
  - uniquement du bruit (`chore`, `docs`, `ci`, `test`, `style`, `build`, `merge`…) -> RIEN à publier
    (code de sortie 3 : on ne publie pas une release vide, et on le DIT au lieu d'un no-op silencieux)

Préversions : `--pre rc` produit `X.Y.Z-rc1`, puis `-rc2`… (le compteur suit les tags existants) ;
sans `--pre`, une version déjà en préversion est PROMUE en finale (4.7.0-rc2 -> 4.7.0).
`--bump major|minor|patch` force le niveau au lieu de le déduire des commits.

Usage :
    python scripts/next_version.py                      # déduit depuis les commits, affiche X.Y.Z
    python scripts/next_version.py --bump minor --pre rc
    python scripts/next_version.py --current 4.9.0 --tags-from-git --since v4.9.0
Sortie standard : la version seule (sans « v »). Codes : 0 ok, 2 usage, 3 rien à publier.
"""
from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

_BUMP_ORDER = {"patch": 0, "minor": 1, "major": 2}
_NOISE = {"chore", "docs", "doc", "ci", "test", "tests", "style", "build", "merge", "revert", "wip", "release", "bump"}
_HEADER = re.compile(r"^(?P<type>[A-Za-z]+)(?:\((?P<scope>[^)]*)\))?(?P<bang>!)?:\s*(?P<subject>.+)$")
_VERSION = re.compile(r"^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.]+))?$")
_ROOT = Path(__file__).resolve().parent.parent


class NothingToRelease(Exception):
    """Aucun commit publiable depuis la dernière release."""


def parse_version(v: str) -> tuple[int, int, int, str]:
    m = _VERSION.match(v.strip())
    if not m:
        raise ValueError(f"version invalide : {v!r}")
    return int(m.group(1)), int(m.group(2)), int(m.group(3)), m.group(4) or ""


def classify_commit(message: str) -> str | None:
    """Niveau de bump d'UN commit (`major`/`minor`/`patch`), ou None pour du bruit."""
    message = message.strip()
    if not message:
        return None
    header, _, body = message.partition("\n")
    if re.search(r"^BREAKING[ -]CHANGE:", body, re.M) or re.search(r"^BREAKING[ -]CHANGE:", header):
        return "major"
    m = _HEADER.match(header.strip())
    if not m:
        # Sujet libre (non conventionnel) : publiable sauf s'il ressemble à du bruit.
        first = re.split(r"[\s:(]", header.strip().lower(), maxsplit=1)[0]
        return None if first in _NOISE else "patch"
    kind = m.group("type").lower()
    if m.group("bang"):
        return "major"
    if kind == "feat":
        return "minor"
    if kind in _NOISE:
        return None
    return "patch"  # fix, perf, refactor, security, …


def required_bump(commits: list[str]) -> str | None:
    best: str | None = None
    for c in commits:
        level = classify_commit(c)
        if level and (best is None or _BUMP_ORDER[level] > _BUMP_ORDER[best]):
            best = level
    return best


def _bump_core(major: int, minor: int, patch: int, level: str) -> tuple[int, int, int]:
    if level == "major":
        return major + 1, 0, 0
    if level == "minor":
        return major, minor + 1, 0
    return major, minor, patch + 1


def next_version(current: str, commits: list[str], bump: str = "auto", pre: str | None = None,
                 existing_tags: list[str] | None = None) -> str:
    """Version suivante. `current` : version actuelle (X.Y.Z[-pre]). Lève NothingToRelease."""
    major, minor, patch, cur_pre = parse_version(current)
    tags = [t.lstrip("v") for t in (existing_tags or [])]

    if cur_pre and not pre:
        # Promotion d'une préversion en version finale (même cœur).
        return f"{major}.{minor}.{patch}"

    if cur_pre and pre:
        # Même cœur, même étiquette : on incrémente simplement le compteur de préversion.
        label = re.sub(r"\d+$", "", cur_pre)
        if label == pre:
            core = f"{major}.{minor}.{patch}"
            return f"{core}-{pre}{_next_pre_number(core, pre, tags, cur_pre)}"

    level = bump if bump != "auto" else required_bump(commits)
    if level is None:
        raise NothingToRelease("aucun commit publiable (feat/fix/…) depuis la dernière release")
    if level not in _BUMP_ORDER:
        raise ValueError(f"niveau de bump invalide : {level!r}")
    core_t = _bump_core(major, minor, patch, level)
    core = ".".join(map(str, core_t))
    if pre:
        return f"{core}-{pre}{_next_pre_number(core, pre, tags)}"
    return core


def _next_pre_number(core: str, label: str, tags: list[str], current_pre: str = "") -> int:
    pat = re.compile(rf"^{re.escape(core)}-{re.escape(label)}(\d+)$")
    nums = [int(m.group(1)) for t in tags if (m := pat.match(t))]
    cur = re.search(r"(\d+)$", current_pre)
    if cur:
        nums.append(int(cur.group(1)))
    return (max(nums) + 1) if nums else 1


# --------------------------------------------------------------------------- #
# Git (isolé : le reste est pur)
# --------------------------------------------------------------------------- #

def _git(*args: str) -> str:
    return subprocess.run(["git", *args], cwd=_ROOT, capture_output=True, text=True,  # noqa: S603, S607
                          check=True).stdout


def git_tags() -> list[str]:
    return [t for t in _git("tag", "--list", "v*").split() if _VERSION.match(t)]


def last_release_tag(tags: list[str]) -> str | None:
    """Dernier tag STABLE (les préversions ne servent pas de base de comparaison)."""
    stable = [t for t in tags if not parse_version(t)[3]]
    if not stable:
        return None
    return max(stable, key=lambda t: parse_version(t)[:3])


def commits_since(tag: str | None) -> list[str]:
    rng = f"{tag}..HEAD" if tag else "HEAD"
    raw = _git("log", rng, "--format=%B%x00")
    return [c.strip() for c in raw.split("\x00") if c.strip()]


def read_version_file() -> str:
    text = (_ROOT / "src" / "elium" / "__init__.py").read_text(encoding="utf-8")
    m = re.search(r'__version__\s*=\s*"([^"]+)"', text)
    if not m:
        raise SystemExit("__version__ introuvable dans src/elium/__init__.py")
    return m.group(1)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Calcule la prochaine version (commits conventionnels).")
    ap.add_argument("--current", help="version actuelle (défaut : __version__)")
    ap.add_argument("--bump", default="auto", choices=["auto", "patch", "minor", "major"])
    ap.add_argument("--pre", help="étiquette de préversion (rc, beta…) : X.Y.Z-rc1")
    ap.add_argument("--since", help="tag de départ (défaut : dernier tag stable)")
    ap.add_argument("--tags-from-git", action="store_true", help="(par défaut) lit les tags du dépôt")
    args = ap.parse_args(argv)

    try:
        tags = git_tags()
        current = args.current or read_version_file()
        base = args.since or last_release_tag(tags)
        # Dernier tag stable plus récent que __version__ (bump manuel oublié) : on repart de lui.
        if not args.current and base and parse_version(base)[:3] > parse_version(current)[:3]:
            current = base.lstrip("v")
        commits = commits_since(base)
        print(next_version(current, commits, args.bump, args.pre, tags))
    except NothingToRelease as exc:
        print(f"rien à publier : {exc}", file=sys.stderr)
        return 3
    except (ValueError, subprocess.CalledProcessError) as exc:
        print(f"erreur : {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
