"""
Génère et SIGNE le manifeste de mise à jour `latest.json` (+ `latest.json.sig`).

Lancé par le CI après le build, sur les artefacts produits. Le manifeste liste la version,
le codeHash (pour décider web-only vs exe complet côté client) et, pour chaque artefact,
son URL de release GitHub, sa taille et son sha256. La signature Ed25519 couvre les octets
exacts de `latest.json` : comme les sha256 des artefacts y figurent, vérifier la signature
du manifeste + le sha256 de chaque artefact suffit à garantir leur authenticité.

Clé privée (hex brut Ed25519, 64 hex) : --key <hex>, --key-file <path>, ou env UPDATE_SIGNING_KEY.

Exemple (CI) :
    python installer/gen_manifest.py --version 4.1.0 \
        --exe installer/staging/Elium.exe \
        --web dist/web.zip \
        --msi installer/output/Elium-4.1.0-Setup.msi \
        --out dist/ --notes "Nouveautés..."
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

from build_common import compute_code_hash, repo_root
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

DEFAULT_REPO = "eliumgame/elium-main"


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def _artifact(path: Path, repo: str, tag: str) -> dict:
    return {
        "name": path.name,
        "url": f"https://github.com/{repo}/releases/download/{tag}/{path.name}",
        "size": path.stat().st_size,
        "sha256": _sha256(path),
    }


def _load_private_key(args) -> Ed25519PrivateKey:
    key_hex = args.key or (
        Path(args.key_file).read_text(encoding="utf-8").strip() if args.key_file else None
    ) or os.environ.get("UPDATE_SIGNING_KEY")
    if not key_hex:
        raise SystemExit("Clé privée manquante (--key / --key-file / env UPDATE_SIGNING_KEY).")
    return Ed25519PrivateKey.from_private_bytes(bytes.fromhex(key_hex.strip()))


def main() -> int:
    parser = argparse.ArgumentParser(description="Génère et signe latest.json.")
    parser.add_argument("--version", required=True)
    parser.add_argument("--repo", default=DEFAULT_REPO)
    parser.add_argument("--exe")
    parser.add_argument("--web")
    parser.add_argument("--msi")
    parser.add_argument("--out", default=".")
    parser.add_argument("--notes", default="")
    parser.add_argument("--key")
    parser.add_argument("--key-file")
    args = parser.parse_args()

    version = args.version.lstrip("vV")
    tag = f"v{version}"
    priv = _load_private_key(args)

    artifacts: dict[str, dict] = {}
    for kind, value in (("exe", args.exe), ("web", args.web), ("msi", args.msi)):
        if not value:
            continue
        p = Path(value)
        if not p.is_file():
            print(f"  [warn] artefact {kind} introuvable : {p}")
            continue
        artifacts[kind] = _artifact(p, args.repo, tag)
        print(f"  [ok]   {kind}: {p.name} ({artifacts[kind]['size']} o)")

    if not artifacts:
        raise SystemExit("Aucun artefact valide fourni.")

    manifest = {
        "version": version,
        "pubDate": datetime.now(timezone.utc).isoformat(),
        "codeHash": compute_code_hash(repo_root()),
        "notes": args.notes,
        "artifacts": artifacts,
    }

    raw = json.dumps(manifest, indent=2, ensure_ascii=False).encode("utf-8")
    signature = priv.sign(raw).hex()

    # Sanity-check : la signature se vérifie bien avec la clé publique dérivée.
    priv.public_key().verify(bytes.fromhex(signature), raw)

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "latest.json").write_bytes(raw)
    (out / "latest.json.sig").write_text(signature + "\n", encoding="utf-8")
    print(f"  [ok]   {out / 'latest.json'} + .sig (codeHash {manifest['codeHash'][:12]}…)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
