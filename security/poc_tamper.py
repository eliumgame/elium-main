"""
Adversarial test harness for Elium v4 — authorized security review.
Each test reports it from the ATTACKER's point of view:
  [PWNED]   = attack succeeded (security claim broken)
  [BLOCKED] = attack failed (defense held)
"""
import io
import json
import re
import zipfile
from pathlib import Path

from elium.format.package import write_elium, read_elium, ENTRY_MANIFEST, ENTRY_CONTENT_PLAIN, ENTRY_JOURNAL, ENTRY_SIGNATURES
from elium.format.canonical import sha256_hex, canonical_json
from elium.format.journal import empty_journal, append_event, verify_journal
from elium.format.document import create_document_model, text_to_doc
from elium.format.proof import generate_identity, create_proof, verify_proof
from elium.core.container import EliumContainer
from elium.core.exceptions import EliumError

PWN = "\033[91m[PWNED]\033[0m  "
BLK = "\033[92m[BLOCKED]\033[0m"
INF = "\033[96m[INFO]\033[0m   "

def line(t): print("\n" + "="*78 + "\n" + t + "\n" + "="*78)

def repack(blob: bytes, replace: dict[str, bytes]) -> bytes:
    """Rebuild a .elium zip, replacing/auditing given entries."""
    zin = zipfile.ZipFile(io.BytesIO(blob))
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zo:
        for item in zin.infolist():
            data = replace.get(item.filename, zin.read(item.filename))
            ct = zipfile.ZIP_STORED if item.filename == "mimetype" else zipfile.ZIP_DEFLATED
            zo.writestr(item.filename, data, compress_type=ct)
    return out.getvalue()

# ---------------------------------------------------------------------------
line("ATTACK 1 — Tamper an unencrypted/LOCKED document undetected")
# Build a 'locked' document, SEALED by its author. The seal — an Ed25519 anchor
# over manifest+signatures+journal (§6.3) — is the actual tamper-evidence
# mechanism; the plain per-content contentHash is keyless by design and is
# EXPECTED to be foolable by an attacker who can rewrite the manifest (that is
# exactly why the seal exists — see DOCUMENTATION.md F-1 and test_seal.py).
author1 = generate_identity()
doc = create_document_model(text_to_doc("Je vends ma voiture pour 10000 euros."))
journal = append_event(empty_journal(), "document.created", data={"title": "Contrat"})
blob = write_elium(doc, profile="locked", title="Contrat", journal=journal,
                   seal_private_key_hex=author1["privateKeyHex"])
orig = read_elium(blob)
print(INF, "Original content intact?", orig["integrity"]["contentIntact"], "| seal:", orig["seal"]["verdict"], "| profile locked")

