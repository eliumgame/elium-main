"""
`.eliumkey` v2 — sauvegarde d'un TROUSSEAU (Ed25519 + P-256 + secret maître).

Miroir octet pour octet de web-studio/src/crypto/keyfile-v2.ts.

Fichier JSON :
    {"format":"elium-key","version":2,"suite":"elium-keybundle/1",
     "kdf":{"alg":"argon2id","t":..,"m":..,"p":..},"cipher":"aes-256-gcm",
     "keys":[{kid,type,suite,label,createdAt,status,publicHex,fingerprint,...}],
     "enc":"<conteneur Elium hex>","exportedAt":"..."}

L'en-tête externe (en clair) est LIÉ au contenu chiffré : le conteneur transporte
`bound = SHA-256(JSON canonique de l'en-tête externe)`. Les paramètres kdf/cipher
déclarés doivent être exactement ceux de l'en-tête du conteneur (authentifié).
"""
from __future__ import annotations

import json
import re
from typing import Any

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey

from elium.core.container import EliumContainer
from elium.core.exceptions import EliumError, EliumFormatError, EliumSecurityError
from elium.crypto.primitives import ARGON2_MEMORY_KIB, ARGON2_PARALLELISM, ARGON2_TIME
from elium.format.canonical import canonical_json, now_iso, sha256_hex

KEYBUNDLE_FORMAT = "elium-key"
KEYBUNDLE_VERSION = 2
KEYBUNDLE_SUITE = "elium-keybundle/1"
SUCCESSION_TYPE = "elium-succession/1"

KEY_SUITES = {
    "identity-ed25519": "ed25519/1",
    "recipient-p256": "p256-ecdh-es/1",
}
_STATUSES = ("active", "retired", "revoked")
_HEX64 = re.compile(r"^[0-9a-f]{64}$")
_P256_PUB = re.compile(r"^04[0-9a-f]{128}$")
_HEX = re.compile(r"^[0-9a-f]+$")


class KeyBundleError(EliumError):
    """Sauvegarde de clés invalide, altérée ou illisible."""


def bundle_filename(date: str | None = None) -> str:
    """Nom suggéré, sans empreinte ni identité."""
    return f"elium-cles-{date or now_iso()[:10]}.eliumkey"


def _outer(f: dict[str, Any]) -> dict[str, Any]:
    return {k: f[k] for k in ("format", "version", "suite", "kdf", "cipher", "keys")}


def _bound(f: dict[str, Any]) -> str:
    return sha256_hex(canonical_json(_outer(f)))


def _public_ed25519(private_hex: str) -> str:
    priv = Ed25519PrivateKey.from_private_bytes(bytes.fromhex(private_hex))
    return priv.public_key().public_bytes(
        serialization.Encoding.Raw, serialization.PublicFormat.Raw
    ).hex()


def _public_p256(private_hex: str) -> str:
    priv = ec.derive_private_key(int(private_hex, 16), ec.SECP256R1())
    return priv.public_key().public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
    ).hex()


def build_key_bundle(
    keys: list[dict[str, Any]], password: str, master_hex: str | None = None
) -> dict[str, Any]:
    """`keys` : liste de {"meta": {...}, "privateHex": "..."}. Retourne le dict du fichier."""
    if not password:
        raise KeyBundleError("Un mot de passe est requis pour chiffrer la sauvegarde.")
    if not keys:
        raise KeyBundleError("Aucune clé à sauvegarder.")
    outer: dict[str, Any] = {
        "format": KEYBUNDLE_FORMAT,
        "version": KEYBUNDLE_VERSION,
        "suite": KEYBUNDLE_SUITE,
        "kdf": {"alg": "argon2id", "t": ARGON2_TIME, "m": ARGON2_MEMORY_KIB, "p": ARGON2_PARALLELISM},
        "cipher": "aes-256-gcm",
        "keys": [k["meta"] for k in keys],
    }
    inner: dict[str, Any] = {
        "v": 2,
        "bound": _bound(outer),
        "secrets": {k["meta"]["kid"]: k["privateHex"] for k in keys},
    }
    if master_hex:
        inner["master"] = master_hex
    enc = EliumContainer.encode(
        canonical_json(inner).encode("utf-8"),
        password,
        manifest_meta={"files": [{"name": "elium-keybundle.json"}]},
    )
    return {**outer, "enc": enc.hex(), "exportedAt": now_iso()}


