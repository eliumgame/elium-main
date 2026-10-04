"""
Découpe `web-studio/dist` en archives pour la mise à jour web.

Pourquoi : l'application embarque ~8,6 Mo de polices, les ressources de pdf.js et le
moteur OCR (Tesseract) — du contenu LOURD qui ne change presque jamais d'une version à
l'autre. Avant, chaque mise à jour web retéléchargeait tout. Désormais :

  web-core.zip         le reste de l'interface (index.html, bundles JS/CSS hachés, sw.js...) — petit
  assets-<hash>.zip    le pack d'assets lourds (fonts/, pdfjs/, tesseract/, tessdata/), nommé par son
                       empreinte d'arborescence : le client ne le retélécharge que si cette empreinte change
  web.zip              l'archive COMPLÈTE historique, conservée pour les clients plus anciens (qui ne
                       connaissent ni web-core ni le pack d'assets) — jamais téléchargée par les clients récents

Les zips sont DÉTERMINISTES (entrées triées, horodatage fixe) : même contenu => mêmes octets
=> même sha256 d'une release à l'autre, ce qui permet aussi au CDN/cache de les réutiliser.

Usage :
    python installer/split_web.py --dist web-studio/dist --out dist-zips
Écrit les trois zips et un `split.json` ({web, webCore, assets, treeHash, assetsTreeHash}).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import zipfile
from pathlib import Path

import updater

# Même définition que web-studio/scripts/gen-precache.mjs (isHeavy) : un seul sens de « lourd ».
HEAVY_PREFIXES = ("fonts/", "pdfjs/", "tesseract/", "tessdata/")

_FIXED_DATE = (1980, 1, 1, 0, 0, 0)


def is_heavy(rel: str) -> bool:
    return rel.startswith(HEAVY_PREFIXES)


def _list_files(dist: Path) -> list[tuple[str, Path]]:
    out = []
    for p in sorted(dist.rglob("*")):
        if p.is_file() and not p.name.endswith(".map"):
            out.append((p.relative_to(dist).as_posix(), p))
    return out


def _write_zip(path: Path, entries: list[tuple[str, Path]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for rel, src in entries:
            info = zipfile.ZipInfo(rel, date_time=_FIXED_DATE)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            zf.writestr(info, src.read_bytes())


def _tree(entries: list[tuple[str, Path]]) -> str:
    return updater._tree_digest(  # noqa: SLF001 — définition d'empreinte partagée avec le client
        (rel, hashlib.sha256(p.read_bytes()).hexdigest()) for rel, p in entries
    )


def split_dist(dist: Path, out_dir: Path) -> dict[str, object]:
    """Écrit web.zip, web-core.zip et assets-<hash>.zip ; renvoie leurs chemins et empreintes."""
    dist = Path(dist)
    if not (dist / "index.html").is_file():
        raise SystemExit(f"{dist} ne contient pas index.html (build du Web Studio manquant ?)")
    files = _list_files(dist)
    core = [(r, p) for r, p in files if not is_heavy(r)]
    heavy = [(r, p) for r, p in files if is_heavy(r)]
    if not heavy:
        raise SystemExit("aucun asset lourd (fonts/pdfjs/tesseract) trouvé : découpe sans objet")
    assets_tree = _tree(heavy)
    full_tree = _tree(files)

    out_dir = Path(out_dir)
    web = out_dir / "web.zip"
    web_core = out_dir / "web-core.zip"
    assets = out_dir / f"assets-{assets_tree[:16]}.zip"
    _write_zip(web, files)
    _write_zip(web_core, core)
    _write_zip(assets, heavy)
    info = {
        "web": str(web), "webCore": str(web_core), "assets": str(assets),
        "treeHash": full_tree, "assetsTreeHash": assets_tree,
        "sizes": {"web": web.stat().st_size, "webCore": web_core.stat().st_size, "assets": assets.stat().st_size},
    }
    (out_dir / "split.json").write_text(json.dumps(info, indent=2), encoding="utf-8")
    return info


def main() -> int:
    parser = argparse.ArgumentParser(description="Découpe web-studio/dist en web-core.zip + assets-<hash>.zip.")
    parser.add_argument("--dist", default="web-studio/dist")
    parser.add_argument("--out", default=".")
    args = parser.parse_args()
    info = split_dist(Path(args.dist), Path(args.out))
    sizes = info["sizes"]
    print(f"  [ok]   web.zip {sizes['web']} o (complet, clients anciens) · web-core.zip {sizes['webCore']} o · "  # type: ignore[index]
          f"{Path(str(info['assets'])).name} {sizes['assets']} o")  # type: ignore[index]
    return 0


if __name__ == "__main__":
    sys.exit(main())
