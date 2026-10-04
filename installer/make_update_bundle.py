"""
Construit le paquet de mise à jour HORS LIGNE `Elium-update-X.Y.Z.eliumupdate`.

Un `.eliumupdate` est un zip : le manifeste SIGNÉ de la release (`latest.json` +
`latest.json.sig`, octets inchangés) et les artefacts qu'un poste installé peut avoir
besoin d'appliquer (l'exe complet, l'interface légère, le pack d'assets). Le client le
vérifie EXACTEMENT comme une mise à jour en ligne (signature Ed25519 du manifeste, puis
sha256 de chaque artefact extrait) : on peut donc le transporter par clé USB, l'envoyer
par messagerie, l'héberger n'importe où, sans élargir la confiance.

Usage (CI, après gen_manifest.py) :
    python installer/make_update_bundle.py --manifest dist/latest.json \
        --artifacts-dir dist --artifacts-dir installer/staging --out dist
Les artefacts sont retrouvés par le `name` que le manifeste signé leur donne.
"""
from __future__ import annotations

import argparse
import json
import sys
import zipfile
from pathlib import Path

# Artefacts qu'un client à jour sait consommer en hors-ligne (le MSI et l'archive web
# complète historique n'en font pas partie : inutiles ici, et volumineux).
BUNDLE_KINDS = ("exe", "webCore", "assets")
FALLBACK_WEB_KIND = "web"


def build_bundle(manifest_path: Path, artifact_dirs: list[Path], out_dir: Path) -> Path:
    manifest_path = Path(manifest_path)
    raw = manifest_path.read_bytes()
    sig = manifest_path.with_name(manifest_path.name + ".sig")
    if not sig.is_file():
        raise SystemExit(f"signature introuvable : {sig}")
    manifest = json.loads(raw)
    version = str(manifest["version"])
    arts = manifest.get("artifacts") or {}
    kinds = [k for k in BUNDLE_KINDS if k in arts]
    if "webCore" not in arts and FALLBACK_WEB_KIND in arts:
        kinds.append(FALLBACK_WEB_KIND)
    if not kinds:
        raise SystemExit("le manifeste ne porte aucun artefact embarquable")

    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / f"Elium-update-{version}.eliumupdate"
    with zipfile.ZipFile(out, "w", zipfile.ZIP_STORED) as zf:
        zf.writestr("latest.json", raw)
        zf.writestr("latest.json.sig", sig.read_text(encoding="utf-8"))
        for kind in kinds:
            name = arts[kind]["name"]
            src = next((d / name for d in artifact_dirs if (Path(d) / name).is_file()), None)
            if src is None:
                raise SystemExit(f"artefact {kind} ({name}) introuvable dans {[str(d) for d in artifact_dirs]}")
            zf.write(src, name)
            print(f"  [ok]   {kind}: {name}")
    print(f"  [ok]   {out} ({out.stat().st_size} o)")
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description="Construit Elium-update-X.Y.Z.eliumupdate.")
    parser.add_argument("--manifest", required=True, help="latest.json signé (latest.json.sig à côté)")
    parser.add_argument("--artifacts-dir", action="append", default=[], help="dossier des artefacts (répétable)")
    parser.add_argument("--out", default=".")
    args = parser.parse_args()
    build_bundle(Path(args.manifest), [Path(d) for d in args.artifacts_dir] or [Path(".")], Path(args.out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
