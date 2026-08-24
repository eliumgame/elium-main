"""
Health-check post-publication d'une GitHub Release Elium.

Lancé par `.github/workflows/release.yml` juste après `gh release create`, sur
le tag qui vient d'être publié. Réutilise le CLIENT réel plutôt que de
réinventer une vérification séparée :

  - `updater.fetch_manifest_for(version)` fait EXACTEMENT ce qu'un poste
    utilisateur ferait pour un rollback vers cette version précise :
    téléchargement de `latest.json` + `.sig` depuis l'URL ÉPINGLÉE sur ce tag
    (jamais l'alias `releases/latest/...`), vérification Ed25519 avec la même
    clé publique embarquée (`UPDATE_PUBLIC_KEY_HEX`), retry réseau transitoire
    inclus (`updater._http_get`).
  - Chaque artefact annoncé (exe/web/msi) est ensuite retéléchargé et son
    sha256 comparé à celui du manifeste signé (même vérification que
    `_download_verified` côté client).

Comme on cible toujours la version PASSÉE EN ARGUMENT (jamais "latest"), ce
script ne rouvre jamais la course de résolution corrigée dans
`_resolve_latest_asset_urls` (commit 4cf9654) : chaque tentative — y compris
les reprises ci-dessous pour la propagation CDN — porte sur le même tag fixe.

Reprises spécifiques à ce contexte CI (distinctes du retry interne de
`_http_get`) : juste après `gh release create`, les URLs de téléchargement des
assets peuvent 404 quelques secondes tant que le CDN de GitHub n'a pas
propagé sur tous ses points de présence — un phénomène déjà documenté dans
`updater.py` (cf. `_resolve_latest_asset_urls`) pour la résolution de tag, qui
s'applique aussi à la disponibilité brute d'un asset frais. On retente donc le
contrôle complet plusieurs fois avec un délai avant de conclure à un échec.

Ne modifie rien et ne supprime jamais de release : sortie 0 (succès) ou 1
(échec). La décision de NE PAS automatiser de rollback/suppression sur échec
est documentée dans `.github/workflows/release.yml` (étape "Vérifier la
publication").
"""
from __future__ import annotations

import hashlib
import sys
import time
from pathlib import Path

# installer/ n'est pas un package : on l'ajoute au chemin d'import (même
# pattern que tests/python/test_updater.py).
sys.path.insert(0, str(Path(__file__).resolve().parent))

import updater  # noqa: E402

# Reprises pour absorber une propagation CDN incomplète juste après la
# publication (distinct du retry réseau interne de `updater._http_get`, qui
# lui gère les pannes transitoires d'UNE requête). Cible toujours la MÊME
# version : jamais de nouvelle résolution de "latest" entre deux passages.
_CI_PROPAGATION_ATTEMPTS = 5
_CI_PROPAGATION_DELAY_S = 10


def _check_once(version: str) -> tuple[bool, str]:
    """Une passe complète de vérification. (ok, raison_si_échec)."""
    manifest = updater.fetch_manifest_for(version)
    if not manifest:
        return False, f"manifeste v{version} introuvable ou signature invalide"
    if str(manifest.get("version", "")) != version:
        return False, (
            f"version du manifeste ({manifest.get('version')!r}) != tag publié ({version!r})"
        )

    artifacts = manifest.get("artifacts") or {}
    if not artifacts:
        return False, "manifeste sans artefact"

    for kind, art in artifacts.items():
        url = art.get("url")
        expected = str(art.get("sha256", "")).lower()
        size = int(art.get("size", 0) or 0)
        if not url or not expected:
            return False, f"{kind}: entrée d'artefact incomplète dans le manifeste"
        try:
            # Marge sur la borne de taille : on connaît déjà la taille annoncée
            # (signée), la marge ne sert qu'à détecter un artefact TRONQUÉ ou
            # GONFLÉ par rapport à ce que le manifeste promet.
            data = updater._http_get(url, size + 4096)
        except Exception as exc:  # noqa: BLE001 - on rapporte, on ne masque rien
            return False, f"{kind}: téléchargement échoué ({exc})"
        digest = hashlib.sha256(data).hexdigest()
        if digest != expected:
            return False, f"{kind}: sha256 {digest} != attendu {expected}"
        print(f"  [ok]   {kind}: {art.get('name')} ({len(data)} o, sha256 vérifié)")

    return True, ""


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: verify_release.py <version>", file=sys.stderr)
        return 2
    version = sys.argv[1].lstrip("vV")

    last_reason = ""
    for attempt in range(1, _CI_PROPAGATION_ATTEMPTS + 1):
        ok, reason = _check_once(version)
        if ok:
            print(
                f"[ok]   v{version} : manifeste signé valide, artefacts vérifiés "
                f"(tentative {attempt}/{_CI_PROPAGATION_ATTEMPTS})"
            )
            return 0
        last_reason = reason
        if attempt < _CI_PROPAGATION_ATTEMPTS:
            print(
                f"  [warn] {reason} — nouvelle tentative {attempt + 1}/{_CI_PROPAGATION_ATTEMPTS} "
                f"dans {_CI_PROPAGATION_DELAY_S}s (propagation CDN possible)"
            )
            time.sleep(_CI_PROPAGATION_DELAY_S)

    print(f"[FAIL] v{version} : {last_reason}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
