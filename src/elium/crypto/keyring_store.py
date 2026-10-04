"""
Trousseau de clés local pour la CLI (`elium keys …`).

Les clés privées ne transitent JAMAIS par la ligne de commande ni l'historique du
shell : elles vivent dans un fichier `keyring.json` (dossier `ELIUM_KEYS_DIR`, par
défaut `~/.elium/keys`), chacune chiffrée dans un conteneur Elium (Argon2id +
AES-256-GCM) sous le mot de passe du trousseau. Le même format de métadonnées que
le `.eliumkey` v2 (cf. keybundle.py) permet l'échange avec le Web Studio.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Any

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from elium.core.container import EliumContainer
from elium.core.exceptions import EliumError, EliumSecurityError
from elium.crypto.keybundle import KEY_SUITES, create_succession
from elium.crypto.recipients import generate_recipient_keypair, recipient_fingerprint
from elium.format.canonical import now_iso

KEYRING_VERSION = 1
FILE_NAME = "keyring.json"


class KeyringStoreError(EliumError):
    """Trousseau local illisible ou opération impossible."""


def keys_dir(override: str | None = None) -> Path:
    return Path(override or os.environ.get("ELIUM_KEYS_DIR") or (Path.home() / ".elium" / "keys"))


def load(directory: Path) -> dict[str, Any]:
    path = directory / FILE_NAME
    if not path.exists():
        return {"version": KEYRING_VERSION, "keys": []}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        raise KeyringStoreError(f"Trousseau illisible : {path}") from e
    if data.get("version") != KEYRING_VERSION or not isinstance(data.get("keys"), list):
        raise KeyringStoreError("Version de trousseau non prise en charge.")
    return data


def save(directory: Path, data: dict[str, Any]) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / FILE_NAME
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    try:
        os.chmod(tmp, 0o600)
    except OSError:
        pass  # Windows : ACL du profil utilisateur
    os.replace(tmp, path)


def protect(private_hex: str, password: str) -> str:
    blob = EliumContainer.encode(
        private_hex.encode("ascii"), password, manifest_meta={"files": [{"name": "elium-key"}]}
    )
    return blob.hex()


def unprotect(enc: str, password: str) -> str:
    try:
        payload, _m, _h = EliumContainer.decode(bytes.fromhex(enc), password)
    except EliumSecurityError as e:
        raise KeyringStoreError("Mot de passe du trousseau incorrect.") from e
    return payload.decode("ascii")


def _ed25519_pair() -> tuple[str, str]:
    priv = Ed25519PrivateKey.generate()
    seed = priv.private_bytes(
        serialization.Encoding.Raw, serialization.PrivateFormat.Raw, serialization.NoEncryption()
    ).hex()
    pub = priv.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw).hex()
    return seed, pub


def _entry(type_: str, private_hex: str, public_hex: str, password: str, label: str) -> dict[str, Any]:
    fpr = (
        hashlib.sha256(bytes.fromhex(public_hex)).hexdigest()
        if type_ == "identity-ed25519"
        else recipient_fingerprint(public_hex)
    )
    return {
        "kid": fpr[:16],
        "type": type_,
        "suite": KEY_SUITES[type_],
        "label": label,
        "createdAt": now_iso(),
        "status": "active",
        "publicHex": public_hex,
        "fingerprint": fpr,
        "enc": protect(private_hex, password),
    }


def generate(data: dict[str, Any], type_: str, password: str, label: str | None = None) -> dict[str, Any]:
    if type_ == "identity-ed25519":
        priv, pub = _ed25519_pair()
    elif type_ == "recipient-p256":
        priv, pub = generate_recipient_keypair()
    else:
        raise KeyringStoreError(f"Type de clé inconnu : {type_}")
    default_label = "Identité de signature" if type_ == "identity-ed25519" else "Clé de réception"
    entry = _entry(type_, priv, pub, password, label or default_label)
    data["keys"].append(entry)
    return entry


def find(data: dict[str, Any], kid: str) -> dict[str, Any]:
    matches = [k for k in data["keys"] if k["kid"].startswith(kid)]
    if len(matches) != 1:
        raise KeyringStoreError(f"Clé « {kid} » introuvable ou ambiguë.")
    return matches[0]


def rotate(data: dict[str, Any], kid: str, password: str) -> dict[str, Any]:
    old = find(data, kid)
    if old["status"] != "active":
        raise KeyringStoreError("Seule une clé active peut être tournée.")
    if old["type"] == "identity-ed25519":
        old_priv = unprotect(old["enc"], password)
        new = generate(data, "identity-ed25519", password, old["label"])
        new_priv = unprotect(new["enc"], password)
        new["succession"] = create_succession(old_priv, new_priv)
    else:
        new = generate(data, "recipient-p256", password, old["label"])
    old["status"] = "retired"
    old["retiredAt"] = now_iso()
    return new
