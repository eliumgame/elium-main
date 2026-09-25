"""Génère des PDF 'scannés' réalistes : JPEG (DCT), JPEG2000 (JPX), et un PDF
à pages de tailles/rotations mixtes écrit à la main (xref classique)."""
import io, random, zlib
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageFilter
OUT = Path("corpus")
random.seed(7)
LINES = [
    "RÉPUBLIQUE FRANÇAISE — Attestation de test n° 2026-0042",
    "Le présent document certifie que l'échantillon a été numérisé à 200 dpi.",
    "Élément   Quantité   Prix unitaire   Total",
    "Crayons        12          0,85 €     10,20 €",
    "Cahiers         4          2,40 €      9,60 €",
    "Fait à Paris, le 23 septembre 2026. Signature : ____________",
    "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod.",
    "Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi.",
]
def font(sz):
    for f in ["C:/Windows/Fonts/times.ttf", "C:/Windows/Fonts/arial.ttf"]:
        try: return ImageFont.truetype(f, sz)
        except OSError: pass
    return ImageFont.load_default()
def page(n, w=1654, h=2339, skew=0.6):
    im = Image.new("L", (w, h), 250)
    d = ImageDraw.Draw(im)
    y = 160
    d.text((140, y), f"Page {n}", font=font(48), fill=20); y += 100
    for k in range(34):
        d.text((140, y), LINES[(k + n) % len(LINES)], font=font(34), fill=random.randint(10, 60)); y += 58
    im = im.rotate(skew * (1 if n % 2 else -1), fillcolor=250, resample=Image.BICUBIC)
    # bruit de numérisation
    px = im.load()
    for _ in range(9000):
        x, yy = random.randrange(w), random.randrange(h); px[x, yy] = random.randint(120, 230)
    return im.filter(ImageFilter.GaussianBlur(0.5)).convert("RGB")
pages = [page(i + 1) for i in range(6)]
pages[0].save(OUT / "scan-jpeg.pdf", save_all=True, append_images=pages[1:], resolution=200.0, quality=70)

# --- JPX (JPEG2000) écrit à la main --------------------------------------
def write_pdf(path, pages_objs):
    """pages_objs: liste de (w_pt, h_pt, content_bytes, xobjects:{name:(dict_str, data)}, extra_page_entries)"""
    objs = []  # index 0 -> obj 1
    def add(b): objs.append(b); return len(objs)
    catalog = add(b"")  # placeholder
    pages_id = add(b"")
    kids = []
    for (w, h, content, xobjs, extra) in pages_objs:
        xo_refs = {}
        for name, (dct, data) in xobjs.items():
            xo_refs[name] = add(b"<< " + dct.encode() + b" /Length %d >>\nstream\n" % len(data) + data + b"\nendstream")
        cid = add(b"<< /Length %d >>\nstream\n" % len(content) + content + b"\nendstream")
        xo = " ".join(f"/{k} {v} 0 R" for k, v in xo_refs.items())
        res = f"<< /XObject << {xo} >> /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >> >> >>"
        kids.append(add(f"<< /Type /Page /Parent {pages_id} 0 R /MediaBox [0 0 {w} {h}] /Resources {res} /Contents {cid} 0 R {extra} >>".encode()))
    objs[catalog - 1] = f"<< /Type /Catalog /Pages {pages_id} 0 R >>".encode()
    objs[pages_id - 1] = f"<< /Type /Pages /Count {len(kids)} /Kids [{' '.join(f'{k} 0 R' for k in kids)}] >>".encode()
    out = io.BytesIO(); out.write(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n"); offs = []
    for i, b in enumerate(objs):
        offs.append(out.tell()); out.write(b"%d 0 obj\n" % (i + 1) + b + b"\nendobj\n")
    x = out.tell()
    out.write(b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1))
    for o in offs: out.write(b"%010d 00000 n \n" % o)
    out.write(b"trailer\n<< /Size %d /Root %d 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, catalog, x))
    Path(path).write_bytes(out.getvalue())

jpx_pages = []
for i in range(3):
    im = pages[i].resize((827, 1170))
    buf = io.BytesIO(); im.save(buf, "JPEG2000", quality_mode="rates", quality_layers=[40]); data = buf.getvalue()
    content = b"q 595 0 0 842 0 0 cm /Im0 Do Q"
    jpx_pages.append((595, 842, content, {"Im0": (f"/Type /XObject /Subtype /Image /Width 827 /Height 1170 /Filter /JPXDecode", data)}, ""))
write_pdf(OUT / "scan-jpx.pdf", jpx_pages)

# --- tailles / rotations / CropBox mixtes + texte WinAnsi -------------------
def txt(s): return s.encode("cp1252").replace(b"\\", b"\\\\").replace(b"(", b"\(").replace(b")", b"\)")
mixed = []
specs = [(595, 842, "", "A4 portrait"), (842, 595, "", "A4 paysage"), (612, 792, "/Rotate 90", "Letter /Rotate 90"),
         (595, 842, "/Rotate 180", "A4 /Rotate 180"), (420, 595, "/CropBox [20 30 400 575]", "A5 avec CropBox décalée"),
         (1191, 842, "/Rotate 270", "A3 paysage /Rotate 270"), (595, 842, "/UserUnit 1", "A4 UserUnit")]
for (w, h, extra, label) in specs:
    c = b"BT /F1 28 Tf 60 %d Td (" % (h - 100) + txt(label) + b") Tj ET\n"
    c += b"BT /F1 12 Tf 60 %d Td 16 TL (" % (h - 140) + txt("Texte éditable : « Où êtes-vous ? » — prix 12,50 €") + b") Tj T* (" + txt("Deuxième ligne du paragraphe de test, avec accents : àâäéèêëîïôöùûüç.") + b") Tj ET\n"
    c += b"1 0 0 RG 3 w 40 40 m %d 40 l %d %d l 40 %d l h S\n" % (w - 40, w - 40, h - 40, h - 40)
    mixed.append((w, h, c, {}, extra))
write_pdf(OUT / "mixed-geometry.pdf", mixed)
print("scans ok")