# Attacker: change the price, then RECOMPUTE the manifest hash and rewrite manifest.
zin = zipfile.ZipFile(io.BytesIO(blob))
manifest = json.loads(zin.read(ENTRY_MANIFEST))
forged_doc = create_document_model(text_to_doc("Je vends ma voiture pour 1 euro."))
forged_content = json.dumps(forged_doc, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
manifest["integrity"]["contentHash"] = sha256_hex(forged_content)   # recompute!
forged = repack(blob, {ENTRY_CONTENT_PLAIN: forged_content, ENTRY_MANIFEST: json.dumps(manifest, indent=2, ensure_ascii=False).encode()})

res = read_elium(forged)
from elium.format.document import extract_text
shown = extract_text(res["document"]["doc"]).strip()
intact = res["integrity"]["contentIntact"]
seal_verdict1 = res["seal"]["verdict"]
print(INF, "Tampered content now reads:", repr(shown))
print(INF, "read_elium reports contentIntact =", intact, "(legacy keyless check, expected to be fooled) | seal.verdict =", seal_verdict1)
if intact and "1 euro" in shown and seal_verdict1 != "broken":
    print(PWN, "Document silently altered; integrity still reports INTACT and the seal does not catch it either.")
else:
    print(BLK, "Alteration detected by the seal (seal.verdict == 'broken'), even though the legacy keyless contentHash check alone is fooled as documented.")
assert seal_verdict1 == "broken", "SECURITY REGRESSION: a sealed 'locked' document was hash-recomputed & tampered but seal.verdict != 'broken'"

# ---------------------------------------------------------------------------
line("ATTACK 2 — Rewrite the ENTIRE tracking journal undetected")
author2 = generate_identity()
j = empty_journal()
j = append_event(j, "document.created", data={"title": "Contrat"})
j = append_event(j, "signature.added", actor={"name": "Alice"}, data={"sig": "real"})
blob2 = write_elium(doc, profile="tracked", title="Contrat", journal=j,
                    seal_private_key_hex=author2["privateKeyHex"])
orig2 = read_elium(blob2)
print(INF, "Genuine journal valid?", verify_journal(orig2["journal"]), "| seal:", orig2["seal"]["verdict"])

# Attacker rebuilds a brand-new, fully consistent chain that hides Alice and adds a fake event.
# verify_journal() alone is a keyless self-consistency check: any freshly-built
# chain will always pass it — that's expected, not a bug (see journal.py). The
# seal is what actually binds the journal's content to the sealed document.
fake = empty_journal()
fake = append_event(fake, "document.created", data={"title": "Contrat"})
fake = append_event(fake, "signature.added", actor={"name": "Mallory"}, data={"sig": "forged"})
fake = append_event(fake, "document.locked", data={"final": True})
forged2 = repack(blob2, {ENTRY_JOURNAL: json.dumps(fake, indent=2, ensure_ascii=False).encode()})
res2 = read_elium(forged2)
v = verify_journal(res2["journal"])
seal_verdict2 = res2["seal"]["verdict"]
print(INF, "Forged journal verify_journal ->", v, "| seal.verdict =", seal_verdict2)
if v["valid"] and seal_verdict2 != "broken":
    print(PWN, "Entire history rewritten (Alice erased, Mallory inserted); chain 'VALIDE' and the seal does not catch it.")
else:
    print(BLK, "Rewrite detected by the seal (seal.verdict == 'broken'), even though the keyless chain re-verifies as 'VALIDE' on its own as documented.")
assert seal_verdict2 == "broken", "SECURITY REGRESSION: a fully-rewritten journal was accepted by the seal (seal.verdict != 'broken')"

# ---------------------------------------------------------------------------
line("ATTACK 3 — Forge a 'valid' signature with the attacker's OWN key")
signer = {"name": "Directeur Financier", "role": "CFO", "org": "ACME"}
victim_id = generate_identity()
real_proof = create_proof("sig-1", doc, signer, victim_id["privateKeyHex"])
real_sig = {"id": "sig-1", "kind": "drawn", "signer": signer, "proof": real_proof}
print(INF, "Genuine signature verdict (trusted key supplied):", verify_proof(real_sig, doc, trusted_key_hex=victim_id["publicKeyHex"]))

# Attacker modifies the doc AND re-signs with a brand-new identity, keeping the victim's displayed name.
attacker_id = generate_identity()
tampered_doc = create_document_model(text_to_doc("Je vends ma voiture pour 1 euro."))
forged_proof = create_proof("sig-1", tampered_doc, signer, attacker_id["privateKeyHex"])
forged_sig = {"id": "sig-1", "kind": "drawn", "signer": signer, "proof": forged_proof}
verdict_no_trust = verify_proof(forged_sig, tampered_doc)
verdict_trust = verify_proof(forged_sig, tampered_doc, trusted_key_hex=victim_id["publicKeyHex"])
print(INF, "Forged sig verdict, NO trusted key supplied :", verdict_no_trust,
      "(expected 'valid' by design — an ad-hoc signature always verifies mathematically absent a trust anchor; UX must show 'clé non vérifiée')")
print(INF, "Forged sig verdict, victim's key supplied   :", verdict_trust)
if verdict_trust == "valid":
    print(PWN, "Attacker's forged signature shows 'valide' even when checked against the VICTIM's own trusted key.")
else:
    print(BLK, f"Forgery rejected once checked against the victim's trusted key (verdict={verdict_trust}).")
assert verdict_trust != "valid", "SECURITY REGRESSION: a forged signature (attacker's own key) verifies as 'valid' against the victim's trusted key"

# ---------------------------------------------------------------------------
line("ATTACK 4 — Strip a signature from a signed document undetected")
author4 = generate_identity()
blob4 = write_elium(doc, profile="signed", title="Contrat", signatures=[real_sig],
                    journal=append_event(empty_journal(), "signature.added", actor={"name": "Alice"}),
                    seal_private_key_hex=author4["privateKeyHex"])
orig4 = read_elium(blob4)
print(INF, "Original signature count:", len(orig4["signatures"]), "| seal:", orig4["seal"]["verdict"])
stripped = repack(blob4, {ENTRY_SIGNATURES: json.dumps([], indent=2, ensure_ascii=False).encode()})
# also fix manifest features.signatures if we wanted to be thorough; reader doesn't cross-check it
res4 = read_elium(stripped)
seal_verdict4 = res4["seal"]["verdict"]
print(INF, "After stripping -> signatures:", len(res4["signatures"]), "| integrity intact:", res4["integrity"]["contentIntact"], "| seal.verdict =", seal_verdict4)
if len(res4["signatures"]) == 0 and seal_verdict4 != "broken":
    print(PWN, "Signature removed with no seal complaint.")
else:
    print(BLK, "Signature removal detected by the seal (seal.verdict == 'broken').")
assert seal_verdict4 == "broken", "SECURITY REGRESSION: a stripped signature goes undetected by the seal (seal.verdict != 'broken')"

# ---------------------------------------------------------------------------
line("ATTACK 5 — Metadata & PII leak from an ENCRYPTED file (no password)")
enc_blob = write_elium(doc, profile="secure_max", title="Salaires confidentiels 2026",
                       signatures=[real_sig],
                       journal=append_event(empty_journal(), "signature.added", actor={"name": "Jean Dupont", "role": "DRH"}),
                       password="correct horse battery staple")
z = zipfile.ZipFile(io.BytesIO(enc_blob))
man = json.loads(z.read(ENTRY_MANIFEST))
sigs = json.loads(z.read(ENTRY_SIGNATURES))
jour = json.loads(z.read(ENTRY_JOURNAL))
print(INF, "Encrypted? manifest says:", man["protection"]["encrypted"])
print(INF, "Leaked WITHOUT password -> title :", man["title"])
print(INF, "Leaked WITHOUT password -> signer:", [s["signer"] for s in sigs])
print(INF, "Leaked WITHOUT password -> journal actors:", [e.get("actor") for e in jour["events"]])
if man["title"] and any(s["signer"].get("name") for s in sigs):
    print(PWN, "Default encrypted file: title + signers + actors readable without the password.")

# F-7 mitigation: encrypt_metadata=True moves the sensitive fields inside the
# encrypted body and redacts the clear entries.
sec_blob = write_elium(doc, profile="secure_max", title="Salaires confidentiels 2026",
                       signatures=[real_sig],
                       journal=append_event(empty_journal(), "signature.added", actor={"name": "Jean Dupont", "role": "DRH"}),
                       password="correct horse battery staple", encrypt_metadata=True)
zs = zipfile.ZipFile(io.BytesIO(sec_blob))
clear = zs.read(ENTRY_MANIFEST).decode() + zs.read(ENTRY_SIGNATURES).decode() + zs.read(ENTRY_JOURNAL).decode()
leaks = [s for s in ("Salaires confidentiels 2026", "Jean Dupont", "DRH") if s in clear]
if leaks:
    print(PWN, "metadataEncrypted still leaks:", leaks)
else:
    print(BLK, "metadataEncrypted=True: title/signers/actors absent from the clear entries (no leak).")
assert not leaks, f"SECURITY REGRESSION: metadataEncrypted=True still leaks {leaks} in clear entries"

# ---------------------------------------------------------------------------
line("ATTACK 6 — Does the ENCRYPTION itself hold? (positive control)")
try:
    read_elium(enc_blob, password="wrong password")
    print(PWN, "Decrypted with WRONG password!")
    assert False, "SECURITY REGRESSION: wrong password decrypted the file"
except EliumError as e:
    print(BLK, "Wrong password rejected:", type(e).__name__)
# tamper one ciphertext byte
zin = zipfile.ZipFile(io.BytesIO(enc_blob))
ct = bytearray(zin.read("content/document.elium"))
ct[len(ct)//2] ^= 0x01
try:
    bad = repack(enc_blob, {"content/document.elium": bytes(ct)})
    read_elium(bad, password="correct horse battery staple")
    print(PWN, "Tampered ciphertext decrypted without error!")
    assert False, "SECURITY REGRESSION: tampered ciphertext decrypted without error (AEAD/HMAC not enforced)"
except EliumError as e:
    print(BLK, "Ciphertext tamper rejected (AEAD/HMAC):", type(e).__name__)

# ---------------------------------------------------------------------------
line("ATTACK 7 — KDF bound divergence Python vs Web (DoS surface)")
# Historically the web reader accepted m<=1048576 KiB (1 GiB) / t<=10 while
# Python capped m<=262144 (256 MiB) / t<=6: a 1 GiB Argon2 file opened in the
# browser (memory-DoS) but Python refused it. This now VERIFIES the live bounds
# in BOTH sources instead of asserting a stale claim.
ROOT = Path(__file__).resolve().parent.parent

def extract_bound(path: Path, pattern: str) -> dict | None:
    src = path.read_text(encoding="utf-8")
    mo = re.search(pattern, src)
    if not mo:
        return None
    return {k: int(v) for k, v in mo.groupdict().items()}

# Python: `1 <= t <= 6 and 8192 <= m <= 262144 and 1 <= p <= 16`
py = extract_bound(
    ROOT / "src/elium/core/container.py",
    r"1\s*<=\s*t\s*<=\s*(?P<tmax>\d+)\s*and\s*8192\s*<=\s*m\s*<=\s*(?P<mmax>\d+)",
)
# TS: `t >= 1 && t <= 6 && m >= 8192 && m <= 262144 && p >= 1 && p <= 16`
ts = extract_bound(
    ROOT / "web-studio/src/crypto/elium-crypto.ts",
    r"t\s*<=\s*(?P<tmax>\d+)\s*&&\s*m\s*>=\s*8192\s*&&\s*m\s*<=\s*(?P<mmax>\d+)",
)
print(INF, "Python bound (container.py)   :", py)
print(INF, "Web bound   (elium-crypto.ts) :", ts)
if py is None or ts is None:
    print(PWN, "Could not locate a KDF bound check — verify both readers still enforce one.")
elif py == ts:
    print(BLK, f"Bounds identical (t<={py['tmax']}, m<={py['mmax']} KiB): no interop gap, no DoS asymmetry.")
else:
    print(PWN, f"Bound divergence Python {py} vs Web {ts}: interop break + memory-DoS asymmetry.")
assert py is not None and ts is not None and py == ts, f"SECURITY REGRESSION: KDF bounds missing or diverged (python={py}, web={ts})"

print("\nDone.\n")
