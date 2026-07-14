"""
Generate Elium raster brand assets from the vector design.

Outputs (run from anywhere):
  brand/elium.ico              multi-resolution Windows icon (16..256)
  brand/elium-512.png          app/store icon
  brand/favicon-32.png         web favicon raster fallback
  installer/assets/wizard-large.bmp  (164x314) Inno Setup WizardImageFile
  installer/assets/wizard-small.bmp  (55x58)   Inno Setup WizardSmallImageFile

Pure Pillow (no native SVG deps). Re-run after changing the design.
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
BRAND = ROOT / "brand"
ASSETS = ROOT / "installer" / "assets"

BLUE_TOP = (0x3B, 0x82, 0xF6)
BLUE_BOT = (0x1D, 0x4E, 0xD8)
GREEN = (0x16, 0xA3, 0x4A)
WHITE = (255, 255, 255)


def _vgrad(w: int, h: int, top: tuple, bot: tuple) -> Image.Image:
    g = Image.new("RGB", (1, h))
    for y in range(h):
        t = y / max(1, h - 1)
        g.putpixel((0, y), tuple(int(top[i] + (bot[i] - top[i]) * t) for i in range(3)))
    return g.resize((w, h))


def draw_icon(size: int = 1024) -> Image.Image:
    """Draw the badge icon (matches brand/elium-logo.svg) at `size` px."""
    k = size / 256
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # Rounded badge with vertical gradient.
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([16 * k, 16 * k, 240 * k, 240 * k], radius=52 * k, fill=255)
    badge = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    badge.paste(_vgrad(size, size, BLUE_TOP, BLUE_BOT).convert("RGBA"), (0, 0), mask)
    img = Image.alpha_composite(img, badge)
    d = ImageDraw.Draw(img)

    sc = lambda pts: [(x * k, y * k) for x, y in pts]  # noqa: E731

    # Document body + folded corner.
    d.polygon(sc([(86, 62), (148, 62), (182, 96), (182, 196), (86, 196)]), fill=WHITE)
    d.polygon(sc([(148, 62), (182, 96), (148, 96)]), fill=(0xDB, 0xE7, 0xFF))

    # Text lines.
    def line(x, y, w, h, color):
        d.rounded_rectangle([x * k, y * k, (x + w) * k, (y + h) * k], radius=(h / 2) * k, fill=color)

    line(98, 112, 84, 10, (0x93, 0xB4, 0xF5))
    line(98, 134, 84, 10, (0xBC, 0xD0, 0xF7))
    line(98, 156, 54, 10, (0xBC, 0xD0, 0xF7))

    # Seal / signature check.
    cx, cy, r = 170, 170, 30
    d.ellipse([(cx - r) * k, (cy - r) * k, (cx + r) * k, (cy + r) * k],
              fill=GREEN, outline=WHITE, width=max(1, int(6 * k)))
    d.line(sc([(157, 170), (166, 180), (183, 160)]), fill=WHITE, width=max(1, int(7 * k)), joint="curve")
    cr = 3.5 * k  # round the check endpoints
    for px, py in sc([(157, 170), (183, 160)]):
        d.ellipse([px - cr, py - cr, px + cr, py + cr], fill=WHITE)
    return img


def _font(size: int):
    for name in ("segoeuib.ttf", "arialbd.ttf", "DejaVuSans-Bold.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def main() -> None:
    BRAND.mkdir(exist_ok=True)
    ASSETS.mkdir(parents=True, exist_ok=True)

    master = draw_icon(1024)
    sizes = [16, 32, 48, 64, 128, 256]
    master.resize((256, 256), Image.LANCZOS).save(BRAND / "elium.ico", sizes=[(s, s) for s in sizes])
    master.resize((512, 512), Image.LANCZOS).save(BRAND / "elium-512.png")
    master.resize((32, 32), Image.LANCZOS).save(BRAND / "favicon-32.png")

    # Inno Setup small image (55x58) — badge on white.
    small = Image.new("RGB", (55, 58), WHITE)
    icon_small = draw_icon(52).convert("RGBA")
    small.paste(icon_small, (2, 3), icon_small)
    small.save(ASSETS / "wizard-small.bmp")

    # Inno Setup large image (164x314) — blue panel, badge + wordmark.
    large = _vgrad(164, 314, BLUE_TOP, BLUE_BOT).convert("RGB")
    icon_big = draw_icon(96).convert("RGBA")
    large.paste(icon_big, (34, 70), icon_big)
    ld = ImageDraw.Draw(large)
    ld.text((82, 182), "Elium", font=_font(30), fill=WHITE, anchor="mm")
    ld.text((82, 214), "Documents signés", font=_font(13), fill=(0xCF, 0xDD, 0xFB), anchor="mm")
    ld.text((82, 232), "Local-first", font=_font(13), fill=(0xCF, 0xDD, 0xFB), anchor="mm")
    large.save(ASSETS / "wizard-large.bmp")

    print("Generated:", ", ".join(str(p.relative_to(ROOT)) for p in [
        BRAND / "elium.ico", BRAND / "elium-512.png", BRAND / "favicon-32.png",
        ASSETS / "wizard-small.bmp", ASSETS / "wizard-large.bmp",
    ]))


if __name__ == "__main__":
    main()
