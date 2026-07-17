"""
Génère la paire de clés Ed25519 servant à SIGNER les mises à jour Elium.

À lancer UNE SEULE FOIS (hors CI). Produit :
  - une clé privée (64 hex) → à coller dans le secret GitHub Actions ``UPDATE_SIGNING_KEY``
    (Settings ▸ Secrets and variables ▸ Actions ▸ New repository secret).
  - une clé publique (64 hex) → à coller dans ``installer/updater.py`` (constante
    ``UPDATE_PUBLIC_KEY_HEX``) pour que l'app vérifie chaque màj avant de l'appliquer.

Format = hex brut des 32 octets (même convention que le sceau documentaire, voir
``src/elium/format/seal.py``). La clé privée n'est JAMAIS commitée : par défaut elle est
écrite dans ``update-private-key.hex`` à la racine, couvert par ``.gitignore``.

Usage :
    python scripts/gen_update_keypair.py            # écrit la privée dans un fichier gitignoré
    python scripts/gen_update_keypair.py --print    # affiche seulement, n'écrit rien
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey


def _raw_hex_private(priv: Ed25519PrivateKey) -> str:
    raw = priv.private_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PrivateFormat.Raw,
        encryption_algorithm=serialization.NoEncryption(),
    )
    return raw.hex()


def _raw_hex_public(priv: Ed25519PrivateKey) -> str:
    raw = priv.public_key().public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )
    return raw.hex()


def main() -> int:
    parser = argparse.ArgumentParser(description="Génère la paire de clés de signature d'update Elium.")
    parser.add_argument(
        "--out",
        default="update-private-key.hex",
        help="Fichier de sortie pour la clé privée (défaut: update-private-key.hex, gitignoré).",
    )
    parser.add_argument(
        "--print",
        dest="print_only",
        action="store_true",
        help="Affiche les deux clés sans écrire de fichier.",
    )
    args = parser.parse_args()

    priv = Ed25519PrivateKey.generate()
    priv_hex = _raw_hex_private(priv)
    pub_hex = _raw_hex_public(priv)

    print("=" * 70)
    print("Paire de clés de signature d'update Elium (Ed25519)")
    print("=" * 70)
    print()
    print("CLE PUBLIQUE (a coller dans installer/updater.py -> UPDATE_PUBLIC_KEY_HEX) :")
    print(f"  {pub_hex}")
    print()

    if args.print_only:
        print("CLE PRIVEE (secret GitHub Actions UPDATE_SIGNING_KEY) :")
        print(f"  {priv_hex}")
    else:
        out = Path(args.out)
        out.write_text(priv_hex + "\n", encoding="utf-8")
        print(f"CLE PRIVEE ecrite dans : {out.resolve()}")
        print("  -> Copiez son contenu dans le secret GitHub Actions 'UPDATE_SIGNING_KEY',")
        print("     puis SUPPRIMEZ ce fichier local. Il est deja couvert par .gitignore.")
    print()
    print("Rappel : ne committez JAMAIS la clé privée.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
