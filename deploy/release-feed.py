#!/usr/bin/env python3
"""Complète `release.json` (identité du build, notes) avec la dernière publication GitHub.

Le site hébergé (accueil, carte « version / installer l'application Windows ») lit /release.json en
même origine : la CSP interdit à la page de contacter GitHub. Ce script, lancé sur l'HÔTE (au
déploiement puis par cron), interroge l'API publique de GitHub et réécrit le fichier servi.

    python3 deploy/release-feed.py --base web-dist/release.json --out release/release.json

Sans réseau, la dernière réponse connue est conservée (le fichier de sortie n'est jamais vidé).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
import urllib.request

REPO = "eliumgame/elium-main"
WANTED = ("-Setup.msi", "Elium-User-", "Elium.exe")


def fetch_latest(repo: str, timeout: float = 15.0) -> dict | None:
    req = urllib.request.Request(
        f"https://api.github.com/repos/{repo}/releases/latest",
        headers={"Accept": "application/vnd.github+json", "User-Agent": "elium-release-feed"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310 - URL https fixe
            rel = json.load(r)
    except Exception as e:  # réseau, quota, JSON : on garde l'ancien contenu
        print(f"release-feed: GitHub injoignable ({e})", file=sys.stderr)
        return None
    assets = [
        {"name": a["name"], "url": a["browser_download_url"], "size": a.get("size", 0)}
        for a in rel.get("assets", [])
        if any(w in a["name"] for w in WANTED) and (a["name"].endswith(".msi") or a["name"] == "Elium.exe")
    ]
    return {
        "tag": rel.get("tag_name", ""),
        "publishedAt": rel.get("published_at", ""),
        "url": rel.get("html_url", ""),
        "assets": assets,
    }


def write_out(path: str, text: str) -> None:
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    if os.path.exists(path):
        # Écriture SUR PLACE : le fichier est monté tel quel dans le conteneur web (bind mount d'un seul
        # fichier) ; un remplacement par renommage changerait d'inode et le conteneur garderait l'ancien.
        with open(path, "w", encoding="utf8") as f:
            f.write(text)
        return
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(os.path.abspath(path)), suffix=".tmp")
    with os.fdopen(fd, "w", encoding="utf8") as f:
        f.write(text)
    os.chmod(tmp, 0o644)
    os.replace(tmp, path)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True, help="release.json du build (version, notes)")
    ap.add_argument("--out", required=True, help="fichier servi par le site")
    ap.add_argument("--repo", default=REPO)
    a = ap.parse_args()

    with open(a.base, encoding="utf8") as f:
        info = json.load(f)
    latest = fetch_latest(a.repo)
    if latest is None and os.path.exists(a.out):
        try:
            with open(a.out, encoding="utf8") as f:
                latest = json.load(f).get("latest")
        except Exception:
            latest = None
    if latest and latest.get("assets"):
        info["latest"] = latest

    write_out(a.out, json.dumps(info, ensure_ascii=False, indent=2) + "\n")
    last = (info.get("latest") or {}).get("tag", "-")
    print(f"release-feed: {a.out} (v{info.get('version')}, derniere publiee: {last})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
