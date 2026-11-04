"""Public core API, with the container loaded only when requested."""

from typing import TYPE_CHECKING

from elium.core.exceptions import EliumError, EliumFormatError, EliumSecurityError, EliumVersionError

if TYPE_CHECKING:
    from elium.core.container import EliumContainer

__all__ = [
    "EliumContainer",
    "EliumError",
    "EliumFormatError",
    "EliumSecurityError",
    "EliumVersionError",
]


def __getattr__(name: str):
    if name == "EliumContainer":
        # Primitives import core.exceptions. Loading the container while those
        # primitives are still initializing would re-enter their partial module.
        from elium.core.container import EliumContainer

        globals()[name] = EliumContainer
        return EliumContainer
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


def __dir__() -> list[str]:
    return sorted(set(globals()) | set(__all__))
