"""Elium v4 — adversarial harness, batch 2."""
import io, json, sys, zipfile
from elium.format.package import write_elium, read_elium, ENTRY_MANIFEST
from elium.format.canonical import sha256_hex
from elium.format.document import create_document_model, text_to_doc
from elium.core.exceptions import EliumError

# Run cleanly on a legacy Windows console (cp1252) that can't encode "→" etc.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

PWN="\033[91m[PWNED]\033[0m  "; BLK="\033[92m[BLOCKED]\033[0m"; INF="\033[96m[INFO]\033[0m   "
def line(t): print("\n"+"="*78+"\n"+t+"\n"+"="*78)
def repack(blob, replace):
    zin=zipfile.ZipFile(io.BytesIO(blob)); out=io.BytesIO()
    with zipfile.ZipFile(out,"w",zipfile.ZIP_DEFLATED) as zo:
        for it in zin.infolist():
            data=replace.get(it.filename, zin.read(it.filename))
            ct=zipfile.ZIP_STORED if it.filename=="mimetype" else zipfile.ZIP_DEFLATED
            zo.writestr(it.filename,data,compress_type=ct)
    return out.getvalue()

# ---------------------------------------------------------------------------
line("ATTACK 8 — Trust-badge spoofing: promote a plain doc to 'Sécurité max'")
doc=create_document_model(text_to_doc("Document banal, aucune protection."))
blob=write_elium(doc, profile="standard", title="Note")
man=json.loads(zipfile.ZipFile(io.BytesIO(blob)).read(ENTRY_MANIFEST))
print(INF,"Real profile:",man["profile"],"| badge would show:","Non protégé")
# Attacker rewrites the (unauthenticated) manifest to claim secure_max + locked + signed.
man["profile"]="secure_max"
man["protection"]["locked"]=True
man["features"]["signatures"]=True
spoof=repack(blob,{ENTRY_MANIFEST:json.dumps(man,indent=2,ensure_ascii=False).encode()})
res=read_elium(spoof)
m2=res["manifest"]
print(INF,"Spoofed manifest now advertises profile:",m2["profile"],"| locked:",m2["protection"]["locked"],"| integrity intact:",res["integrity"]["contentIntact"])
if m2["profile"]=="secure_max" and res["integrity"]["contentIntact"]:
    print(PWN,"A plaintext doc now presents as 'Document ultra sécurisé / Verrouillé' with intact integrity.")

# ---------------------------------------------------------------------------
line("ATTACK 9 — Outer-ZIP decompression DoS (memory exhaustion)")
# Historically the reader inflated each entry with zipfile.read() and no cap.
# Now read_elium reads every entry through a hard byte cap (MAX_ENTRY_BYTES /
# MAX_TOTAL_BYTES), bounding memory by the ACTUAL decompressed bytes — so even a
# lying header (tiny declared size, huge inflate) cannot exhaust memory.
from elium.format import package
print(INF, "Enforced caps: per-entry=%d MiB, total=%d MiB"
      % (package.MAX_ENTRY_BYTES // 1048576, package.MAX_TOTAL_BYTES // 1048576))
# Demonstrate the guard without allocating gigabytes: shrink the cap so the
# normal content entry already exceeds it, and confirm the reader refuses it.
saved_cap = package.MAX_ENTRY_BYTES
package.MAX_ENTRY_BYTES = 8
try:
    read_elium(blob)
    print(PWN, "Oversized entry accepted — no memory cap enforced at read.")
except EliumError:
    print(BLK, "Oversized entry rejected at read (capped, declared-size not trusted).")
finally:
    package.MAX_ENTRY_BYTES = saved_cap

# ---------------------------------------------------------------------------
line("ATTACK 10 — Malformed-input robustness (graceful vs crash)")
cases={
 "empty":b"",
 "garbage":b"\x00\x01\x02not a zip",
 "zip-no-manifest":(lambda:(lambda o:(zipfile.ZipFile(o,"w").writestr("x","y"),o.getvalue())[1])(io.BytesIO()))(),
 "manifest-not-json":repack(blob,{ENTRY_MANIFEST:b"{bad json"}),
 "huge-formatVersion":repack(blob,{ENTRY_MANIFEST:json.dumps({**json.loads(zipfile.ZipFile(io.BytesIO(blob)).read(ENTRY_MANIFEST)),"formatVersion":999}).encode()}),
}
for name,data in cases.items():
    try:
        read_elium(data); print(INF,f"{name:18}-> opened (no error)")
    except EliumError as e:
        print(BLK,f"{name:18}-> clean EliumError: {type(e).__name__}")
    except Exception as e:
        print(PWN,f"{name:18}-> UNHANDLED {type(e).__name__}: {e}")

# ---------------------------------------------------------------------------
line("ATTACK 11 — Deeply-nested document → JSON/recursion DoS")
depth=20000
nested='{"type":"doc","content":['+'{"type":"blockquote","content":['*depth+'{"type":"paragraph"}'+']}'*depth+']}'
docjson=('{"schema":"elium-doc/1","page":{},"doc":'+nested+'}').encode()
man=json.loads(zipfile.ZipFile(io.BytesIO(blob)).read(ENTRY_MANIFEST)); man["integrity"]["contentHash"]=sha256_hex(docjson)
nblob=repack(blob,{"content/document.json":docjson, ENTRY_MANIFEST:json.dumps(man,ensure_ascii=False).encode()})
try:
    res=read_elium(nblob)
    from elium.format.document import extract_text
    try:
        extract_text(res["document"]["doc"]); print(INF,"parsed + extract_text survived depth=%d"%depth)
    except RecursionError:
        print(PWN,"extract_text() RecursionError on nested document (unhandled crash path).")
except RecursionError:
    print(PWN,"json.loads RecursionError on deeply-nested document (unhandled).")
except EliumError as e:
    print(BLK,"rejected:",type(e).__name__)

print("\nDone.\n")
