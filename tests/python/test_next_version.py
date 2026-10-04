"""Tests de scripts/next_version.py : bump automatique depuis les commits conventionnels."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))

import next_version as nv  # noqa: E402


@pytest.mark.parametrize(
    "message,expected",
    [
        ("feat: nouvelle fonction", "minor"),
        ("feat(pdf): signature visible", "minor"),
        ("fix: corrige la signature", "patch"),
        ("fix(updater): boucle", "patch"),
        ("perf: plus rapide", "patch"),
        ("refactor(core): simplifie", "patch"),
        ("security: durcit le CSP", "patch"),
        ("feat!: change le format", "major"),
        ("fix(api)!: retire un champ", "major"),
        ("feat: x\n\nBREAKING CHANGE: le format change", "major"),
        ("chore: bump deps", None),
        ("docs: lisez-moi", None),
        ("ci: épingle les actions", None),
        ("test: couvre le cas", None),
        ("Merge branch 'x' into master", None),
        ("Revert \"feat: y\"", None),
        ("Corrige un bug d'affichage", "patch"),   # sujet libre non conventionnel : publiable
        ("", None),
    ],
)
def test_classify_commit(message, expected):
    assert nv.classify_commit(message) == expected


def test_required_bump_takes_the_highest_level():
    assert nv.required_bump(["fix: a", "feat: b", "chore: c"]) == "minor"
    assert nv.required_bump(["fix: a", "feat!: b"]) == "major"
    assert nv.required_bump(["chore: a", "docs: b"]) is None


def test_auto_bump_from_commits():
    assert nv.next_version("4.9.0", ["fix: a"]) == "4.9.1"
    assert nv.next_version("4.9.0", ["feat: a", "fix: b"]) == "4.10.0"
    assert nv.next_version("4.9.7", ["feat!: a"]) == "5.0.0"
    assert nv.next_version("4.9.0", ["fix: a"], bump="minor") == "4.10.0"   # niveau forcé


def test_nothing_to_release_is_explicit_not_silent():
    with pytest.raises(nv.NothingToRelease):
        nv.next_version("4.9.0", ["chore: x", "docs: y"])
    with pytest.raises(nv.NothingToRelease):
        nv.next_version("4.9.0", [])
    # un niveau forcé publie quand même (décision humaine)
    assert nv.next_version("4.9.0", [], bump="patch") == "4.9.1"


def test_prerelease_counter_follows_existing_tags():
    assert nv.next_version("4.9.0", ["feat: a"], pre="rc") == "4.10.0-rc1"
    tags = ["v4.9.0", "v4.10.0-rc1", "v4.10.0-rc2"]
    assert nv.next_version("4.9.0", ["feat: a"], pre="rc", existing_tags=tags) == "4.10.0-rc3"
    # autre étiquette : compteur indépendant
    assert nv.next_version("4.9.0", ["feat: a"], pre="beta", existing_tags=tags) == "4.10.0-beta1"


def test_prerelease_is_promoted_to_final_without_pre():
    assert nv.next_version("4.10.0-rc2", ["fix: z"]) == "4.10.0"
    assert nv.next_version("4.10.0-rc2", []) == "4.10.0"      # promotion : pas besoin de nouveau commit


def test_prerelease_continues_same_label():
    assert nv.next_version("4.10.0-rc1", [], pre="rc", existing_tags=["v4.10.0-rc1"]) == "4.10.0-rc2"
    assert nv.next_version("4.10.0-rc9", [], pre="rc") == "4.10.0-rc10"


def test_invalid_versions_are_rejected():
    with pytest.raises(ValueError):
        nv.next_version("not-a-version", ["fix: a"])
    with pytest.raises(ValueError):
        nv.next_version("4.9", ["fix: a"])


def test_last_release_tag_ignores_prereleases():
    tags = ["v4.8.1", "v4.9.0", "v4.10.0-rc1", "v4.9.1"]
    assert nv.last_release_tag(tags) == "v4.9.1"
    assert nv.last_release_tag(["v4.10.0-rc1"]) is None
    assert nv.last_release_tag([]) is None


def test_version_regex_accepts_prerelease_tags_used_by_the_release_workflow():
    assert nv.parse_version("v4.7.0-rc1") == (4, 7, 0, "rc1")
    assert nv.parse_version("4.7.0") == (4, 7, 0, "")


def test_cli_prints_the_version_and_exit_codes(monkeypatch, capsys):
    monkeypatch.setattr(nv, "git_tags", lambda: ["v4.9.0"])
    monkeypatch.setattr(nv, "commits_since", lambda tag: ["feat: x"])
    assert nv.main(["--current", "4.9.0"]) == 0
    assert capsys.readouterr().out.strip() == "4.10.0"
    monkeypatch.setattr(nv, "commits_since", lambda tag: ["chore: x"])
    assert nv.main(["--current", "4.9.0"]) == 3
    assert "rien à publier" in capsys.readouterr().err
    assert nv.main(["--current", "oops"]) == 2
