## 17. Historique d'audit de sécurité

Audit initial **2026-06-10** (revue de code + pentest, 11 scénarios). La
cryptographie de chiffrement était solide, mais les garanties d'**intégrité /
suivi / signature** reposaient sur des données non authentifiées (manifeste,
journal, signatures = entrées ZIP en clair ; `contentHash` non clé). **Correctif
central : le sceau de document Ed25519** (§6.3).

| # | Faille | Sévérité | Statut |
|---|---|:---:|---|
| F-1 | Intégrité non authentifiée (altération silencieuse) | 🔴 | Corrigé (sceau) |
| F-2 | Journal réécrivable sans détection | 🔴 | Corrigé (sceau) |
| F-3 | Signature « valide » forgée ; UX trompeuse | 🔴 | Atténué (sceau + UX « clé non vérifiée ») |
| F-4 | Retrait de signature non détecté | 🔴 | Corrigé (sceau) |
| F-5 | Clé privée Ed25519 en clair dans `localStorage` | 🔴 | Corrigé (chiffrée au repos) |
| F-6 | Usurpation de badge/profil | 🟠 | Corrigé (sceau) |
| F-7 | Fuite métadonnées/PII sur fichier chiffré | 🟠 | Corrigé (chiffrement métadonnées opt-in, §6.4) |
| F-8 | Divergence bornes KDF Web vs Python | 🟠 | Corrigé (bornes alignées) |
| F-9 | ZIP externe sans plafond → DoS mémoire | 🟠 | Corrigé (plafonds 128/384 MiB) |
| F-10 | Robustesse parseur | 🟡 | Corrigé (erreurs typées + garde profondeur) |
| F-11 | Desktop lié à `0.0.0.0` sans en-têtes | 🟠 | Corrigé (`127.0.0.1` + en-têtes) |
| F-12 | Export : liens `javascript:`, injection CSS | 🟡 | Corrigé (filtrage + Blob URL) |

Couvert par `tests/python/test_seal.py` et `web-studio/tests/seal.test.ts`. Des
PoC adversariaux (`security/poc_tamper.py`, `security/poc_dos_spoof.py`) montrent
l'état *avant* le sceau (sur fichier non scellé, `[PWNED]` = l'attaque réussit).

**Signalement d'une vulnérabilité** : **ne pas** ouvrir d'issue publique.
Contactez les mainteneurs par un canal privé ; accusé de réception + calendrier de
correction.

---
