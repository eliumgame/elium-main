"""Document-model helpers (Python mirror of document.ts)."""

from __future__ import annotations

from typing import Any

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
