"""Public imports must work independently of pytest's collection order."""

import subprocess
import sys
import textwrap

import pytest


def _fresh_python(code, *args):
    result = subprocess.run(  # noqa: S603 - interpréteur courant, code de test fixe
        [sys.executable, "-c", textwrap.dedent(code), *args],
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 0, result.stdout + result.stderr


@pytest.mark.parametrize("first_import", [
    "elium.crypto.primitives",
    "elium.crypto.recipients",
    "elium.crypto.keybundle",
    "elium.crypto.keyring_store",
    "elium.core.exceptions",
    "elium.core.container",
    "elium.core",
    "elium.format.canonical",
    "elium.format.proof",
    "elium.format.seal",
    "elium.cli.main",
])
def test_public_core_api_in_fresh_process(first_import):
    _fresh_python("""
        import importlib
        import sys

        importlib.import_module(sys.argv[1])
        import elium.core as core

        expected = {
            "EliumContainer", "EliumError", "EliumFormatError",
            "EliumSecurityError", "EliumVersionError",
        }
        assert set(core.__all__) == expected
        assert expected <= set(dir(core))

        from elium.core import EliumContainer
        from elium.core.container import EliumContainer as direct_container
        from elium.core import exceptions
        assert EliumContainer is direct_container is core.EliumContainer

        namespace = {}
        exec("from elium.core import *", namespace)
        assert namespace["EliumContainer"] is direct_container
        for name in expected - {"EliumContainer"}:
            assert namespace[name] is getattr(exceptions, name)

        assert not hasattr(core, "missing_export")
        try:
            core.missing_export
        except AttributeError as exc:
            assert "missing_export" in str(exc)
        else:
            raise AssertionError("Unknown exports must raise AttributeError")
    """, first_import)


def test_importing_exceptions_does_not_load_container_or_crypto():
    _fresh_python("""
        import sys
        from elium.core import EliumSecurityError
        from elium.core.exceptions import EliumSecurityError as direct_error

        assert EliumSecurityError is direct_error
        assert "elium.core.container" not in sys.modules
        assert "elium.crypto.primitives" not in sys.modules
    """)