def _validate_meta(m: Any) -> dict[str, Any]:
    if not isinstance(m, dict):
        raise KeyBundleError("Sauvegarde corrompue : entrée de clé invalide.")
    typ = m.get("type")
    if typ not in KEY_SUITES:
        raise KeyBundleError(f"Type de clé inconnu : {typ!r}.")
    if m.get("suite") != KEY_SUITES[typ]:
        raise KeyBundleError(f"Suite cryptographique non prise en charge : {m.get('suite')!r}.")
    pub = str(m.get("publicHex", "")).lower()
    fpr = str(m.get("fingerprint", "")).lower()
    pub_re = _HEX64 if typ == "identity-ed25519" else _P256_PUB
    if not pub_re.match(pub) or not _HEX64.match(fpr):
        raise KeyBundleError("Sauvegarde corrompue : clé publique ou empreinte invalide.")
    if not re.match(r"^[0-9a-f]{16}$", str(m.get("kid", ""))):
        raise KeyBundleError("Sauvegarde corrompue : identifiant de clé invalide.")
    if m.get("status") not in _STATUSES:
        raise KeyBundleError("Sauvegarde corrompue : état de clé invalide.")
    if not isinstance(m.get("createdAt"), str) or not isinstance(m.get("label"), str):
        raise KeyBundleError("Sauvegarde corrompue : métadonnées de clé invalides.")
    return {**m, "publicHex": pub, "fingerprint": fpr}


def parse_key_bundle(text: str | bytes) -> dict[str, Any]:
    """Valide la STRUCTURE d'un `.eliumkey` v2 (ne déchiffre pas)."""
    try:
        o = json.loads(text)
    except (json.JSONDecodeError, UnicodeDecodeError) as e:
        raise KeyBundleError("Ce fichier n'est pas une sauvegarde .eliumkey valide (JSON illisible).") from e
    if not isinstance(o, dict) or o.get("format") != KEYBUNDLE_FORMAT:
        raise KeyBundleError("Ce fichier n'est pas une sauvegarde de clés Elium (.eliumkey).")
    if o.get("version") != KEYBUNDLE_VERSION:
        raise KeyBundleError(f"Version de sauvegarde non prise en charge ({o.get('version')!r}).")
    if o.get("suite") != KEYBUNDLE_SUITE:
        raise KeyBundleError(f"Suite de sauvegarde non prise en charge ({o.get('suite')!r}).")
    kdf = o.get("kdf") or {}
    if kdf.get("alg") != "argon2id":
        raise KeyBundleError("KDF non pris en charge (argon2id attendu).")
    t, m, p = kdf.get("t"), kdf.get("m"), kdf.get("p")
    if not all(isinstance(v, int) and not isinstance(v, bool) for v in (t, m, p)) or not (
        1 <= t <= 6 and 8192 <= m <= 262144 and 1 <= p <= 16
    ):
        raise KeyBundleError("Paramètres Argon2id hors bornes.")
    if o.get("cipher") != "aes-256-gcm":
        raise KeyBundleError("Chiffrement non pris en charge (aes-256-gcm attendu).")
    keys = o.get("keys")
    if not isinstance(keys, list) or not keys:
        raise KeyBundleError("Sauvegarde sans clé.")
    metas = [_validate_meta(k) for k in keys]
    if len({k["kid"] for k in metas}) != len(metas):
        raise KeyBundleError("Sauvegarde corrompue : identifiants de clé en double.")
    enc = str(o.get("enc", "")).lower()
    if not enc or len(enc) % 2 or not _HEX.match(enc):
        raise KeyBundleError("Sauvegarde corrompue : conteneur chiffré invalide.")
    return {
        "format": KEYBUNDLE_FORMAT,
        "version": KEYBUNDLE_VERSION,
        "suite": KEYBUNDLE_SUITE,
        "kdf": {"alg": "argon2id", "t": t, "m": m, "p": p},
        "cipher": "aes-256-gcm",
        "keys": metas,
        "enc": enc,
        "exportedAt": o.get("exportedAt", ""),
    }


