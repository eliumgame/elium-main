"""Protection profiles (mirror of profiles.ts). Protection is optional."""

from __future__ import annotations

from typing import TypedDict


class ProfileDef(TypedDict):
    label: str
    encrypted: bool
    password_required: bool
    locked: bool
    tracking: bool
    signatures_expected: bool
    badge: str


def _profile(
    label, badge, *, encrypted=False, password_required=False,
    locked=False, tracking=False, signatures_expected=False,
) -> ProfileDef:
    return {
        "label": label, "badge": badge, "encrypted": encrypted,
        "password_required": password_required, "locked": locked,
        "tracking": tracking, "signatures_expected": signatures_expected,
    }


PROFILES: dict[str, ProfileDef] = {
    "standard": _profile("Document simple", "Non protégé"),
    "signed": _profile("Document signé", "Signé", tracking=True, signatures_expected=True),
    "protected": _profile("Document privé", "Protégé", encrypted=True, password_required=True),
    "encrypted": _profile("Document confidentiel", "Chiffré", encrypted=True, password_required=True),
    "locked": _profile("Document final", "Verrouillé", locked=True, tracking=True, signatures_expected=True),
    "tracked": _profile("Document suivi", "Suivi", tracking=True),
    "secure_max": _profile(
        "Document ultra sécurisé", "Sécurité max",
        encrypted=True, password_required=True, locked=True, tracking=True, signatures_expected=True,
    ),
}

VALID_PROFILES = tuple(PROFILES.keys())
