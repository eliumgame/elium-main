"""
Hash-chained tracking journal — compatible with journal.ts.

event.hash = sha256( prevHash + canonical_json(payload) )
payload = { seq, type, at, [actor], [data] }  (optional keys omitted when empty)
"""

from __future__ import annotations

from typing import Any, TypedDict

from elium.format.canonical import ZERO_HASH, canonical_json, now_iso, sha256_hex


class Journal(TypedDict):
    version: int
    events: list[dict[str, Any]]


def empty_journal() -> Journal:
    return {"version": 1, "events": []}


def _payload(seq: int, type_: str, at: str, actor: dict | None, data: dict | None) -> dict:
    payload: dict[str, Any] = {"seq": seq, "type": type_, "at": at}
    if actor:
        payload["actor"] = actor
    if data:
        payload["data"] = data
    return payload


def append_event(
    journal: Journal,
    type_: str,
    actor: dict | None = None,
    data: dict | None = None,
    at: str | None = None,
) -> Journal:
    seq = len(journal["events"])
    prev = ZERO_HASH if seq == 0 else journal["events"][-1]["hash"]
    at = at or now_iso()
    payload = _payload(seq, type_, at, actor, data)
    event = {**payload, "prevHash": prev, "hash": sha256_hex(prev + canonical_json(payload))}
    journal["events"].append(event)
    return journal


def verify_journal(journal: Journal) -> dict[str, Any]:
    prev = ZERO_HASH
    events = journal.get("events", [])
    for i, e in enumerate(events):
        if e.get("seq") != i or e.get("prevHash") != prev:
            return {"valid": False, "brokenAt": i, "count": len(events)}
        payload = _payload(e["seq"], e["type"], e["at"], e.get("actor"), e.get("data"))
        if sha256_hex(prev + canonical_json(payload)) != e.get("hash"):
            return {"valid": False, "brokenAt": i, "count": len(events)}
        prev = e["hash"]
    return {"valid": True, "brokenAt": None, "count": len(events)}
