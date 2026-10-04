"""
Audit des dépendances Python (équivalent de web-studio/scripts/audit-gate.mjs) : `pip-audit` sur
le verrou à hashes. Toute faille connue bloque, SAUF celles listées dans ACCEPTED, chacune avec une
justification et une date de réexamen — passée cette date l'exception échoue d'elle-même.

Usage : python scripts/pip_audit_gate.py [requirements/dev.txt]
Les fonctions pures (`blocking_findings`) sont testées dans tests/python/test_pip_audit_gate.py.
"""
from __future__ import annotations

import datetime
import json
import subprocess
import sys

# {identifiant (PYSEC/GHSA/CVE): {"reason": ..., "until": "AAAA-MM-JJ"}}
ACCEPTED: dict[str, dict[str, str]] = {}


def blocking_findings(report: dict, today: str, accepted: dict[str, dict[str, str]] | None = None) -> list[str]:
    """Failles bloquantes d'un rapport `pip-audit --format json` (liste vide = conforme)."""
    accepted = ACCEPTED if accepted is None else accepted
    out: list[str] = []
    for dep in report.get("dependencies", []):
        for vuln in dep.get("vulns", []) or []:
            ids = [vuln.get("id", "?"), *(vuln.get("aliases") or [])]
            hit = next((accepted[i] for i in ids if i in accepted), None)
            label = f"{dep.get('name')}=={dep.get('version')} : {ids[0]}"
            if hit and today <= hit["until"]:
                print(f"pip-audit-gate: {label} acceptée jusqu'au {hit['until']} ({hit['reason']})")
            else:
                out.append(label + (f" (exception expirée le {hit['until']})" if hit else ""))
    return out


def main(argv: list[str]) -> int:
    req = argv[1] if len(argv) > 1 else "requirements/dev.txt"
    proc = subprocess.run(  # noqa: S603
        [sys.executable, "-m", "pip_audit", "-r", req, "--require-hashes", "--no-deps", "--disable-pip",
         "--format", "json"],
        capture_output=True, text=True,
    )
    try:
        report = json.loads(proc.stdout)
    except ValueError:
        print("pip-audit-gate: sortie illisible de pip-audit :\n" + proc.stdout + proc.stderr, file=sys.stderr)
        return 1
    blocking = blocking_findings(report, datetime.date.today().isoformat())
    if blocking:
        print("pip-audit-gate: failles bloquantes :\n  - " + "\n  - ".join(blocking), file=sys.stderr)
        return 1
    print("pip-audit-gate: aucune faille bloquante.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
