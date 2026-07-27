"""
Construction de l'historique des nouveautés porté par le manifeste de mise à jour.

Le manifeste signé transporte, en plus de la version, un **historique par
version** : la carte de mise à jour peut ainsi montrer tout ce qui a changé
depuis la version *de l'utilisateur*, et pas seulement depuis la précédente.
C'est la différence qui compte quand on saute trois versions d'un coup.

Tout est ici en fonctions pures sur des chaînes : le CI fournit la sortie de
`git`, ce module la met en forme, et rien n'a besoin d'un dépôt pour être testé.
"""

from __future__ import annotations

import re
import sys
from collections.abc import Iterable
from pathlib import Path
from typing import Any

# Préfixes de messages de commit qui ne parlent pas du produit : ils encombrent
# une liste de nouveautés sans rien apprendre à l'utilisateur.
NOISE = re.compile(
    r"^(?:merge\b|revert\b|wip\b|fixup!|squash!|bump\b|chore\b|ci\b|docs?\b|"
    r"typo\b|lint\b|format\b|tests?\b|release\b|v?\d+\.\d+\.\d+\s*$)",
    re.IGNORECASE,
)

# `Co-Authored-By:`, `Signed-off-by:` et compagnie : des métadonnées de commit.
TRAILER = re.compile(r"^[A-Za-z-]+:\s", re.MULTILINE)

# Commit conventionnel : `type(portée)!: sujet`.
CONVENTIONAL = re.compile(
    r"^(?P<type>feat|fix|perf|refactor|style|revert|build|chore|ci|docs?|test|deps)"
    r"(?:\((?P<scope>[^)]*)\))?!?:\s*(?P<rest>.+)$",
    re.IGNORECASE,
)

# Un préfixe conventionnel sans sujet derrière : rien à annoncer.
PREFIX_ONLY = re.compile(
    r"^(?:feat|fix|perf|refactor|style|revert|build|chore|ci|docs?|test|deps)"
    r"(?:\([^)]*\))?!?:\s*$",
    re.IGNORECASE,
)

# Types et portées de plomberie : vrais pour le dépôt, sans intérêt pour qui
# installe la mise à jour. `fix(ci)` compte comme plomberie malgré le type `fix`.
PLUMBING = {"chore", "ci", "build", "docs", "doc", "test", "style", "deps", "lint", "release"}

# Portées techniques rendues dans la langue du produit.
SCOPE_LABELS = {
    "documents": "Documents", "docs-app": "Documents",
    "sheets": "Tableur", "tableur": "Tableur",
    "slides": "Présentations", "presentations": "Présentations",
    "pdf": "PDF", "drive": "Drive", "server": "Serveur", "serveur": "Serveur",
    "ui": "Interface", "editor": "Éditeur", "crypto": "Chiffrement",
    "signature": "Signature", "format": "Format .elium", "updater": "Mises à jour",
    "installer": "Installation", "security": "Sécurité", "a11y": "Accessibilité",
}


def humanize_subject(subject: str) -> str:
    """
    Sujet de commit rendu lisible pour un utilisateur.

    « feat(documents): styles nommés » devient « Documents : styles nommés ».
    Renvoie une chaîne vide pour la plomberie (`chore`, `ci`, `fix(ci)`…), qui
    n'a rien à faire dans une liste de nouveautés.
    """
    s = (subject or "").strip()
    if not s:
        return ""
    m = CONVENTIONAL.match(s)
    if not m:
        # Un préfixe conventionnel sans sujet ("feat(documents):") n'apporte rien
        # et ne doit pas ressortir tel quel dans la liste.
        if PREFIX_ONLY.match(s):
            return ""
        return s[:1].upper() + s[1:]
    kind = (m.group("type") or "").lower()
    scope = (m.group("scope") or "").strip().lower()
    if kind in PLUMBING or scope in PLUMBING:
        return ""
    rest = (m.group("rest") or "").strip()
    if not rest:
        return ""
    # Après « Portée : », l'usage français veut une minuscule ; sans portée, la
    # ligne commence la phrase et prend donc la capitale.
    label = SCOPE_LABELS.get(scope) or (scope[:1].upper() + scope[1:] if scope else "")
    return f"{label} : {rest}" if label else rest[:1].upper() + rest[1:]


