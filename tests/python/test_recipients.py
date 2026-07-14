"""Multi-recipient hybrid encryption (ECDH-ES P-256 + AES-256-GCM)."""
import io
import json
import zipfile

import pytest

from elium.core.exceptions import EliumSecurityError
from elium.crypto.recipients import (
    RECIPIENTS_SCHEMA,
    decrypt_as_recipient,
    encrypt_for_recipients,
    generate_recipient_keypair,
    list_recipient_fingerprints,
    public_from_private,
    recipient_fingerprint,
)
from elium.format.package import (
    EliumRecipientKeyRequired,
    read_elium,
    write_elium,
)

_DOC = {"schema": "elium-doc/1", "doc": {"type": "doc", "content": [{"type": "paragraph"}]}}

MSG = "Document ultra confidentiel — multi-destinataires.".encode()


def test_two_recipients_each_decrypts():
    a_priv, a_pub = generate_recipient_keypair()
    b_priv, b_pub = generate_recipient_keypair()
    blob = encrypt_for_recipients(MSG, [a_pub, b_pub])

    assert decrypt_as_recipient(blob, a_priv) == MSG
    assert decrypt_as_recipient(blob, b_priv) == MSG


def test_non_recipient_cannot_decrypt():
    _a_priv, a_pub = generate_recipient_keypair()
    intruder_priv, _ = generate_recipient_keypair()
    blob = encrypt_for_recipients(MSG, [a_pub])
    with pytest.raises(EliumSecurityError):
        decrypt_as_recipient(blob, intruder_priv)


def test_envelope_shape_and_fingerprints():
    _a_priv, a_pub = generate_recipient_keypair()
    _b_priv, b_pub = generate_recipient_keypair()
    blob = encrypt_for_recipients(MSG, [a_pub, b_pub])
    env = json.loads(blob)
    assert env["schema"] == RECIPIENTS_SCHEMA
    assert len(env["recipients"]) == 2
    # The plaintext must not appear anywhere in the envelope.
    assert b"confidentiel" not in blob
    fprs = list_recipient_fingerprints(blob)
    assert recipient_fingerprint(a_pub) in fprs
    assert recipient_fingerprint(b_pub) in fprs


def test_public_from_private_roundtrip():
    priv, pub = generate_recipient_keypair()
    assert public_from_private(priv) == pub


def test_tampered_content_is_rejected():
    a_priv, a_pub = generate_recipient_keypair()
    env = json.loads(encrypt_for_recipients(MSG, [a_pub]))
    # Flip a hex nibble in the content ciphertext.
    ct = bytearray(bytes.fromhex(env["content"]))
    ct[len(ct) // 2] ^= 0x01
    env["content"] = bytes(ct).hex()
    with pytest.raises(EliumSecurityError):
        decrypt_as_recipient(json.dumps(env).encode(), a_priv)


def test_add_recipient_to_existing_set_needs_reencrypt_only_for_new():
    # Sanity: encrypting the same message twice yields different envelopes (random CEK/eph).
    _p, pub = generate_recipient_keypair()
    b1 = encrypt_for_recipients(MSG, [pub])
    b2 = encrypt_for_recipients(MSG, [pub])
    assert b1 != b2


def test_elium_package_recipients_roundtrip():
    """A .elium written FOR recipients opens with any recipient key, not others."""
    a_priv, a_pub = generate_recipient_keypair()
    b_priv, b_pub = generate_recipient_keypair()
    intruder_priv, _ = generate_recipient_keypair()

    blob = write_elium(_DOC, profile="encrypted", title="Note destinataires", recipients=[a_pub, b_pub])

    # The clear manifest lists ONLY the fingerprints (no password path).
    manifest = json.loads(zipfile.ZipFile(io.BytesIO(blob)).read("manifest.json"))
    assert manifest["protection"]["recipients"] == [recipient_fingerprint(a_pub), recipient_fingerprint(b_pub)]
    assert manifest["protection"]["encrypted"] is True

    # Opening without a recipient key is refused with a typed error.
    with pytest.raises(EliumRecipientKeyRequired):
        read_elium(blob)

    # Each recipient opens it and gets the original document back.
    assert read_elium(blob, recipient_private_hex=a_priv)["document"] == _DOC
    assert read_elium(blob, recipient_private_hex=b_priv)["document"] == _DOC

    # An outsider cannot.
    with pytest.raises(EliumSecurityError):
        read_elium(blob, recipient_private_hex=intruder_priv)


def test_elium_package_recipients_with_metadata_encryption():
    """Recipients + metadata encryption: nothing sensitive leaks in the clear."""
    a_priv, a_pub = generate_recipient_keypair()
    sigs = [{"id": "sig_1", "signer": {"name": "Alice Martin"}}]
    blob = write_elium(
        _DOC, profile="secure_max", title="Titre secret", signatures=sigs,
        recipients=[a_pub], encrypt_metadata=True,
    )
    zf = zipfile.ZipFile(io.BytesIO(blob))
    clear = zf.read("manifest.json").decode() + zf.read("signatures/signatures.json").decode()
    assert "Titre secret" not in clear
    assert "Alice Martin" not in clear

    opened = read_elium(blob, recipient_private_hex=a_priv)
    assert opened["manifest"]["title"] == "Titre secret"
    assert opened["signatures"] == sigs
    assert opened["document"] == _DOC


def test_revoked_recipient_cannot_decrypt_rotated_envelope():
    """Local counterpart of the cloud key-rotation-on-revocation hardening.

    Re-encrypting for a reduced recipient set draws a FRESH CEK
    (recipients.py:87), so a removed recipient can no longer open the new
    envelope even though they could open the old one.
    """
    a_priv, a_pub = generate_recipient_keypair()
    b_priv, b_pub = generate_recipient_keypair()

    before = encrypt_for_recipients(MSG, [a_pub, b_pub])
    assert decrypt_as_recipient(before, a_priv) == MSG
    assert decrypt_as_recipient(before, b_priv) == MSG

    # Rotation: re-encrypt for Alice only (Bob revoked).
    after = encrypt_for_recipients(MSG, [a_pub])
    assert decrypt_as_recipient(after, a_priv) == MSG
    with pytest.raises(EliumSecurityError):
        decrypt_as_recipient(after, b_priv)

    # Fresh CEK ⇒ different content ciphertext; Bob's fingerprint is gone.
    env_before = json.loads(before)
    env_after = json.loads(after)
    assert env_after["content"] != env_before["content"]
    fprs_after = list_recipient_fingerprints(after)
    assert recipient_fingerprint(b_pub) not in fprs_after
    assert recipient_fingerprint(a_pub) in fprs_after
