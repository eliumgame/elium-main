import base64
import json
import sys

from elium.core.container import EliumContainer
from elium.format.document import create_document_model, extract_text, text_to_doc
from elium.format.package import read_elium, write_elium


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


if __name__ == "__main__":
    main()
