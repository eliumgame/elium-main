"""
Elium Core Container Implementation (v3).
"""

from __future__ import annotations

import json
import struct
import time
import zlib
from typing import Any

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey

from elium.core.exceptions import EliumFormatError, EliumSecurityError, EliumVersionError
from elium.crypto.primitives import (
    HMAC_SIZE,
    SIGNATURE_SIZE,
    compute_hmac,
    decrypt_aead,
    decrypt_cascade,
    derive_master_key,
    derive_subkey,
    encrypt_aead,
    encrypt_cascade,
    generate_nonce,
    generate_salt,
    get_public_key_fingerprint,
    verify_hmac,
)

MAGIC_V3 = b"ELIUM\x03"
VERSION = 3

class EliumContainer:
    """
    Elium v3 Secure Container encoder and decoder.
    For simplicity, this version encodes everything in memory.
    Streaming support can be added by chunking the payload.
    """

    @staticmethod
    def encode(
        payload: bytes,
        password: str,
        manifest_meta: dict[str, Any] | None = None,
        keyfile: bytes | None = None,
        compress: bool = True,
        cascade: bool = False,
        signing_key: Ed25519PrivateKey | None = None
    ) -> bytes:
        if not password:
            raise ValueError("Password is required.")

        salt = generate_salt()
        nonce_aes = generate_nonce()
        nonce_cha = generate_nonce()

        # Derive keys
        master = derive_master_key(password, salt, keyfile=keyfile)
        k_aes = derive_subkey(master, b"elium-v3-aes-gcm")
        k_cha = derive_subkey(master, b"elium-v3-chacha")
        k_mac = derive_subkey(master, b"elium-v3-hmac")

        # Build Public Header
        header_dict = {
            "version": VERSION,
            "kdf": {
                "alg": "argon2id",
                "t": 3, "m": 262144, "p": 4,
                "salt": salt.hex()
            },
            "crypto": {
                "cipher": "aes-256-gcm",
                "cascade": "chacha20-poly1305" if cascade else None,
                "nonce_aes": nonce_aes.hex(),
                "nonce_cha": nonce_cha.hex() if cascade else None
            },
            "flags": {
                "compressed": compress,
                "signed": signing_key is not None,
                "keyfile_required": keyfile is not None
            }
        }

        if signing_key:
            header_dict["signatures"] = [{
                "alg": "ed25519",
                "signer_fp": get_public_key_fingerprint(signing_key.public_key()),
                "signed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            }]

        header_bytes = json.dumps(header_dict, separators=(',', ':')).encode("utf-8")

        # Build Manifest + Payload
        manifest = dict(manifest_meta) if manifest_meta else {}
        manifest.setdefault("generator", "elium-v3")
        manifest.setdefault("created_at", time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))

        manifest_bytes = json.dumps(manifest, ensure_ascii=False).encode("utf-8")
        inner_data = struct.pack(">I", len(manifest_bytes)) + manifest_bytes + payload

        if compress:
            inner_data = zlib.compress(inner_data, level=9)

        # Encrypt
        ct = encrypt_aead(k_aes, nonce_aes, inner_data, header_bytes)
        if cascade:
            ct = encrypt_cascade(k_cha, nonce_cha, ct, header_bytes)

        # Assemble file
        out = bytearray()
        out += MAGIC_V3
        out += struct.pack(">I", len(header_bytes))
        out += header_bytes
        out += struct.pack(">Q", len(ct))
        out += ct

        # Sign
        if signing_key:
            sig = signing_key.sign(bytes(out))
            out += sig

        # Global HMAC
        mac = compute_hmac(k_mac, bytes(out))
        out += mac

        return bytes(out)

    @staticmethod
    def decode(
        blob: bytes,
        password: str,
        keyfile: bytes | None = None,
        verify_public_key: Ed25519PublicKey | None = None
    ) -> tuple[bytes, dict[str, Any], dict[str, Any]]:
        """
        Decodes a v3 container.
        Returns: (payload_bytes, manifest_dict, public_header_dict)
        """
        if len(blob) < len(MAGIC_V3) + 4 + 8 + HMAC_SIZE:
            raise EliumFormatError("File too short to be a valid Elium container.")

        if not blob.startswith(MAGIC_V3):
            raise EliumFormatError("Invalid Magic Bytes. Not an Elium v3 file.")

        pos = len(MAGIC_V3)
        header_len = struct.unpack(">I", blob[pos:pos+4])[0]
        pos += 4

        header_bytes = blob[pos:pos+header_len]
        pos += header_len

        try:
            header = json.loads(header_bytes.decode("utf-8"))
        except json.JSONDecodeError as e:
            raise EliumFormatError("Public Header is corrupted.") from e

        if header.get("version") != VERSION:
            raise EliumVersionError(f"Unsupported version: {header.get('version')}")

        flags = header.get("flags", {})
        is_compressed = flags.get("compressed", False)
        is_signed = flags.get("signed", False)
        requires_keyfile = flags.get("keyfile_required", False)
        cascade_alg = header.get("crypto", {}).get("cascade")
        is_cascade = cascade_alg == "chacha20-poly1305"

        if requires_keyfile and keyfile is None:
            raise EliumSecurityError("This file requires a keyfile.")

        kdf_alg = header.get("kdf", {}).get("alg")
        if kdf_alg != "argon2id":
            raise EliumFormatError(f"Unsupported KDF: {kdf_alg}")

        t = header["kdf"].get("t", 0)
        m = header["kdf"].get("m", 0)
        p = header["kdf"].get("p", 0)
        if not (1 <= t <= 6 and 8192 <= m <= 262144 and 1 <= p <= 16):
            raise EliumSecurityError(f"KDF parameters out of bounds (DoS protection): t={t}, m={m}, p={p}")

        salt_hex = header["kdf"].get("salt", "")
        if len(salt_hex) != 32:
            raise EliumFormatError("Invalid salt length")

        salt = bytes.fromhex(salt_hex)
        nonce_aes = bytes.fromhex(header["crypto"]["nonce_aes"])
        if len(nonce_aes) != 12:
            raise EliumFormatError("Invalid AES nonce length")

        nonce_cha = bytes.fromhex(header["crypto"]["nonce_cha"]) if is_cascade else b""
        if is_cascade and len(nonce_cha) != 12:
            raise EliumFormatError("Invalid ChaCha nonce length")

        ct_len = struct.unpack(">Q", blob[pos:pos+8])[0]
        pos += 8

        ct = blob[pos:pos+ct_len]
        pos += ct_len

        signature = blob[pos:pos+SIGNATURE_SIZE] if is_signed else b""
        if is_signed:
            pos += SIGNATURE_SIZE

        stored_mac = blob[pos:pos+HMAC_SIZE]

        # Derive keys
        master = derive_master_key(
            password, salt, keyfile=keyfile,
            time_cost=header["kdf"]["t"],
            memory_kib=header["kdf"]["m"],
            parallelism=header["kdf"]["p"]
        )
        k_aes = derive_subkey(master, b"elium-v3-aes-gcm")
        k_cha = derive_subkey(master, b"elium-v3-chacha")
        k_mac = derive_subkey(master, b"elium-v3-hmac")

        # Verify MAC (covers everything before the stored MAC)
        mac_data = blob[:pos]
        verify_hmac(k_mac, mac_data, stored_mac)

        # Verify Signature
        if is_signed:
            if verify_public_key is None:
                header["signature_valid"] = None
            else:
                try:
                    verify_public_key.verify(signature, blob[:pos - SIGNATURE_SIZE])
                    header["signature_valid"] = True
                except InvalidSignature as e:
                    raise EliumSecurityError("Invalid Ed25519 signature.") from e

        # Decrypt
        if is_cascade:
            ct = decrypt_cascade(k_cha, nonce_cha, ct, header_bytes)

        inner_data = decrypt_aead(k_aes, nonce_aes, ct, header_bytes)

        if is_compressed:
            # Prevent decompression bomb (max 512 MiB)
            decompressor = zlib.decompressobj()
            inner_data = decompressor.decompress(inner_data, max_length=536870912)
            if not decompressor.eof or decompressor.unconsumed_tail:
                raise EliumSecurityError("Decompression payload exceeded 512 MiB limit.")

        manifest_len = struct.unpack(">I", inner_data[:4])[0]
        manifest_bytes = inner_data[4:4+manifest_len]
        payload = inner_data[4+manifest_len:]

        manifest = json.loads(manifest_bytes.decode("utf-8"))

        return payload, manifest, header
