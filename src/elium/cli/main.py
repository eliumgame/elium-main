import argparse
import getpass
import json
import os
import sys

from elium.core.container import EliumContainer
from elium.core.exceptions import EliumError, EliumFormatError, EliumSecurityError
from elium.crypto.primitives import load_private_key, load_public_key
from elium.format.document import create_document_model, extract_text, text_to_doc
from elium.format.journal import append_event, empty_journal, verify_journal
from elium.format.package import (
    EliumPasswordRequired,
    read_elium,
    write_elium,
)
from elium.format.profiles import PROFILES, VALID_PROFILES
from elium.format.proof import verify_proof

# --- Legacy v3 container -------------------------------------------------

def cmd_create(args: argparse.Namespace) -> None:
    password = args.password or getpass.getpass("Password: ")
    with open(args.input, "rb") as f:
        payload = f.read()

    signing_key = None
    if args.sign:
        with open(args.sign, "rb") as f:
            signing_key = load_private_key(f.read())

    manifest = {"files": [{"name": os.path.basename(args.input), "size": len(payload)}]}
    encoded = EliumContainer.encode(
        payload=payload, password=password, manifest_meta=manifest,
        signing_key=signing_key, cascade=args.cascade,
    )
    with open(args.output, "wb") as f:
        f.write(encoded)
    print(f"Container successfully created: {args.output}")


def cmd_open(args: argparse.Namespace) -> None:
    password = args.password or getpass.getpass("Password: ")
    with open(args.file, "rb") as f:
        blob = f.read()

    verify_key = None
    if args.verify:
        with open(args.verify, "rb") as f:
            verify_key = load_public_key(f.read())

    payload, manifest, header = EliumContainer.decode(blob, password=password, verify_public_key=verify_key)
    print(f"File successfully decrypted! Manifest: {manifest}")
    if header["flags"].get("signed"):
        sig_valid = header.get("signature_valid")
        if sig_valid is True:
            print("Status: VALID SIGNATURE.")
        elif sig_valid is None:
            print("Status: UNVERIFIED SIGNATURE (No public key provided).")

    if args.output:
        os.makedirs(args.output, exist_ok=True)
        out_root = os.path.realpath(args.output)
        files = manifest.get("files", [])
        if len(files) > 1:
            print("Warning: Multi-file payload not supported; extracting first file only.")
        if files:
            raw_name = files[0].get("name", "")
            name = os.path.basename(raw_name)
            if not name or name in (".", "..") or os.path.isabs(raw_name):
                raise EliumFormatError(f"Unsafe filename in manifest: {raw_name!r}")
            out_path = os.path.join(args.output, name)
            if os.path.commonpath([out_root, os.path.realpath(out_path)]) != out_root:
                raise EliumSecurityError(f"Extraction path is outside the target directory: {raw_name!r}")
            with open(out_path, "wb") as f:
                f.write(payload)
        print(f"Extracted to {args.output}")


# --- Documentary .elium (v4) ---------------------------------------------

def cmd_doc_create(args: argparse.Namespace) -> None:
    with open(args.input, encoding="utf-8") as f:
        text = f.read()

    title = args.title or os.path.splitext(os.path.basename(args.input))[0]
    document = create_document_model(text_to_doc(text))

    profile = args.profile
    journal = empty_journal()
    if PROFILES[profile]["tracking"]:
        journal = append_event(journal, "document.created", data={"title": title})

    recipients = args.recipient or None
    password = args.password
    # Recipients (public-key encryption) replace the password path entirely.
    if not recipients and PROFILES[profile]["password_required"] and not password:
        password = getpass.getpass("Mot de passe du document: ")

    seal_key = None
    if args.seal_key:
        with open(args.seal_key, encoding="utf-8") as f:
            seal_key = f.read().strip()

    blob = write_elium(
        document, profile=profile, title=title, journal=journal,
        password=password, recipients=recipients, seal_private_key_hex=seal_key,
    )
    with open(args.output, "wb") as f:
        f.write(blob)
    sealed = "  · scellé" if seal_key else ""
    how = f"  · {len(recipients)} destinataire(s)" if recipients else ""
    print(f"Document .elium créé : {args.output}  (profil : {profile}){sealed}{how}")


def cmd_doc_open(args: argparse.Namespace) -> None:
    with open(args.file, "rb") as f:
        blob = f.read()
    password = args.password
    rkey = getattr(args, "recipient_key", None)
    try:
        result = read_elium(blob, password=password, recipient_private_hex=rkey)
    except EliumPasswordRequired:
        password = getpass.getpass("Mot de passe du document: ")
        result = read_elium(blob, password=password, recipient_private_hex=rkey)

    m = result["manifest"]
    jv = verify_journal(result["journal"])
    print(f"Titre        : {m['title']}")
    print(f"Profil       : {m['profile']} ({PROFILES[m['profile']]['badge']})")
    print(f"Format       : elium v{m['formatVersion']}")
    print(f"Chiffré      : {m['protection']['encrypted']}  ·  Verrouillé : {m['protection']['locked']}")
    integ = result["integrity"]
    intact = "non vérifié" if integ["unchecked"] else ("intact" if integ["contentIntact"] else "ALTÉRÉ")
    print(f"Intégrité    : {intact}")
    print(f"Signatures   : {len(result['signatures'])}")
    print(f"Suivi        : {jv['count']} évènement(s) · {'valide' if jv['valid'] else 'ALTÉRÉ'}")
    seal = result.get("seal", {})
    seal_txt = {"valid": "VALIDE", "broken": "ROMPU (fichier altéré)", "unknown_key": "clé non vérifiée",
                "unsealed": "aucun"}.get(seal.get("verdict"), seal.get("verdict"))
    fp = seal.get("fingerprint")
    print(f"Sceau        : {seal_txt}" + (f"  · empreinte {fp[:16]}…" if fp else ""))

    if args.text:
        print("\n--- Contenu ---")
        print(extract_text(result["document"]["doc"]).strip())


