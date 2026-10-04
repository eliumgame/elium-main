"""`elium keys …` : gestion du trousseau sans jamais passer une clé privée en argument."""
from __future__ import annotations

import argparse
import getpass
import json
import os
import sys
from pathlib import Path

from elium.crypto import keyring_store as ks
from elium.crypto.keybundle import (
    KeyBundleError,
    build_key_bundle,
    bundle_filename,
    open_key_bundle,
    parse_key_bundle,
)

_ENV_PW = "ELIUM_KEYRING_PASSWORD"


def _password(prompt: str = "Mot de passe du trousseau: ", confirm: bool = False) -> str:
    env = os.environ.get(_ENV_PW)
    if env:
        return env
    pw = getpass.getpass(prompt)
    if not pw:
        raise ks.KeyringStoreError("Mot de passe vide.")
    if confirm and getpass.getpass("Confirmez le mot de passe: ") != pw:
        raise ks.KeyringStoreError("Les mots de passe ne correspondent pas.")
    return pw


def _dir(args: argparse.Namespace) -> Path:
    return ks.keys_dir(getattr(args, "dir", None))


def cmd_keys_list(args: argparse.Namespace) -> None:
    data = ks.load(_dir(args))
    if not data["keys"]:
        print("Aucune clé. Créez-en une avec `elium keys generate identity|recipient`.")
        return
    for k in data["keys"]:
        exp = f"  expire {k['expiresAt'][:10]}" if k.get("expiresAt") else ""
        succ = "  (succède à une clé précédente)" if k.get("succession") else ""
        print(f"{k['kid']}  {k['type']:<17} {k['status']:<8} {k['label']}{exp}{succ}")
        print(f"    empreinte {k['fingerprint']}")


def cmd_keys_generate(args: argparse.Namespace) -> None:
    d = _dir(args)
    data = ks.load(d)
    type_ = "identity-ed25519" if args.kind == "identity" else "recipient-p256"
    entry = ks.generate(data, type_, _password(confirm=not data["keys"]), args.label)
    ks.save(d, data)
    print(f"Clé créée : {entry['kid']} ({type_})")
    print(f"Clé publique : {entry['publicHex']}")
    print("Sauvegardez-la maintenant : `elium keys export --output <fichier.eliumkey>`.")


def cmd_keys_public(args: argparse.Namespace) -> None:
    print(ks.find(ks.load(_dir(args)), args.kid)["publicHex"])


def cmd_keys_export(args: argparse.Namespace) -> None:
    d = _dir(args)
    data = ks.load(d)
    selected = [ks.find(data, k) for k in args.kid] if args.kid else list(data["keys"])
    if not selected:
        raise ks.KeyringStoreError("Aucune clé à exporter.")
    keyring_pw = _password()
    keys = []
    for k in selected:
        meta = {x: v for x, v in k.items() if x not in ("enc", "retiredAt", "backedUpAt")}
        keys.append({"meta": meta, "privateHex": ks.unprotect(k["enc"], keyring_pw)})
    bundle_pw = keyring_pw if os.environ.get(_ENV_PW) else _password("Mot de passe de la sauvegarde: ", confirm=True)
    bundle = build_key_bundle(keys, bundle_pw)
    out = Path(args.output or bundle_filename())
    out.write_text(json.dumps(bundle, ensure_ascii=False, indent=2), encoding="utf-8")
    now = bundle["exportedAt"]
    for k in selected:
        k["backedUpAt"] = now
    ks.save(d, data)
    print(f"Sauvegarde .eliumkey v2 écrite : {out} ({len(keys)} clé(s))")


def cmd_keys_import(args: argparse.Namespace) -> None:
    d = _dir(args)
    data = ks.load(d)
    try:
        bundle = parse_key_bundle(Path(args.file).read_text(encoding="utf-8"))
        opened = open_key_bundle(bundle, _password("Mot de passe de la sauvegarde: "))
    except KeyBundleError as e:
        raise ks.KeyringStoreError(str(e)) from e
    keyring_pw = _password("Mot de passe du trousseau local: ", confirm=not data["keys"])
    known = {k["kid"] for k in data["keys"]}
    added = 0
    for k in opened["keys"]:
        if k["meta"]["kid"] in known:
            continue
        entry = {
            **k["meta"],
            "enc": ks.protect(k["privateHex"], keyring_pw),
            "backedUpAt": bundle["exportedAt"] or "import",
        }
        data["keys"].append(entry)
        added += 1
    ks.save(d, data)
    print(f"{added} clé(s) importée(s), {len(opened['keys']) - added} déjà présente(s).")


def cmd_keys_rotate(args: argparse.Namespace) -> None:
    d = _dir(args)
    data = ks.load(d)
    new = ks.rotate(data, args.kid, _password())
    ks.save(d, data)
    print(f"Nouvelle clé : {new['kid']} — l'ancienne est « retirée » (toujours utilisable pour déchiffrer/vérifier).")
    if new.get("succession"):
        print("Certificat de succession enregistré (vérifiable par vos correspondants).")


def load_private(kid: str, directory: str | None = None) -> str:
    """Clé privée (hex) d'une clé du trousseau, après saisie du mot de passe — pour doc-* --recipient-kid."""
    k = ks.find(ks.load(ks.keys_dir(directory)), kid)
    return ks.unprotect(k["enc"], _password())


def warn_deprecated_private_arg(flag: str) -> None:
    print(
        f"AVERTISSEMENT : {flag} est déprécié — une clé privée passée en argument reste dans l'historique du "
        "shell et la liste des processus. Utilisez `elium keys generate/import` puis --recipient-kid <kid>.",
        file=sys.stderr,
    )


def register(sub: argparse._SubParsersAction) -> None:
    p = sub.add_parser("keys", help="Gérer le trousseau de clés (liste, export, import, rotation)")
    ksub = p.add_subparsers(dest="keys_command", required=True)

    def add(name: str, help_: str, func) -> argparse.ArgumentParser:
        q = ksub.add_parser(name, help=help_)
        q.add_argument("--dir", help="Dossier du trousseau (défaut : ELIUM_KEYS_DIR ou ~/.elium/keys)")
        q.set_defaults(func=func)
        return q

    add("list", "Lister les clés", cmd_keys_list)
    q = add("generate", "Créer une clé", cmd_keys_generate)
    q.add_argument("kind", choices=["identity", "recipient"])
    q.add_argument("--label")
    q = add("public", "Afficher la clé publique d'une clé", cmd_keys_public)
    q.add_argument("kid")
    q = add("export", "Sauvegarder en .eliumkey v2 (chiffré)", cmd_keys_export)
    q.add_argument("--output")
    q.add_argument("--kid", action="append", help="Limiter à ces clés (répétable)")
    q = add("import", "Importer un .eliumkey v2", cmd_keys_import)
    q.add_argument("file")
    q = add("rotate", "Faire tourner une clé (succession pour les identités)", cmd_keys_rotate)
    q.add_argument("kid")
