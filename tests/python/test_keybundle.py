""".eliumkey v2 (trousseau) + certificat de succession — côté Python."""
import copy
import hashlib
import json

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from elium.crypto.keybundle import (
    KeyBundleError,
    build_key_bundle,
    bundle_filename,
    create_succession,
    open_key_bundle,
    parse_key_bundle,
    verify_succession,
)
from elium.crypto.recipients import generate_recipient_keypair, recipient_fingerprint


def _ed():
    priv = Ed25519PrivateKey.generate()
    seed = priv.private_bytes(
        serialization.Encoding.Raw, serialization.PrivateFormat.Raw, serialization.NoEncryption()
    ).hex()
    pub = priv.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw).hex()
    return seed, pub


def _keys():
    seed, pub = _ed()
    fpr = hashlib.sha256(bytes.fromhex(pub)).hexdigest()
    p_priv, p_pub = generate_recipient_keypair()
    p_fpr = recipient_fingerprint(p_pub)
    return [
        {
            "meta": {"kid": fpr[:16], "type": "identity-ed25519", "suite": "ed25519/1", "label": "Identité é",
                     "createdAt": "2026-10-01T10:00:00Z", "status": "active", "publicHex": pub, "fingerprint": fpr},
            "privateHex": seed,
        },
        {
            "meta": {"kid": p_fpr[:16], "type": "recipient-p256", "suite": "p256-ecdh-es/1", "label": "Réception",
                     "createdAt": "2026-10-01T10:01:00Z", "status": "retired", "publicHex": p_pub,
                     "fingerprint": p_fpr},
            "privateHex": p_priv,
        },
    ]


def test_roundtrip_and_no_plaintext_secret():
    keys = _keys()
    f = build_key_bundle(keys, "pw", "11" * 32)
    assert keys[0]["privateHex"] not in json.dumps(f)
    out = open_key_bundle(parse_key_bundle(json.dumps(f)), "pw")
    assert [k["privateHex"] for k in out["keys"]] == [k["privateHex"] for k in keys]
    assert out["master"] == "11" * 32


def test_wrong_password_and_tamper_detected():
    f = build_key_bundle(_keys(), "pw")
    with pytest.raises(KeyBundleError):
        open_key_bundle(f, "nope")
    t = copy.deepcopy(f)
    t["keys"][1]["status"] = "active"
    with pytest.raises(KeyBundleError, match="modifiée"):
        open_key_bundle(t, "pw")
    t = copy.deepcopy(f)
    t["kdf"]["t"] = 5
    with pytest.raises(KeyBundleError, match="incohérente"):
        open_key_bundle(t, "pw")


@pytest.mark.parametrize(
    "mutate",
    [
        lambda o: o.__setitem__("cipher", "chacha20-poly1305"),
        lambda o: o.__setitem__("suite", "x/9"),
        lambda o: o["kdf"].__setitem__("alg", "scrypt"),
        lambda o: o["kdf"].__setitem__("m", 10**9),
        lambda o: o["keys"][0].__setitem__("suite", "rsa/1"),
        lambda o: o.__setitem__("keys", []),
    ],
)
def test_parse_rejects_unknown_or_out_of_bounds(mutate):
    f = build_key_bundle(_keys(), "pw")
    mutate(f)
    with pytest.raises(KeyBundleError):
        parse_key_bundle(json.dumps(f))


def test_filename_has_no_fingerprint():
    assert bundle_filename("2026-10-03") == "elium-cles-2026-10-03.eliumkey"


def test_succession_valid_and_tamper_proof():
    a, _ = _ed()
    b, _ = _ed()
    cert = create_succession(a, b, "2026-10-03T00:00:00Z")
    assert verify_succession(cert)
    assert not verify_succession({**cert, "issuedAt": "2020-01-01T00:00:00Z"})
    assert not verify_succession({**cert, "newSig": cert["oldSig"]})