def version_tuple(v: str) -> tuple:
    """
    Version en clé comparable `(majeur, mineur, correctif, finale)`.

    Source **unique** de la comparaison de versions du chemin de mise à jour :
    `updater.py` s'y délègue. Deux implémentations divergentes ici signifieraient
    que la carte et le téléchargeur ne s'accordent pas sur ce qui est « plus
    récent ». Le dernier élément vaut 1 pour une version finale et 0 pour une
    préversion, si bien que `4.1.33-rc1` reste *antérieure* à `4.1.33` — la
    longueur du tuple ne doit jamais varier, sans quoi `(4,1,33,0)` passerait
    pour plus grand que `(4,1,33)`.
    """
    v = (v or "").strip()
    if v.lower().startswith("v"):
        v = v[1:]
    core, _, pre = v.partition("-")
    parts = []
    for chunk in core.split("."):
        digits = "".join(ch for ch in chunk if ch.isdigit())
        parts.append(int(digits) if digits else 0)
    while len(parts) < 3:
        parts.append(0)
    return (parts[0], parts[1], parts[2], 0 if pre else 1)


def is_newer(candidate: str, reference: str) -> bool:
    """Vrai si `candidate` est strictement postérieure à `reference`."""
    return version_tuple(candidate) > version_tuple(reference)


def clean_subject(message: str) -> str:
    """
    Première ligne utile d'un message de commit.

    Les messages d'Elium sont des phrases françaises (« Documents : légendes
    auto-numérotées… ») : elles constituent déjà la liste de nouveautés, à
    condition de couper le corps et les trailers.
    """
    first = (message or "").strip().split("\n", 1)[0].strip()
    # Un sujet qui n'est qu'un trailer n'apporte rien.
    if TRAILER.match(first):
        return ""
    return first


def is_noise(subject: str) -> bool:
    """Vrai pour les commits de plomberie, à taire dans une liste de nouveautés."""
    s = (subject or "").strip()
    if not s:
        return True
    return bool(NOISE.match(s))


def parse_log(raw: str, sep: str = "\x1e") -> list[str]:
    """
    Sujets retenus dans la sortie d'un `git log` séparé par `sep`.

    L'appelant utilise `--format=%s%x1e` : un séparateur qui ne peut pas
    apparaître dans un message, contrairement au retour à la ligne.
    """
    seen: set[str] = set()
    out: list[str] = []
    for chunk in (raw or "").split(sep):
        subject = clean_subject(chunk)
        if is_noise(subject):
            continue
        subject = humanize_subject(subject)
        if not subject:  # plomberie écartée par humanize_subject
            continue
        key = subject.lower()
        if key in seen:  # deux commits au même sujet ne se listent qu'une fois
            continue
        seen.add(key)
        out.append(subject)
    return out


def build_entry(version: str, date: str, changes: Iterable[str]) -> dict[str, Any]:
    """Une entrée d'historique normalisée."""
    return {
        "version": (version or "").lstrip("vV"),
        "date": (date or "")[:10],
        "changes": [c for c in (s.strip() for s in changes) if c],
    }


def merge_history(
    entries: Iterable[dict[str, Any]],
    previous: Iterable[dict[str, Any]] = (),
    keep: int = 20,
) -> list[dict[str, Any]]:
    """
    Historique fusionné, de la version la plus récente à la plus ancienne.

    `previous` est l'historique du manifeste déjà publié : le CI n'a pas à
    reconstruire tout le passé à chaque release, il ajoute la nouvelle entrée
    par-dessus. Une version présente des deux côtés est reprise de `entries`,
    qui est la source fraîche.
    """
    by_version: dict[str, dict[str, Any]] = {}
    for entry in list(previous) + list(entries):  # `entries` écrase `previous`
        version = (entry.get("version") or "").lstrip("vV")
        if not version:
            continue
        by_version[version] = build_entry(version, entry.get("date", ""), entry.get("changes") or [])
    ordered = sorted(by_version.values(), key=lambda e: version_tuple(e["version"]), reverse=True)
    return ordered[: max(0, keep)]


def changes_since(
    history: Iterable[dict[str, Any]],
    local_version: str,
    limit: int | None = None,
) -> list[dict[str, Any]]:
    """
    Entrées d'historique strictement postérieures à `local_version`.

    C'est ce que la carte affiche : l'ensemble des nouveautés que l'utilisateur
    n'a pas encore, dans l'ordre décroissant. Sans version locale exploitable on
    rend tout l'historique — mieux vaut trop d'information que rien.
    """
    out = []
    for entry in history or []:
        version = (entry.get("version") or "").lstrip("vV")
        if not version:
            continue
        if not local_version or is_newer(version, local_version):
            out.append(build_entry(version, entry.get("date", ""), entry.get("changes") or []))
    out.sort(key=lambda e: version_tuple(e["version"]), reverse=True)
    return out if limit is None else out[: max(0, limit)]


def flatten_changes(entries: Iterable[dict[str, Any]], limit: int | None = None) -> list[str]:
    """Nouveautés de plusieurs versions en une seule liste, sans doublon."""
    seen: set[str] = set()
    out: list[str] = []
    for entry in entries or []:
        for change in entry.get("changes") or []:
            text = (change or "").strip()
            key = text.lower()
            if not text or key in seen:
                continue
            seen.add(key)
            out.append(text)
            if limit is not None and len(out) >= limit:
                return out
    return out


