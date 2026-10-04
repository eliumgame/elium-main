"""Réglages communs aux tests Python."""
from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def _never_touch_the_real_registry(monkeypatch):
    """Les tests de l'updater ne doivent JAMAIS modifier « Applications installées » de la machine
    qui les exécute (updater.sync_arp_version) : désactivé par défaut, réactivé explicitement par
    le test dédié, qui injecte un faux module winreg."""
    monkeypatch.setenv("ELIUM_NO_ARP_SYNC", "1")
