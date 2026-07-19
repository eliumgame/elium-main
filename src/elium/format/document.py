"""Document-model helpers (Python mirror of document.ts)."""

from __future__ import annotations

from typing import Any

from elium.format.journal import Journal, append_event, empty_journal
from elium.format.profiles import PROFILES

ELIUM_DOC_SCHEMA = "elium-doc/1"

DEFAULT_PAGE: dict[str, Any] = {
    "format": "A4",
    "orientation": "portrait",
    "margins": {"top": 25, "right": 20, "bottom": 25, "left": 20},
    "showPageNumbers": True,
}


def create_document_model(doc: dict | None = None, page: dict | None = None) -> dict:
    return {
        "schema": ELIUM_DOC_SCHEMA,
        "page": {**DEFAULT_PAGE, **(page or {})},
        "doc": doc or {"type": "doc", "content": [{"type": "paragraph"}]},
    }


def text_to_doc(text: str) -> dict:
    """Build a minimal ProseMirror doc from plain text (one paragraph per line)."""
    paragraphs: list[dict] = []
    for line in text.split("\n"):
        if line.strip():
            paragraphs.append({"type": "paragraph", "content": [{"type": "text", "text": line}]})
        else:
            paragraphs.append({"type": "paragraph"})
    return {"type": "doc", "content": paragraphs or [{"type": "paragraph"}]}


def extract_text(node: dict) -> str:
    if node.get("text"):
        return node["text"]
    children = node.get("content") or []
    sep = "\n" if node.get("type") in ("paragraph", "heading", "listItem", "blockquote") else ""
    return "".join(extract_text(c) for c in children) + sep


# --- Tracking journal helpers (mirror of document.ts recordSave/recordModification) ----
#
# The tracking journal is active when the profile opts in OR a journal already
# exists. Read-time events (document.opened / export / signature.validated) are
# passed as `pending` and flushed at save-time, exactly like the TS editor: the
# document seal signs a hash of the journal, so appending events only at save
# keeps a viewed/sealed document's seal intact until it is re-anchored.


def tracks_journal(profile: str, journal: Journal) -> bool:
    """Whether the tracking journal is active for this profile/journal."""
    return PROFILES[profile]["tracking"] or len(journal["events"]) > 0


def create_journal(profile: str, title: str) -> Journal:
    """Initial journal for a freshly-created document (document.created; + locked state for final profiles)."""
    journal = empty_journal()
    if PROFILES[profile]["tracking"]:
        append_event(journal, "document.created", data={"title": title})
    if PROFILES[profile]["locked"] and tracks_journal(profile, journal):
        append_event(journal, "protection.enabled", data={"profile": profile})
        append_event(journal, "document.locked")
    return journal


def record_profile(journal: Journal, profile: str, at: str | None = None) -> Journal:
    """Log a protection-profile change (protection.enabled, + document.locked when locked)."""
    if not tracks_journal(profile, journal):
        return journal
    append_event(journal, "protection.enabled", data={"profile": profile}, at=at)
    if PROFILES[profile]["locked"]:
        append_event(journal, "document.locked", at=at)
    return journal


def record_signature_added(journal: Journal, profile: str, signature: dict, at: str | None = None) -> Journal:
    """Log a signature (signature.added) with its signer/proof actor."""
    if not tracks_journal(profile, journal):
        return journal
    proof = signature.get("proof") or {}
    actor = {"name": signature.get("signer", {}).get("name")}
    if proof.get("fingerprint"):
        actor["fingerprint"] = proof["fingerprint"]
    data = {k: signature.get(k) for k in ("id", "level", "kind") if signature.get(k) is not None}
    return append_event(journal, "signature.added", actor={k: v for k, v in actor.items() if v}, data=data, at=at)


def record_modification(journal: Journal, profile: str, at: str | None = None) -> Journal:
    """Append a document.modified event (only when tracking is active)."""
    if not tracks_journal(profile, journal):
        return journal
    return append_event(journal, "document.modified", at=at)


def record_save(journal: Journal, profile: str, pending: list[dict] | None = None, at: str | None = None) -> Journal:
    """Flush queued session events (opened/export/signature.validated) then one document.modified, at save."""
    if not tracks_journal(profile, journal):
        return journal
    for ev in pending or []:
        append_event(journal, ev["type"], actor=ev.get("actor"), data=ev.get("data"), at=ev.get("at"))
    return append_event(journal, "document.modified", at=at)