def summarize(entries: Iterable[dict[str, Any]]) -> str:
    """
    Résumé d'une ligne, pour le sous-titre de la carte.

    « 3 versions, 12 nouveautés » situe l'ampleur avant même de déplier.
    """
    entries = list(entries or [])
    if not entries:
        return ""
    versions = len(entries)
    count = len(flatten_changes(entries))
    if not count:
        return ""
    v_part = "1 version" if versions == 1 else f"{versions} versions"
    c_part = "1 nouveauté" if count == 1 else f"{count} nouveautés"
    return f"{v_part}, {c_part}"


# ---------------------------------------------------------------------------
# CLI : dérive l'historique depuis git et l'imprime en JSON.
#   python installer/changelog.py --version 4.1.33 --since v4.1.32 \
#       [--prev-manifest latest.json] > changelog.json
# Les fonctions ci-dessus restent pures ; seule cette enveloppe touche git et
# le disque, pour rester testable sans dépôt.
# ---------------------------------------------------------------------------

def git_subjects(since: str = "", until: str = "HEAD", cwd: str | None = None) -> list[str]:
    """Sujets de commit de `since`..`until`, ou tout l'historique si `since` est vide."""
    import subprocess

    rev = f"{since}..{until}" if since else until
    try:
        raw = subprocess.run(  # noqa: S603 — argv fixe, sans shell, sans entrée utilisateur
            ["git", "log", rev, "--no-merges", "--format=%s%x1e"],  # noqa: S607 — `git` vient du PATH
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            check=True, cwd=cwd,
        ).stdout
    except (OSError, subprocess.CalledProcessError):
        return []
    return parse_log(raw)


def previous_tag(current_tag: str = "", cwd: str | None = None) -> str:
    """Tag `v*` publié juste avant `current_tag` (vide si c'est la première release)."""
    import subprocess

    try:
        raw = subprocess.run(  # noqa: S603 — argv fixe, sans shell, sans entrée utilisateur
            ["git", "tag", "--list", "v*", "--sort=-version:refname"],  # noqa: S607 — `git` vient du PATH
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            check=True, cwd=cwd,
        ).stdout
    except (OSError, subprocess.CalledProcessError):
        return ""
    tags = [t.strip() for t in raw.splitlines() if t.strip()]
    wanted = (current_tag or "").strip()
    for tag in tags:
        if wanted and tag == wanted:
            continue
        # Le premier tag strictement antérieur : les tags sont déjà triés.
        if not wanted or not is_newer(tag, wanted):
            return tag
    return ""


def _main(argv: list[str] | None = None) -> int:
    import argparse
    import json
    from datetime import date

    parser = argparse.ArgumentParser(description="Dérive l'historique des nouveautés depuis git.")
    parser.add_argument("--version", required=True)
    parser.add_argument("--since", default="", help="Tag de départ ; déduit du dépôt si absent.")
    parser.add_argument("--date", default="", help="Date de publication (AAAA-MM-JJ) ; aujourd'hui par défaut.")
    parser.add_argument("--prev-manifest", default="", help="latest.json déjà publié, pour empiler l'historique.")
    parser.add_argument("--keep", type=int, default=20)
    parser.add_argument("--out", default="", help="Fichier de sortie ; stdout par défaut.")
    args = parser.parse_args(argv)

    version = args.version.lstrip("vV")
    since = args.since or previous_tag(f"v{version}")
    changes = git_subjects(since)
    entry = build_entry(version, args.date or date.today().isoformat(), changes)

    previous: list[dict[str, Any]] = []
    if args.prev_manifest:
        try:
            prev = json.loads(Path(args.prev_manifest).read_text(encoding="utf-8"))
            previous = prev.get("history") or []
            # Un manifeste antérieur au champ `history` porte tout de même sa
            # propre version : on la conserve pour ne pas perdre le passé.
            if not previous and prev.get("version"):
                previous = [build_entry(prev["version"], prev.get("pubDate", ""), prev.get("changes") or [])]
        except (OSError, ValueError):
            print("  [warn] manifeste précédent illisible : historique reparti de zéro", file=sys.stderr)

    payload = {
        "changes": entry["changes"],
        "history": merge_history([entry], previous, keep=args.keep),
    }
    text = json.dumps(payload, indent=2, ensure_ascii=False)
    if args.out:
        Path(args.out).write_text(text + "\n", encoding="utf-8")
        print(f"  [ok]   {args.out} : {len(entry['changes'])} nouveauté(s) pour {version}, "
              f"{len(payload['history'])} version(s) d'historique")
    else:
        print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(_main())
