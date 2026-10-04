"""Tests de scripts/pip_audit_gate.py (mécanisme d'exceptions datées)."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))

import pip_audit_gate as g  # noqa: E402

REPORT = {"dependencies": [
    {"name": "foo", "version": "1.0", "vulns": [{"id": "PYSEC-1", "aliases": ["CVE-2026-1"]}]},
    {"name": "bar", "version": "2.0", "vulns": []},
]}


def test_unaccepted_vulnerability_blocks():
    assert g.blocking_findings(REPORT, "2026-10-04", {}) == ["foo==1.0 : PYSEC-1"]


def test_accepted_until_date_passes_then_expires():
    acc = {"CVE-2026-1": {"reason": "non exploitable", "until": "2026-12-31"}}   # accepté par alias
    assert g.blocking_findings(REPORT, "2026-10-04", acc) == []
    out = g.blocking_findings(REPORT, "2027-01-01", acc)
    assert out and "exception expirée le 2026-12-31" in out[0]


def test_clean_report_passes():
    assert g.blocking_findings({"dependencies": [{"name": "a", "version": "1", "vulns": []}]}, "2026-10-04", {}) == []
