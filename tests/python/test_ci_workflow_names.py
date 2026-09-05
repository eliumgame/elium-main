"""
Garde-fou contre le couplage fragile par NOM entre .github/workflows/ci.yml et
.github/workflows/release.yml.

Contexte : release.yml se déclenche via `on.workflow_run.workflows: ["Elium CI"]`
(voir release.yml:32-36). GitHub Actions ne permet PAS de référencer un workflow
déclencheur autrement que par sa chaîne `name:` (ou, à défaut de `name:`, le nom
de fichier) — le couplage par chaîne est donc une contrainte de la plateforme,
pas un choix de code. Si un jour quelqu'un renomme le `name:` de ci.yml (ou la
chaîne dans release.yml) sans mettre à jour l'autre, release.yml cesse
SILENCIEUSEMENT de se déclencher après un push vert sur master : aucune erreur
visible nulle part, juste plus aucune publication automatique — alors que ce
pipeline distribue les mises à jour à toute la base installée via auto-update.

Approche : PyYAML n'est PAS une dépendance déclarée du projet (ni dans
`dependencies`, ni dans l'extra `dev` de pyproject.toml) — même si l'environnement
de dev l'a parfois installée transitivement, on ne peut pas compter dessus en CI.
On parse donc par regex simple, volontairement minimaliste : on ne cherche que
les deux valeurs qui nous intéressent, pas un YAML général.
"""
from __future__ import annotations

import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
CI_WORKFLOW = REPO_ROOT / ".github" / "workflows" / "ci.yml"
RELEASE_WORKFLOW = REPO_ROOT / ".github" / "workflows" / "release.yml"

# Clé `name:` de premier niveau (colonne 0 — pas le `- name:` indenté d'une step).
_CI_NAME_RE = re.compile(r"^name:\s*(.+?)\s*$", re.MULTILINE)
# `workflows: [...]` sous `on.workflow_run` (seule occurrence attendue du mot-clé
# YAML `workflows:` dans un workflow GitHub Actions).
_RELEASE_WORKFLOWS_RE = re.compile(r"^\s*workflows:\s*\[(.*?)\]", re.MULTILINE)
_QUOTED_ITEM_RE = re.compile(r'"([^"]*)"|\'([^\']*)\'')


def _extract_ci_name(text: str) -> str:
    match = _CI_NAME_RE.search(text)
    assert match, "aucune clé 'name:' de premier niveau trouvée"
    return match.group(1).strip().strip('"').strip("'")


def _extract_release_workflow_run_names(text: str) -> list[str]:
    match = _RELEASE_WORKFLOWS_RE.search(text)
    assert match, "aucune clé 'on.workflow_run.workflows:' trouvée"
    items = _QUOTED_ITEM_RE.findall(match.group(1))
    return [a or b for a, b in items]


# --------------------------------------------------------------------------- #
# Le garde-fou réel : les fichiers du dépôt DOIVENT correspondre exactement.
# --------------------------------------------------------------------------- #

def test_release_workflow_run_matches_ci_name_exactly():
    ci_text = CI_WORKFLOW.read_text(encoding="utf-8")
    release_text = RELEASE_WORKFLOW.read_text(encoding="utf-8")

    ci_name = _extract_ci_name(ci_text)
    release_names = _extract_release_workflow_run_names(release_text)

    assert release_names == [ci_name], (
        "Divergence de couplage par nom entre .github/workflows/ci.yml et "
        ".github/workflows/release.yml : "
        f"ci.yml déclare name: {ci_name!r}, mais release.yml référence "
        f"on.workflow_run.workflows: {release_names!r}. GitHub Actions ne "
        "matche un déclencheur workflow_run QUE par ce nom exact : tant que "
        "cette divergence existe, release.yml ne se déclenchera plus JAMAIS "
        "automatiquement après un push vert sur master, sans aucune erreur "
        "visible (le pipeline qui distribue les mises à jour à toute la base "
        "installée via auto-update reste silencieusement inactif). Corrige "
        "l'un des deux fichiers pour qu'ils correspondent exactement."
    )


# --------------------------------------------------------------------------- #
# Contrôle négatif : prouve que l'extraction ci-dessus détecte VRAIMENT une
# divergence sur du contenu synthétique, plutôt que de toujours matcher par
# accident (un bug de regex qui, par exemple, capturerait le `- name:` d'une
# step au lieu du `name:` de premier niveau rendrait le test principal vert
# EN PERMANENCE, quoi qu'il arrive dans les vrais fichiers — un garde-fou
# vacuously true est pire qu'aucun garde-fou car il inspire une fausse confiance).
# --------------------------------------------------------------------------- #

def test_extraction_helpers_actually_detect_a_divergence():
    ci_text = (
        "name: Elium CI\n"
        "on:\n"
        "  push:\n"
        "    branches: [ main ]\n"
        "jobs:\n"
        "  build:\n"
        "    steps:\n"
        "    - name: Set up Python\n"  # step name indentée : ne doit PAS matcher
        "      run: echo hi\n"
    )
    release_text_matching = (
        "name: Release\n"
        "on:\n"
        "  workflow_run:\n"
        '    workflows: ["Elium CI"]\n'
        "    types: [completed]\n"
    )
    release_text_diverged = (
        "name: Release\n"
        "on:\n"
        "  workflow_run:\n"
        '    workflows: ["Elium CI (renamed)"]\n'
        "    types: [completed]\n"
    )

    ci_name = _extract_ci_name(ci_text)
    assert ci_name == "Elium CI"  # pas "Set up Python" : le premier niveau seul compte

    assert _extract_release_workflow_run_names(release_text_matching) == [ci_name]
    # La même comparaison que le test principal DOIT échouer sur un contenu divergent.
    assert _extract_release_workflow_run_names(release_text_diverged) != [ci_name]


def test_release_workflow_run_workflows_is_not_empty():
    """Si `on.workflow_run.workflows:` devait un jour devenir vide ou disparaître,
    l'assertion d'égalité du test principal échouerait déjà — ce test isole
    explicitement ce cas précis pour un message d'erreur plus direct."""
    release_text = RELEASE_WORKFLOW.read_text(encoding="utf-8")
    assert _extract_release_workflow_run_names(release_text), (
        f"{RELEASE_WORKFLOW} : on.workflow_run.workflows est vide ou introuvable"
    )