def open_key_bundle(file: dict[str, Any], password: str) -> dict[str, Any]:
    """Déchiffre et vérifie toute la cohérence. Retourne {"keys":[{meta,privateHex}], "master": hex|None}."""
    blob = bytes.fromhex(file["enc"])
    try:
        payload, _manifest, header = EliumContainer.decode(blob, password)
    except EliumSecurityError as e:
        raise KeyBundleError("Mot de passe incorrect ou sauvegarde corrompue.") from e
    except EliumFormatError as e:
        raise KeyBundleError(f"Conteneur invalide : {e}") from e
    hk = header.get("kdf", {})
    kd = file["kdf"]
    if (
        hk.get("alg") != kd["alg"]
        or hk.get("t") != kd["t"]
        or hk.get("m") != kd["m"]
        or hk.get("p") != kd["p"]
        or header.get("crypto", {}).get("cipher") != file["cipher"]
    ):
        raise KeyBundleError(
            "Sauvegarde incohérente : les paramètres KDF/chiffrement ne correspondent pas au conteneur."
        )
    try:
        inner = json.loads(payload.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError) as e:
        raise KeyBundleError("Contenu de la sauvegarde illisible.") from e
    if inner.get("v") != 2 or inner.get("bound") != _bound(file):
        raise KeyBundleError("Sauvegarde modifiée : l'en-tête ne correspond plus au contenu chiffré.")
    out_keys = []
    for meta in file["keys"]:
        priv = (inner.get("secrets") or {}).get(meta["kid"])
        if not isinstance(priv, str) or not _HEX64.match(priv):
            raise KeyBundleError("Sauvegarde corrompue : clé privée manquante ou invalide.")
        try:
            pub = _public_ed25519(priv) if meta["type"] == "identity-ed25519" else _public_p256(priv)
        except ValueError as e:
            raise KeyBundleError("Sauvegarde corrompue : clé privée invalide.") from e
        if pub != meta["publicHex"]:
            raise KeyBundleError(
                "Sauvegarde incohérente : la clé privée ne correspond pas à la clé publique annoncée."
            )
        if sha256_hex(bytes.fromhex(meta["publicHex"])) != meta["fingerprint"]:
            raise KeyBundleError("Sauvegarde incohérente : empreinte invalide.")
        if meta["fingerprint"][:16] != meta["kid"]:
            raise KeyBundleError("Sauvegarde incohérente : identifiant de clé invalide.")
        out_keys.append({"meta": meta, "privateHex": priv})
    master = inner.get("master")
    if master is not None and not (isinstance(master, str) and _HEX64.match(master)):
        raise KeyBundleError("Sauvegarde corrompue : secret maître invalide.")
    return {"keys": out_keys, "master": master}


# --- Succession --------------------------------------------------------------

def _succession_body(old_pub: str, new_pub: str, issued_at: str) -> bytes:
    return canonical_json(
        {
            "type": SUCCESSION_TYPE,
            "oldPublicKeyHex": old_pub,
            "newPublicKeyHex": new_pub,
            "issuedAt": issued_at,
        }
    ).encode("utf-8")


def create_succession(old_private_hex: str, new_private_hex: str, issued_at: str | None = None) -> dict[str, Any]:
    old_pub = _public_ed25519(old_private_hex)
    new_pub = _public_ed25519(new_private_hex)
    issued = issued_at or now_iso()
    body = _succession_body(old_pub, new_pub, issued)
    return {
        "type": SUCCESSION_TYPE,
        "oldPublicKeyHex": old_pub,
        "newPublicKeyHex": new_pub,
        "issuedAt": issued,
        "oldSig": Ed25519PrivateKey.from_private_bytes(bytes.fromhex(old_private_hex)).sign(body).hex(),
        "newSig": Ed25519PrivateKey.from_private_bytes(bytes.fromhex(new_private_hex)).sign(body).hex(),
    }


def verify_succession(cert: dict[str, Any]) -> bool:
    try:
        if cert.get("type") != SUCCESSION_TYPE or cert["oldPublicKeyHex"] == cert["newPublicKeyHex"]:
            return False
        body = _succession_body(cert["oldPublicKeyHex"], cert["newPublicKeyHex"], cert["issuedAt"])
        for pub, sig in ((cert["oldPublicKeyHex"], cert["oldSig"]), (cert["newPublicKeyHex"], cert["newSig"])):
            Ed25519PublicKey.from_public_bytes(bytes.fromhex(pub)).verify(bytes.fromhex(sig), body)
        return True
    except Exception:  # noqa: BLE001 — toute anomalie = certificat invalide
        return False
