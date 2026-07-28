"""Tests de installer/changelog.py — l'historique porté par le manifeste signé."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "installer"))

import changelog  # noqa: E402


class TestVersionOrdering:
    def test_compare_par_segment_numerique(self):
        assert changelog.is_newer("4.1.33", "4.1.32")
        assert changelog.is_newer("4.2.0", "4.1.99")
        assert not changelog.is_newer("4.1.32", "4.1.32")
        assert not changelog.is_newer("4.1.2", "4.1.10")  # pas de comparaison lexicale

    def test_prefixe_v_et_suffixes_ignores(self):
        assert changelog.version_tuple("v4.1.33") == changelog.version_tuple("4.1.33")
        assert changelog.is_newer("v4.1.33", "4.1.32")
        # Une préversion reste ANTÉRIEURE à sa release finale, et le tuple garde
        # une longueur fixe : sinon (4,1,33,0) passerait pour plus grand que (4,1,33).
        assert changelog.version_tuple("4.1.33-rc1") == (4, 1, 33, 0)
        assert changelog.version_tuple("4.1.33") == (4, 1, 33, 1)
        assert changelog.is_newer("4.1.33", "4.1.33-rc1")
        assert not changelog.is_newer("4.1.33-rc1", "4.1.33")

    def test_version_vide_ne_leve_pas(self):
        assert changelog.version_tuple("") == (0, 0, 0, 1)
        assert changelog.is_newer("1.0.0", "")

    def test_meme_semantique_que_le_telechargeur(self):
        # Les deux DOIVENT s'accorder : la carte trie l'historique avec l'un et
        # le téléchargeur décide de télécharger avec l'autre.
        import updater

        for a, b in [("4.1.33", "4.1.32"), ("4.1.33", "4.1.33"), ("4.1.33-rc1", "4.1.33"),
                     ("v4.2.0", "4.1.99"), ("4.1.2", "4.1.10")]:
            assert changelog.is_newer(a, b) == updater.is_newer(a, b), (a, b)


class TestSubjectCleaning:
    def test_garde_la_premiere_ligne(self):
        msg = "Documents : légendes auto-numérotées\n\nUn corps détaillé.\n"
        assert changelog.clean_subject(msg) == "Documents : légendes auto-numérotées"

    def test_ecarte_un_sujet_qui_est_un_trailer(self):
        assert changelog.clean_subject("Co-Authored-By: Quelqu'un <a@b.c>") == ""

    def test_bruit_de_plomberie_ecarte(self):
        for noisy in [
            "Merge branch 'master'", "Revert \"x\"", "wip", "chore: deps",
            "ci: cache node", "docs: readme", "bump version", "4.1.32", "v4.1.32",
            "fixup! quelque chose", "lint", "tests: ajoute un cas",
        ]:
            assert changelog.is_noise(noisy), noisy

    def test_vraies_nouveautes_conservees(self):
        for real in [
            "Documents : légendes auto-numérotées et table des illustrations",
            "Tableur : Y.Text par cellule",
            "Corrige un plantage de la barre d'état",
        ]:
            assert not changelog.is_noise(real), real

    def test_documentation_seule_est_du_bruit_mais_pas_un_mot_en_doc(self):
        assert changelog.is_noise("docs : mise à jour")
        # « Documents » commence par « doc » sans être un commit de documentation.
        assert not changelog.is_noise("Documents : renvois")


class TestHumanize:
    def test_traduit_la_portee_en_langue_du_produit(self):
        assert changelog.humanize_subject("feat(documents): styles nommés") == "Documents : styles nommés"
        assert changelog.humanize_subject("feat(pdf): redaction") == "PDF : redaction"
        assert changelog.humanize_subject("fix(ui): contraste") == "Interface : contraste"

    def test_ecarte_la_plomberie_meme_avec_un_type_utile(self):
        # `fix` est un type utile mais la portée `ci` reste de la plomberie.
        assert changelog.humanize_subject("fix(ci): lockfile régénéré") == ""
        assert changelog.humanize_subject("chore(deps): bump") == ""
        assert changelog.humanize_subject("docs: readme") == ""

    def test_sans_portee_on_garde_le_sujet_capitalise(self):
        assert changelog.humanize_subject("fix: corrige le zoom") == "Corrige le zoom"

    def test_portee_inconnue_conservee_telle_quelle(self):
        assert changelog.humanize_subject("feat(widgets): tri") == "Widgets : tri"

    def test_message_non_conventionnel_intact_mais_capitalise(self):
        assert changelog.humanize_subject("Documents : légendes") == "Documents : légendes"
        assert changelog.humanize_subject("corrige un plantage") == "Corrige un plantage"

    def test_sujet_vide_ou_tronque(self):
        assert changelog.humanize_subject("") == ""
        assert changelog.humanize_subject("feat(documents):") == ""


class TestParseLog:
    SEP = "\x1e"

    def test_extrait_les_sujets_utiles(self):
        raw = self.SEP.join([
            "Documents : légendes\n\ncorps",
            "chore: deps",
            "Tableur : tri des colonnes",
            "Merge branch 'x'",
            "feat(pdf): signature PAdES",
            "fix(ci): lockfile",
        ])
        assert changelog.parse_log(raw) == [
            "Documents : légendes", "Tableur : tri des colonnes", "PDF : signature PAdES",
        ]

    def test_dedoublonne_sans_tenir_compte_de_la_casse(self):
        raw = self.SEP.join(["Corrige le zoom", "corrige le zoom", "Corrige le zoom"])
        assert changelog.parse_log(raw) == ["Corrige le zoom"]

    def test_entree_vide(self):
        assert changelog.parse_log("") == []
        assert changelog.parse_log(self.SEP * 5) == []


class TestHistory:
    def test_ordre_decroissant_et_fusion(self):
        previous = [
            {"version": "4.1.31", "date": "2026-07-20", "changes": ["Ancienne"]},
            {"version": "4.1.32", "date": "2026-07-26", "changes": ["Styles nommés"]},
        ]
        entries = [{"version": "4.1.33", "date": "2026-07-27", "changes": ["Légendes"]}]
        merged = changelog.merge_history(entries, previous)
        assert [e["version"] for e in merged] == ["4.1.33", "4.1.32", "4.1.31"]

    def test_la_source_fraiche_ecrase_le_passe(self):
        previous = [{"version": "4.1.33", "date": "2026-07-01", "changes": ["Provisoire"]}]
        entries = [{"version": "4.1.33", "date": "2026-07-27", "changes": ["Définitif"]}]
        merged = changelog.merge_history(entries, previous)
        assert merged[0]["changes"] == ["Définitif"]
        assert merged[0]["date"] == "2026-07-27"

    def test_borne_le_nombre_d_entrees(self):
        entries = [{"version": f"4.1.{i}", "date": "", "changes": [f"c{i}"]} for i in range(30)]
        assert len(changelog.merge_history(entries, keep=5)) == 5
        # On garde bien les plus RÉCENTES.
        assert changelog.merge_history(entries, keep=5)[0]["version"] == "4.1.29"

    def test_ignore_les_entrees_sans_version(self):
        merged = changelog.merge_history([{"version": "", "changes": ["x"]}, {"changes": ["y"]}])
        assert merged == []

    def test_normalise_la_date_et_purge_les_lignes_vides(self):
        merged = changelog.merge_history(
            [{"version": "v4.1.33", "date": "2026-07-27T21:30:00Z", "changes": ["  a  ", "", "   "]}]
        )
        assert merged[0] == {"version": "4.1.33", "date": "2026-07-27", "changes": ["a"]}


class TestChangesSince:
    HISTORY = [
        {"version": "4.1.33", "date": "2026-07-27", "changes": ["Légendes", "Table des illustrations"]},
        {"version": "4.1.32", "date": "2026-07-26", "changes": ["Styles nommés"]},
        {"version": "4.1.31", "date": "2026-07-20", "changes": ["Auto-update serveur"]},
    ]

    def test_ne_rend_que_le_strictement_plus_recent(self):
        got = changelog.changes_since(self.HISTORY, "4.1.31")
        assert [e["version"] for e in got] == ["4.1.33", "4.1.32"]

    def test_trois_versions_de_retard_donnent_tout(self):
        got = changelog.changes_since(self.HISTORY, "4.1.30")
        assert [e["version"] for e in got] == ["4.1.33", "4.1.32", "4.1.31"]

    def test_a_jour_ne_donne_rien(self):
        assert changelog.changes_since(self.HISTORY, "4.1.33") == []
        assert changelog.changes_since(self.HISTORY, "4.2.0") == []

    def test_sans_version_locale_on_rend_tout(self):
        assert len(changelog.changes_since(self.HISTORY, "")) == 3

    def test_limite(self):
        assert len(changelog.changes_since(self.HISTORY, "4.0.0", limit=2)) == 2

    def test_historique_desordonne_est_retrie(self):
        shuffled = [self.HISTORY[1], self.HISTORY[2], self.HISTORY[0]]
        got = changelog.changes_since(shuffled, "4.1.30")
        assert [e["version"] for e in got] == ["4.1.33", "4.1.32", "4.1.31"]


class TestFlattenAndSummarize:
    ENTRIES = [
        {"version": "4.1.33", "date": "", "changes": ["Légendes", "Table des illustrations"]},
        {"version": "4.1.32", "date": "", "changes": ["Styles nommés", "légendes"]},
    ]

    def test_aplatit_sans_doublon(self):
        assert changelog.flatten_changes(self.ENTRIES) == [
            "Légendes", "Table des illustrations", "Styles nommés",
        ]

    def test_limite_l_aplatissement(self):
        assert changelog.flatten_changes(self.ENTRIES, limit=2) == ["Légendes", "Table des illustrations"]

    def test_resume_accorde_les_pluriels(self):
        assert changelog.summarize(self.ENTRIES) == "2 versions, 3 nouveautés"
        une = [{"version": "4.1.33", "date": "", "changes": ["Seule"]}]
        assert changelog.summarize(une) == "1 version, 1 nouveauté"

    def test_resume_vide_quand_il_n_y_a_rien(self):
        assert changelog.summarize([]) == ""
        assert changelog.summarize([{"version": "4.1.33", "date": "", "changes": []}]) == ""


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-v"]))


class TestUpdaterIntegration:
    """release_notes() est le point de jonction manifeste → carte."""

    HISTORY = [
        {"version": "4.1.34", "date": "2026-07-27", "changes": ["Légendes"]},
        {"version": "4.1.33", "date": "2026-07-26", "changes": ["Styles nommés"]},
    ]

    def test_reduit_l_historique_a_ce_qui_manque(self):
        import updater

        manifest = {"version": "4.1.34", "history": self.HISTORY}
        got = updater.release_notes(manifest, local_version="4.1.33")
        assert [e["version"] for e in got] == ["4.1.34"]

    def test_retombe_sur_changes_quand_il_n_y_a_pas_d_historique(self):
        import updater

        # Manifeste antérieur au champ `history` : mieux vaut annoncer la liste
        # brute que de n'afficher aucune information.
        manifest = {"version": "4.1.34", "pubDate": "2026-07-27T10:00:00Z", "changes": ["Une nouveauté"]}
        got = updater.release_notes(manifest, local_version="4.1.33")
        assert got == [{"version": "4.1.34", "date": "2026-07-27", "changes": ["Une nouveauté"]}]

    def test_manifeste_sans_notes_ne_leve_pas(self):
        import updater

        assert updater.release_notes({"version": "4.1.34"}, local_version="4.1.33") == []
        assert updater.release_notes({}, local_version="") == []

    def test_le_statut_publie_les_nouveautes_et_les_conserve(self):
        import updater

        releases = [{"version": "4.1.34", "date": "2026-07-27", "changes": ["Légendes"]}]
        updater._publish("available", version="4.1.34", kind="web",
                         releases=releases, summary="1 version, 1 nouveauté")
        assert updater.get_status()["summary"] == "1 version, 1 nouveauté"
        # Le téléchargement ne doit pas effacer ce que la carte affiche déjà.
        updater._publish("downloading", version="4.1.34", kind="web", progress=42)
        st = updater.get_status()
        assert st["progress"] == 42
        assert st["releases"] == releases
        assert st["summary"] == "1 version, 1 nouveauté"


class TestCliOutput:
    """La CLI est ce que le CI appelle : son échec bloquait toute la publication."""

    def test_cree_le_dossier_de_sortie_absent(self, tmp_path):
        # En CI, `dist/` n'existe pas encore quand cette étape tourne : sans mkdir,
        # l'écriture levait FileNotFoundError et `set -e` tuait la release.
        out = tmp_path / "dist" / "changelog.json"
        assert not out.parent.exists()
        rc = changelog._main(["--version", "4.1.99", "--since", "", "--out", str(out)])
        assert rc == 0
        assert out.is_file()
        data = json.loads(out.read_text(encoding="utf-8"))
        assert "changes" in data and "history" in data

    def test_ecrit_dans_le_dossier_courant_sans_prefixe(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        rc = changelog._main(["--version", "4.1.99", "--since", "", "--out", "changelog.json"])
        assert rc == 0
        assert (tmp_path / "changelog.json").is_file()

    def test_manifeste_precedent_illisible_ne_leve_pas(self, tmp_path):
        out = tmp_path / "d" / "cl.json"
        rc = changelog._main([
            "--version", "4.1.99", "--since", "", "--out", str(out),
            "--prev-manifest", str(tmp_path / "absent.json"),
        ])
        assert rc == 0
        assert out.is_file()
