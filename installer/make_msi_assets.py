"""
Génère les ressources de l'installeur MSI (WiX) :

  installer/assets/license.rtf     LICENCE au format RTF (exigé par WixUI)
  installer/assets/msi-banner.bmp  bandeau 493x58 (haut des boîtes de dialogue)
  installer/assets/msi-dialog.bmp  fond 493x312 (pages Bienvenue / Fin)

Réutilise le dessin vectoriel de brand/make_icons.py (Pillow pur).
Exécuter avec le Python du venv :  .venv/Scripts/python.exe installer/make_msi_assets.py
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ASSETS = Path(__file__).resolve().parent / "assets"

sys.path.insert(0, str(ROOT / "brand"))
from make_icons import BLUE_BOT, BLUE_TOP, WHITE, _font, _vgrad, draw_icon  # noqa: E402
from PIL import Image, ImageDraw  # noqa: E402


def make_license_rtf() -> Path:
    """Convertit LICENSE (texte) en RTF minimal accepté par WixUI."""
    text = (ROOT / "LICENSE").read_text(encoding="utf-8")
    esc = text.replace("\\", "\\\\").replace("{", "\\{").replace("}", "\\}")
    # RTF est un format ASCII : encode les caractères non-ASCII en \uN?.
    esc = "".join(ch if ord(ch) < 128 else f"\\u{ord(ch)}?" for ch in esc)
    esc = esc.replace("\r\n", "\n").replace("\n", "\\par\n")
    rtf = "{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Segoe UI;}}\\fs18\n" + esc + "\n}\n"
    out = ASSETS / "license.rtf"
    out.write_text(rtf, encoding="ascii")
    return out


def make_banner() -> Path:
    """Bandeau 493x58 : fond blanc, badge Elium à droite (zone réservée WixUI)."""
    img = Image.new("RGB", (493, 58), WHITE)
    icon = draw_icon(44).convert("RGBA")
    img.paste(icon, (493 - 44 - 8, 7), icon)
    out = ASSETS / "msi-banner.bmp"
    img.save(out)
    return out


def make_dialog() -> Path:
    """Fond 493x312 : bande de marque à gauche, zone de texte blanche à droite."""
    img = Image.new("RGB", (493, 312), WHITE)
    band = _vgrad(165, 312, BLUE_TOP, BLUE_BOT).convert("RGB")
    img.paste(band, (0, 0))
    icon = draw_icon(84).convert("RGBA")
    img.paste(icon, (40, 64), icon)
    d = ImageDraw.Draw(img)
    d.text((82, 176), "Elium", font=_font(28), fill=WHITE, anchor="mm")
    d.text((82, 206), "Documents signés", font=_font(12), fill=(0xCF, 0xDD, 0xFB), anchor="mm")
    d.text((82, 224), "Local-first", font=_font(12), fill=(0xCF, 0xDD, 0xFB), anchor="mm")
    out = ASSETS / "msi-dialog.bmp"
    img.save(out)
    return out


def main() -> None:
    ASSETS.mkdir(parents=True, exist_ok=True)
    outs = [make_license_rtf(), make_banner(), make_dialog()]
    print("Generated:", ", ".join(str(p.relative_to(ROOT)) for p in outs))


if __name__ == "__main__":
    main()
