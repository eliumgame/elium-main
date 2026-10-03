"""kid d'enveloppe multi-destinataires + clés retirées (rotation)."""
import json

import pytest

from elium.core.exceptions import EliumSecurityError
from elium.crypto.recipients import (
    decrypt_with_any_key,
    encrypt_for_recipients,
    generate_recipient_keypair,
    list_recipient_kids,
    recipient_fingerprint,
    recipient_kid,
)


def test_envelope_carries_kid_and_retired_key_still_decrypts():
    old_priv, old_pub = generate_recipient_keypair()
    new_priv, _new_pub = generate_recipient_keypair()
    blob = encrypt_for_recipients(b"avant rotation", [old_pub])
    env = json.loads(blob)
    fpr = recipient_fingerprint(old_pub)
    assert env["recipients"][0]["kid"] == recipient_kid(fpr) == fpr[:16]
    assert list_recipient_kids(blob) == [fpr[:16]]
    assert decrypt_with_any_key(blob, [new_priv, old_priv]) == b"avant rotation"
    with pytest.raises(EliumSecurityError):
        decrypt_with_any_key(blob, [new_priv])


def test_legacy_envelope_without_kid_still_listed():
    _priv, pub = generate_recipient_keypair()
    env = json.loads(encrypt_for_recipients(b"x", [pub]))
    del env["recipients"][0]["kid"]
    assert list_recipient_kids(json.dumps(env).encode()) == [recipient_fingerprint(pub)[:16]]
