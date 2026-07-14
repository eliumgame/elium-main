"""
`.elium` package reader/writer (Python). ZIP/OPC layout identical to
elium-package.ts; encrypted profiles wrap the body in a v3 container.
"""

from __future__ import annotations

import io
import json
import uuid
import zipfile
from typing import Any

from elium.core.container import EliumContainer
from elium.core.exceptions import EliumError
from elium.crypto.recipients import (
    decrypt_as_recipient,
    encrypt_for_recipients,
    recipient_fingerprint,
)
from elium.format.canonical import now_iso, sha256_hex
from elium.format.journal import empty_journal
from elium.format.profiles import PROFILES, VALID_PROFILES
from elium.format.seal import create_seal, verify_seal

ELIUM_FORMAT = "elium"
ELIUM_FORMAT_VERSION = 4
ELIUM_MIMETYPE = "application/x-elium"

ENTRY_MIMETYPE = "mimetype"
ENTRY_MANIFEST = "manifest.json"
ENTRY_CONTENT_PLAIN = "content/document.json"
ENTRY_CONTENT_ENC = "content/document.elium"
ENTRY_SIGNATURES = "signatures/signatures.json"
ENTRY_JOURNAL = "tracking/journal.json"
ENTRY_RESINDEX = "resources/index.json"
ENTRY_RGPD = "meta/rgpd.json"

# When metadata encryption is on, the sensitive fields (title, signatures,
# journal) ride INSIDE the encrypted content payload under this envelope, while
# the clear-text ZIP entries are redacted. Mirror of elium-package.ts.
SECURE_SCHEMA = "elium-secure/1"
REDACTED_TITLE = "Document chiffré"

_RGPD_NOTICE = (
    "Données traitées localement. Voir PRIVACY_RGPD.md. "
    "Aucune donnée n'est envoyée en ligne sans action explicite."
)


# Part of the unified EliumError hierarchy so callers can catch one base class.
class EliumPackageError(EliumError):
    pass


# Hard caps to bound memory when opening an attacker-supplied archive.
MAX_ENTRY_BYTES = 128 * 1024 * 1024   # 128 MiB per uncompressed entry
MAX_TOTAL_BYTES = 384 * 1024 * 1024   # 384 MiB total uncompressed
MAX_JSON_DEPTH = 200                  # reject pathologically nested JSON


class EliumPasswordRequired(EliumPackageError):
    def __init__(self) -> None:
        super().__init__("Ce document est chiffré : un mot de passe est requis.")


class EliumRecipientKeyRequired(EliumPackageError):
    """Raised when a multi-recipient file is opened without a recipient key."""

    def __init__(self) -> None:
        super().__init__(
            "Ce document est chiffré pour des destinataires : votre clé de réception est requise."
        )


def _collect_personal_data(signatures: list[dict]) -> list[str]:
    found: set[str] = set()
    for s in signatures:
        signer = s.get("signer") or {}
        if signer.get("name"):
            found.add("nom du signataire")
        if signer.get("role"):
            found.add("rôle du signataire")
        if signer.get("org"):
            found.add("organisation")
        if s.get("proof"):
            found.add("empreinte de clé publique")
    return sorted(found)


