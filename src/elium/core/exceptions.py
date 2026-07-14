"""
Exceptions for Elium.
"""

class EliumError(Exception):
    """Base class for all Elium errors."""
    pass

class EliumSecurityError(EliumError):
    """Raised when a security check fails (MAC mismatch, bad password, invalid signature)."""
    pass

class EliumFormatError(EliumError):
    """Raised when the file format is invalid or corrupted."""
    pass

class EliumVersionError(EliumFormatError):
    """Raised when the file version is not supported."""
    pass
