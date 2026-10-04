"""
Installeurs MSI (installer/elium.wxs) et entrée « Applications installées » :

  - contrôles STATIQUES de la source WiX (les deux variantes, nettoyage de désinstallation, associations) ;
  - recopie de la version active dans l'entrée de la variante par utilisateur (updater.sync_arp_version).
La compilation réelle (candle/light) est faite par le CI ; ici on garde les invariants qui, cassés,
supprimeraient des données ou casseraient les mises à niveau.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

import pytest

_INSTALLER = Path(__file__).resolve().parents[2] / "installer"
sys.path.insert(0, str(_INSTALLER))

import stamp_version  # noqa: E402
import updater  # noqa: E402

WXS = (_INSTALLER / "elium.wxs").read_text(encoding="utf-8")


def test_two_scopes_with_distinct_upgrade_codes():
    codes = re.findall(r'<\?define UpgradeCode = "([0-9A-F-]{36})" \?>', WXS)
    assert len(codes) == 2 and len(set(codes)) == 2
    assert "26104BBE-D1BC-41CB-B215-9D2D9C5CC667" in codes   # l'identité historique ne change JAMAIS
    assert 'InstallScope="$(var.Scope)"' in WXS
    assert '<?define Scope = "perMachine" ?>' in WXS         # défaut = le MSI historique


def test_version_define_is_still_stamped_by_stamp_version():
    assert re.search(r'(<\?define Version = ")[^"]*(" \?>)', WXS)
    assert "Version" in Path(stamp_version.__file__).read_text(encoding="utf-8")


def test_uninstall_cleans_only_downloaded_updates_never_user_data():
    removed = re.findall(r'SetProperty Id="ELIUM_UPD_(\w+)" Value="\[LocalAppDataFolder\]Elium\\(\w+)"', WXS)
    assert {folder for _, folder in removed} == {"web", "bin", "assets", "tmp"}
    for forbidden in ("WebProfile", "inbox", "launcher-config", "update-settings"):
        assert forbidden not in " ".join(f for _, f in removed)
        assert f"Elium\\{forbidden}" not in WXS
    # pas de nettoyage lors d'une mise à niveau (on supprimerait la mise à jour qu'on vient d'appliquer)
    assert WXS.count("NOT UPGRADINGPRODUCTCODE") >= 4
    # le dossier Elium\ lui-même n'est retiré que s'il est vide
    assert 'RemoveFolder Id="RemoveEliumDataDir" On="uninstall"' in WXS


def test_update_bundle_file_association_present_in_both_scopes():
    assert WXS.count('Extension Id="eliumupdate"') == 2
    assert WXS.count('Extension Id="elium"') == 2


def test_per_user_variant_installs_without_admin_rights_in_the_profile():
    per_user = WXS.split("<?if $(var.Scope) = perUser ?>")[2]   # bloc d'arborescence (le 1er sert aux défines)
    assert '<Directory Id="LocalAppDataFolder">' in per_user and 'Name="Programs"' in per_user
    assert "ProgramFiles64Folder" not in per_user.split("<?else?>")[0]


# --------------------------------------------------------------------------- #
# sync_arp_version
# --------------------------------------------------------------------------- #


@pytest.mark.skipif(sys.platform != "win32", reason="registre Windows")
def test_sync_arp_version_updates_only_the_per_user_entry(monkeypatch):
    monkeypatch.delenv("ELIUM_NO_ARP_SYNC", raising=False)

    class _Key:
        def __init__(self, values):
            self.values = values

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    store = {
        "{AAA}": _Key({"DisplayName": "Elium (installation utilisateur)", "DisplayVersion": "4.9.0"}),
        "{BBB}": _Key({"DisplayName": "Autre logiciel", "DisplayVersion": "1.0"}),
    }

    class _FakeWinreg:
        HKEY_CURRENT_USER = object()
        KEY_READ, KEY_SET_VALUE, REG_SZ = 1, 2, 1

        @staticmethod
        def OpenKey(parent, name, reserved=0, access=0):  # noqa: N802
            return _Key({}) if name.startswith("Software") else store[name]

        @staticmethod
        def EnumKey(parent, i):  # noqa: N802
            keys = list(store)
            if i >= len(keys):
                raise OSError
            return keys[i]

        @staticmethod
        def QueryValueEx(key, name):  # noqa: N802
            return key.values[name], 1

        @staticmethod
        def SetValueEx(key, name, reserved, typ, value):  # noqa: N802
            key.values[name] = value

    monkeypatch.setitem(sys.modules, "winreg", _FakeWinreg)
    assert updater.sync_arp_version("4.9.3") is True
    assert store["{AAA}"].values["DisplayVersion"] == "4.9.3"
    assert store["{BBB}"].values["DisplayVersion"] == "1.0"      # les autres logiciels ne sont jamais touchés
    assert updater.sync_arp_version("4.9.3") is False             # rien à changer


def test_sync_arp_version_is_inert_by_default_in_tests():
    assert updater.sync_arp_version("1.2.3") is False
