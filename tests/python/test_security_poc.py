"""Wire the adversarial security PoC scripts into the automated test suite.

security/poc_dos_spoof.py and security/poc_tamper.py are standalone attack
harnesses (not test_*.py files) that exercise real attack scenarios — trust
badge spoofing, ZIP/JSON decompression DoS, ciphertext tampering, journal and
signature forgery, metadata leaks, and Python/Web KDF bound divergence. Each
uses raw `assert` statements that abort the script (AssertionError, non-zero
exit code) the moment a security property is violated.

Nothing previously executed them automatically, so a real regression in any
of those properties could land without CI ever noticing. This file runs each
script as a subprocess and fails the pytest test (with stdout/stderr — the
[PWNED]/[BLOCKED] trail — attached to the failure message) whenever the
script's exit code is non-zero.
"""

import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
SECURITY_DIR = REPO_ROOT / "security"

# Both scripts run in well under a second locally (Argon2id KDF + AES included,
# plus a 20000-level-deep JSON parse for the DoS case). 120s gives a very
# comfortable margin for a loaded/slower CI runner while still failing fast
# if a script actually hangs (e.g. an unbounded-recursion regression).
POC_TIMEOUT_SECONDS = 120

POC_SCRIPTS = [
    SECURITY_DIR / "poc_dos_spoof.py",
    SECURITY_DIR / "poc_tamper.py",
]


@pytest.mark.parametrize("script_path", POC_SCRIPTS, ids=lambda p: p.name)
def test_security_poc_script_exits_cleanly(script_path):
    """The PoC script must exit 0: every `assert` inside it held, i.e. no
    security regression was detected."""
    assert script_path.is_file(), f"PoC script not found: {script_path}"

    result = subprocess.run(  # noqa: S603 — args fixes (interpréteur courant + chemin vérifié ci-dessus), aucune entrée externe.
        [sys.executable, str(script_path)],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        timeout=POC_TIMEOUT_SECONDS,
    )

    assert result.returncode == 0, (
        f"{script_path.name} exited with code {result.returncode} "
        f"(a SECURITY REGRESSION assertion likely failed).\n\n"
        f"--- stdout ---\n{result.stdout}\n\n"
        f"--- stderr ---\n{result.stderr}"
    )