def cmd_doc_verify(args: argparse.Namespace) -> None:
    with open(args.file, "rb") as f:
        blob = f.read()
    password = args.password
    rkey = getattr(args, "recipient_key", None)
    try:
        result = read_elium(blob, password=password, recipient_private_hex=rkey, trusted_key_hex=args.trusted)
    except EliumPasswordRequired:
        password = getpass.getpass("Mot de passe du document: ")
        result = read_elium(blob, password=password, recipient_private_hex=rkey, trusted_key_hex=args.trusted)

    model = result["document"]
    integ = result["integrity"]
    intact = "non vérifiée" if integ["unchecked"] else ("INTACTE" if integ["contentIntact"] else "ALTÉRÉE")
    print("Intégrité du contenu :", intact)

    jv = verify_journal(result["journal"])
    print("Journal de suivi     :", "VALIDE" if jv["valid"] else f"ALTÉRÉ (évènement {jv['brokenAt']})")

    seal = result.get("seal", {})
    seal_txt = {"valid": "VALIDE", "broken": "ROMPU — fichier altéré après scellement",
                "unknown_key": "valide mais clé NON reconnue", "unsealed": "aucun sceau"}.get(
        seal.get("verdict"), seal.get("verdict"))
    fp = seal.get("fingerprint")
    print("Sceau du document    :", seal_txt, (f"(empreinte {fp[:16]}…)" if fp else ""))

    if not result["signatures"]:
        print("Signatures           : aucune")
    for s in result["signatures"]:
        verdict = verify_proof(s, model, trusted_key_hex=args.trusted)
        who = s.get("signer", {}).get("name") or s.get("kind")
        print(f"Signature [{who}]   : {verdict}")

    report = {
        "integrity": integ,
        "journal": jv,
        "seal": seal,
        "signatures": [
            {"id": s["id"], "verdict": verify_proof(s, model, trusted_key_hex=args.trusted)}
            for s in result["signatures"]
        ],
    }
    if args.report:
        with open(args.report, "w", encoding="utf-8") as f:
            json.dump(report, f, ensure_ascii=False, indent=2)
        print(f"Rapport de preuve écrit : {args.report}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="elium", description="Elium — format documentaire & conteneur sécurisé")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("create", help="[legacy] Créer un conteneur chiffré .elium (v3)")
    p.add_argument("--input", required=True)
    p.add_argument("--output", required=True)
    p.add_argument("--password")
    p.add_argument("--sign", help="Clé privée Ed25519 (PEM) pour signer")
    p.add_argument("--cascade", action="store_true")
    p.set_defaults(func=cmd_create)

    p = sub.add_parser("open", help="[legacy] Ouvrir un conteneur v3")
    p.add_argument("file")
    p.add_argument("--password")
    p.add_argument("--output")
    p.add_argument("--verify", help="Clé publique Ed25519 (PEM) pour vérifier")
    p.set_defaults(func=cmd_open)

    p = sub.add_parser("doc-create", help="Créer un document .elium (v4) à partir d'un texte")
    p.add_argument("--input", required=True, help="Fichier texte/markdown source")
    p.add_argument("--output", required=True, help="Fichier .elium de sortie")
    p.add_argument("--title")
    p.add_argument("--profile", default="standard", choices=VALID_PROFILES)
    p.add_argument("--password")
    p.add_argument("--recipient", action="append", metavar="PUBHEX",
                   help="Clé publique P-256 (hex) d'un destinataire ; répétable. "
                        "Chiffre POUR ces destinataires au lieu d'un mot de passe.")
    p.add_argument("--seal-key", dest="seal_key",
                   help="Fichier avec la clé privée Ed25519 (hex) pour sceller le document")
    p.set_defaults(func=cmd_doc_create)

    p = sub.add_parser("doc-open", help="Ouvrir et résumer un document .elium (v4)")
    p.add_argument("file")
    p.add_argument("--password")
    p.add_argument("--recipient-key", dest="recipient_key", metavar="PRIVHEX",
                   help="Clé privée P-256 (hex) de réception, pour un document multi-destinataires")
    p.add_argument("--text", action="store_true", help="Afficher le contenu texte")
    p.set_defaults(func=cmd_doc_open)

    p = sub.add_parser("doc-verify", help="Vérifier intégrité, journal et signatures d'un .elium (v4)")
    p.add_argument("file")
    p.add_argument("--password")
    p.add_argument("--recipient-key", dest="recipient_key", metavar="PRIVHEX",
                   help="Clé privée P-256 (hex) de réception, pour un document multi-destinataires")
    p.add_argument("--trusted", help="Clé publique de confiance (hex) pour l'attribution")
    p.add_argument("--report", help="Écrire un rapport de preuve JSON")
    p.set_defaults(func=cmd_doc_verify)

    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    try:
        args.func(args)
    except EliumError as e:
        print(f"Security/Format Error: {e}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:  # noqa: BLE001
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