def _build_manifest(
    profile: str,
    title: str,
    language: str,
    created_at: str,
    content_hash: str,
    content_entry: str,
    signatures: list[dict],
    journal: dict,
    keyfile_required: bool,
    resources_count: int,
    metadata_encrypted: bool = False,
    recipient_fprs: list[str] | None = None,
    doc_id: str | None = None,
) -> dict[str, Any]:
    p = PROFILES[profile]
    protection = {
        "encrypted": p["encrypted"],
        "locked": p["locked"],
        "keyfileRequired": keyfile_required,
        "contentEntry": content_entry,
    }
    if metadata_encrypted:
        protection["metadataEncrypted"] = True
    if recipient_fprs:
        # Only the fingerprints are stored in the clear; the wrapped keys live in
        # the recipients envelope inside the encrypted content entry.
        protection["recipients"] = recipient_fprs
    return {
        "format": ELIUM_FORMAT,
        "formatVersion": ELIUM_FORMAT_VERSION,
        "profile": profile,
        "generator": "elium-py/4.0.0",
        # Stable unique document id (mirror of elium-package.ts). Local index key;
        # NOT part of the signed seal subset.
        "docId": doc_id or str(uuid.uuid4()),
        "createdAt": created_at,
        "modifiedAt": now_iso(),
        "title": title,
        "language": language,
        "protection": protection,
        "integrity": {"algorithm": "sha-256", "contentHash": content_hash},
        "features": {
            "signatures": len(signatures) > 0,
            "tracking": p["tracking"] or len(journal.get("events", [])) > 0,
            "resources": resources_count,
        },
        "rgpd": {
            "localOnly": True,
            "storedPersonalData": _collect_personal_data(signatures),
            "notice": _RGPD_NOTICE,
        },
    }


