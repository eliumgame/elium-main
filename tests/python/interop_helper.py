import base64
import json
import sys
import uuid

from elium.core.container import EliumContainer
from elium.format.document import (
    create_document_model,
    create_journal,
    extract_text,
    record_signature_added,
    text_to_doc,
)
from elium.format.journal import verify_journal
from elium.format.package import read_elium, write_elium
from elium.format.proof import create_proof, verify_proof


def _opt(value: str) -> str | None:
    return None if value in ("-", "") else value


def main():
    cmd = sys.argv[1]

    if cmd == "encode":
        payload = sys.stdin.buffer.read()
        password = sys.argv[2]
        cascade = sys.argv[3] == "true"
        encoded = EliumContainer.encode(
            payload=payload,
            password=password,
            manifest_meta={"files": [{"name": "interop.txt"}]},
            cascade=cascade,
        )
        sys.stdout.buffer.write(encoded)

    elif cmd == "decode":
        blob = sys.stdin.buffer.read()
        password = sys.argv[2]
        dec_payload, manifest, header = EliumContainer.decode(blob, password)
        res = {
            "payload_b64": base64.b64encode(dec_payload).decode("ascii"),
            "manifest": manifest,
            "header": header,
        }
        print(json.dumps(res))

    elif cmd == "doc-encode":
        # argv[2] = profile, argv[3] = password ("-" for none)
        text = sys.stdin.buffer.read().decode("utf-8")
        profile = sys.argv[2]
        password = _opt(sys.argv[3]) if len(sys.argv) > 3 else None
        model = create_document_model(text_to_doc(text))
        blob = write_elium(model, profile=profile, title="interop", password=password)
        sys.stdout.buffer.write(blob)

    elif cmd == "doc-decode":
        # argv[2] = password ("-" for none)
        blob = sys.stdin.buffer.read()
        password = _opt(sys.argv[2]) if len(sys.argv) > 2 else None
        result = read_elium(blob, password=password)
        out = {
            "manifest": {"title": result["manifest"]["title"], "profile": result["manifest"]["profile"]},
            "text": extract_text(result["document"]["doc"]).strip(),
            "integrity": result["integrity"],
        }
        print(json.dumps(out, ensure_ascii=False))

    elif cmd == "doc-encode-recipients":
        # argv[2] = profile, argv[3..] = recipient public keys (hex)
        text = sys.stdin.buffer.read().decode("utf-8")
        profile = sys.argv[2]
        recipients = sys.argv[3:]
        model = create_document_model(text_to_doc(text))
        blob = write_elium(model, profile=profile, title="interop-recip", recipients=recipients)
        sys.stdout.buffer.write(blob)

    elif cmd == "doc-decode-recipient":
        # argv[2] = recipient private key (hex)
        blob = sys.stdin.buffer.read()
        result = read_elium(blob, recipient_private_hex=sys.argv[2])
        out = {
            "manifest": {"title": result["manifest"]["title"], "profile": result["manifest"]["profile"]},
            "text": extract_text(result["document"]["doc"]).strip(),
            "recipients": result["manifest"]["protection"].get("recipients", []),
        }
        print(json.dumps(out, ensure_ascii=False))

    elif cmd == "doc-encode-sealed":
        # argv[2] = profile, argv[3] = seal private key (hex). Journal via create_journal.
        text = sys.stdin.buffer.read().decode("utf-8")
        profile = sys.argv[2]
        seal_priv = sys.argv[3]
        model = create_document_model(text_to_doc(text))
        journal = create_journal(profile, "interop-seal")
        blob = write_elium(
            model, profile=profile, title="interop-seal", journal=journal, seal_private_key_hex=seal_priv
        )
        sys.stdout.buffer.write(blob)

    elif cmd == "doc-encode-signed":
        # argv[2]=profile, argv[3]=signer priv (hex), argv[4]=name, argv[5]=seal priv ("-" for none)
        text = sys.stdin.buffer.read().decode("utf-8")
        profile, signer_priv, name = sys.argv[2], sys.argv[3], sys.argv[4]
        seal_priv = _opt(sys.argv[5]) if len(sys.argv) > 5 else None
        model = create_document_model(text_to_doc(text))
        journal = create_journal(profile, "interop-sign")
        signer = {"name": name}
        sig_id = "sig-" + uuid.uuid4().hex[:12]
        proof = create_proof(sig_id, model, signer, signer_priv)
        signature = {
            "id": sig_id, "kind": "typed", "signer": signer, "proof": proof,
            "level": "advanced", "createdAt": proof["signedAt"],
        }
        record_signature_added(journal, profile, signature)
        blob = write_elium(
            model, profile=profile, title="interop-sign", signatures=[signature],
            journal=journal, seal_private_key_hex=seal_priv,
        )
        sys.stdout.buffer.write(blob)

    elif cmd == "doc-encode-secure":
        # argv[2] = password. secure_max profile with metadata encryption (title/journal redacted in clear).
        text = sys.stdin.buffer.read().decode("utf-8")
        password = sys.argv[2]
        model = create_document_model(text_to_doc(text))
        journal = create_journal("secure_max", "titre-secret")
        blob = write_elium(
            model, profile="secure_max", title="titre-secret", journal=journal,
            password=password, encrypt_metadata=True,
        )
        sys.stdout.buffer.write(blob)

    elif cmd == "doc-decode-verify":
        # argv[2]=password("-"), argv[3]=trusted pub ("-"), argv[4]=recipient key ("-").
        # Universal verifier: reports seal verdict, journal, signature verdicts.
        blob = sys.stdin.buffer.read()
        password = _opt(sys.argv[2]) if len(sys.argv) > 2 else None
        trusted = _opt(sys.argv[3]) if len(sys.argv) > 3 else None
        rkey = _opt(sys.argv[4]) if len(sys.argv) > 4 else None
        result = read_elium(blob, password=password, trusted_key_hex=trusted, recipient_private_hex=rkey)
        jv = verify_journal(result["journal"])
        out = {
            "title": result["manifest"]["title"],
            "text": extract_text(result["document"]["doc"]).strip(),
            "seal": (result.get("seal") or {}).get("verdict"),
            "journalValid": jv["valid"],
            "journalTypes": [e["type"] for e in result["journal"]["events"]],
            "signatures": [
                {"id": s["id"], "verdict": verify_proof(s, result["document"], trusted_key_hex=trusted)}
                for s in result["signatures"]
            ],
        }
        print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