def write_elium(
    document: dict,
    *,
    profile: str = "standard",
    title: str = "document",
    language: str = "fr",
    signatures: list[dict] | None = None,
    journal: dict | None = None,
    resource_index: list[dict] | None = None,
    resources: dict[str, bytes] | None = None,
    created_at: str | None = None,
    doc_id: str | None = None,
    password: str | None = None,
    keyfile: bytes | None = None,
    recipients: list[str] | None = None,
    seal_private_key_hex: str | None = None,
    encrypt_metadata: bool = False,
) -> bytes:
    if profile not in VALID_PROFILES:
        raise EliumPackageError(f"Profil inconnu : {profile}")

    signatures = signatures or []
    journal = journal or empty_journal()
    resource_index = resource_index or []
    resources = resources or {}
    created_at = created_at or now_iso()

    document_json = json.dumps(document, separators=(",", ":"), ensure_ascii=False).encode("utf-8")

    # Metadata encryption only applies to encrypted profiles.
    secure_meta = bool(encrypt_metadata) and PROFILES[profile]["encrypted"]
    # Multi-recipient (P-256 ECDH-ES) replaces the password container as the body
    # cipher on encrypted profiles. Mirror of elium-package.ts.
    use_recipients = bool(recipients) and PROFILES[profile]["encrypted"]
    recipient_fprs: list[str] | None = None

    if PROFILES[profile]["encrypted"]:
        if secure_meta:
            # The sensitive metadata travels inside the encrypted payload.
            envelope = {
                "schema": SECURE_SCHEMA,
                "document": document,
                "title": title,
                "signatures": signatures,
                "journal": journal,
            }
            payload = json.dumps(envelope, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        else:
            payload = document_json
        if use_recipients:
            content_bytes = encrypt_for_recipients(payload, recipients)  # type: ignore[arg-type]
            recipient_fprs = [recipient_fingerprint(p) for p in recipients]  # type: ignore[union-attr]
        else:
            if not password:
                raise EliumPasswordRequired()
            content_bytes = EliumContainer.encode(
                payload=payload,
                password=password,
                manifest_meta={"files": [{"name": "content.json"}]},
                keyfile=keyfile,
                cascade=(profile == "secure_max"),
            )
        content_entry = ENTRY_CONTENT_ENC
    else:
        content_bytes = document_json
        content_entry = ENTRY_CONTENT_PLAIN

    content_hash = sha256_hex(content_bytes)

    # Clear (on-disk) metadata is redacted when metadata encryption is on, so a
    # file opened without the password leaks nothing sensitive. The real values
    # live (AEAD-protected) inside the encrypted envelope and are bound by the
    # content hash, which the seal covers.
    clear_title = REDACTED_TITLE if secure_meta else title
    clear_signatures = [] if secure_meta else signatures
    clear_journal = empty_journal() if secure_meta else journal

    manifest = _build_manifest(
        profile, clear_title, language, created_at, content_hash, content_entry,
        clear_signatures, clear_journal, keyfile is not None, len(resource_index),
        metadata_encrypted=secure_meta,
        recipient_fprs=recipient_fprs,
        doc_id=doc_id,
    )

    # Optional cryptographic seal: one Ed25519 anchor over the integrity-critical
    # parts (manifest subset + signatures + journal). Makes silent tampering of
    # any of those parts detectable. See seal.py. With metadata encryption the
    # seal signs the redacted clear entries; the encrypted metadata is bound via
    # integrity.contentHash and protected by the AEAD container.
    if seal_private_key_hex:
        manifest["seal"] = create_seal(manifest, clear_signatures, clear_journal, seal_private_key_hex)

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(ENTRY_MIMETYPE, ELIUM_MIMETYPE, compress_type=zipfile.ZIP_STORED)
        zf.writestr(ENTRY_MANIFEST, json.dumps(manifest, indent=2, ensure_ascii=False))
        zf.writestr(content_entry, content_bytes)
        zf.writestr(ENTRY_SIGNATURES, json.dumps(clear_signatures, indent=2, ensure_ascii=False))
        zf.writestr(ENTRY_JOURNAL, json.dumps(clear_journal, indent=2, ensure_ascii=False))
        zf.writestr(ENTRY_RESINDEX, json.dumps(resource_index, indent=2, ensure_ascii=False))
        zf.writestr(ENTRY_RGPD, json.dumps(manifest["rgpd"], indent=2, ensure_ascii=False))
        for res in resource_index:
            data = resources.get(res["id"])
            if data is not None:
                zf.writestr(f"resources/{res['id']}", data)

    return buf.getvalue()


def _check_archive_limits(zf: zipfile.ZipFile) -> None:
    """Refuse archives whose declared uncompressed size could exhaust memory."""
    total = 0
    for info in zf.infolist():
        if info.file_size > MAX_ENTRY_BYTES:
            raise EliumPackageError("Entrée trop volumineuse dans le fichier .elium (protection DoS).")
        total += info.file_size
    if total > MAX_TOTAL_BYTES:
        raise EliumPackageError("Archive .elium trop volumineuse (protection DoS).")


def _json_depth_ok(data: bytes, limit: int = MAX_JSON_DEPTH) -> bool:
    """Cheap nesting-depth guard (ignores brackets inside strings)."""
    depth = 0
    in_str = False
    escape = False
    for b in data:
        if in_str:
            if escape:
                escape = False
            elif b == 0x5C:  # backslash
                escape = True
            elif b == 0x22:  # "
                in_str = False
            continue
        if b == 0x22:
            in_str = True
        elif b in (0x7B, 0x5B):  # { [
            depth += 1
            if depth > limit:
                return False
        elif b in (0x7D, 0x5D):  # } ]
            depth -= 1
    return True


def _safe_json_loads(data: bytes, what: str) -> Any:
    """Parse JSON, converting structural/recursion failures into typed errors."""
    if not _json_depth_ok(data):
        raise EliumPackageError(f"Structure JSON trop imbriquée ({what}).")
    try:
        return json.loads(data)
    except (json.JSONDecodeError, UnicodeDecodeError, RecursionError) as e:
        raise EliumPackageError(f"JSON invalide ({what}).") from e


def read_elium(
    blob: bytes,
    *,
    password: str | None = None,
    keyfile: bytes | None = None,
    recipient_private_hex: str | None = None,
    trusted_key_hex: str | None = None,
) -> dict[str, Any]:
    try:
        zf = zipfile.ZipFile(io.BytesIO(blob))
    except zipfile.BadZipFile as e:
        raise EliumPackageError("Fichier .elium illisible (archive corrompue).") from e

    # Cheap first pass on the (attacker-declared) central-directory sizes.
    _check_archive_limits(zf)

    # Real defense: never trust the declared `file_size`. Read each entry through
    # a hard byte cap, so a lying header (tiny declared size, huge inflate) cannot
    # exhaust memory. zipfile stops decompressing once `cap + 1` bytes are out.
    total_read = 0

    def _read_capped(name: str) -> bytes:
        nonlocal total_read
        with zf.open(name) as fh:
            data = fh.read(MAX_ENTRY_BYTES + 1)
            if len(data) > MAX_ENTRY_BYTES:
                raise EliumPackageError("Entrée trop volumineuse dans le fichier .elium (protection DoS).")
        total_read += len(data)
        if total_read > MAX_TOTAL_BYTES:
            raise EliumPackageError("Archive .elium trop volumineuse (protection DoS).")
        return data

    try:
        manifest_raw = _read_capped(ENTRY_MANIFEST)
    except KeyError as e:
        raise EliumPackageError("Manifeste manquant : fichier .elium invalide.") from e
    manifest = _safe_json_loads(manifest_raw, "manifeste")

    if manifest.get("format") != ELIUM_FORMAT:
        raise EliumPackageError("Ce fichier n'est pas un document Elium.")
    if manifest.get("formatVersion", 0) > ELIUM_FORMAT_VERSION:
        raise EliumPackageError(
            f"Version de format {manifest['formatVersion']} non prise en charge."
        )

    content_entry = manifest["protection"]["contentEntry"]
    try:
        content_bytes = _read_capped(content_entry)
    except KeyError as e:
        raise EliumPackageError("Contenu du document manquant.") from e

    recorded = manifest.get("integrity", {}).get("contentHash")
    if recorded:
        integrity = {"contentIntact": sha256_hex(content_bytes) == recorded, "unchecked": False}
    else:
        integrity = {"contentIntact": True, "unchecked": True}

    secure_meta = bool(manifest.get("protection", {}).get("metadataEncrypted"))
    use_recipients = bool(manifest.get("protection", {}).get("recipients"))
    env_title = env_sigs = env_journal = None

    if manifest["protection"]["encrypted"]:
        if use_recipients:
            if not recipient_private_hex:
                raise EliumRecipientKeyRequired()
            payload = decrypt_as_recipient(content_bytes, recipient_private_hex)
        else:
            if not password:
                raise EliumPasswordRequired()
            payload, _manifest, _header = EliumContainer.decode(content_bytes, password, keyfile=keyfile)
        if secure_meta:
            envelope = _safe_json_loads(payload, "contenu")
            if not isinstance(envelope, dict) or envelope.get("schema") != SECURE_SCHEMA:
                raise EliumPackageError("Enveloppe de métadonnées chiffrées invalide.")
            document = envelope.get("document")
            env_title = envelope.get("title")
            env_sigs = envelope.get("signatures") or []
            env_journal = envelope.get("journal") or empty_journal()
        else:
            document = _safe_json_loads(payload, "contenu")
    else:
        document = _safe_json_loads(content_bytes, "contenu")

    def _read_json(name: str, default: Any) -> Any:
        try:
            raw = _read_capped(name)
        except KeyError:
            return default
        return _safe_json_loads(raw, name)

    signatures = _read_json(ENTRY_SIGNATURES, [])
    journal = _read_json(ENTRY_JOURNAL, empty_journal())
    # The seal is verified over the clear (redacted, when secure) entries.
    seal_verdict = verify_seal(manifest, signatures, journal, trusted_key_hex=trusted_key_hex)

    # With metadata encryption, surface the REAL decrypted metadata to callers.
    if secure_meta and env_sigs is not None:
        signatures = env_sigs
        journal = env_journal
        if env_title is not None:
            manifest = {**manifest, "title": env_title}

    return {
        "manifest": manifest,
        "document": document,
        "signatures": signatures,
        "journal": journal,
        "resourceIndex": _read_json(ENTRY_RESINDEX, []),
        "integrity": integrity,
        "seal": {"verdict": seal_verdict, "fingerprint": (manifest.get("seal") or {}).get("fingerprint")},
    }
