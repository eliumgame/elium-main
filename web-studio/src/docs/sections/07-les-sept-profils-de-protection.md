## 7. Les sept profils de protection

Les profils sont **additifs et optionnels**. Chacun combine un sous-ensemble des
garanties : chiffrement, mot de passe, verrouillage, suivi (journal), signatures.

| Profil | Chiffré | Mot de passe | Verrouillé | Suivi | Signatures | Ce qu'il garantit |
|---|:---:|:---:|:---:|:---:|:---:|---|
| `standard` | non | non | non | non | non | Document portable simple, aucune protection |
| `signed` | non | non | non | oui | oui | Preuve d'auteur + journal (mais lisible et, si non scellé, altérable) |
| `tracked` | non | non | non | oui | non | Journal chaîné (détection d'altération si scellé), pas de confidentialité |
| `protected` / `encrypted` | oui | oui | non | non | non | Confidentialité du corps (Argon2id + AES-256-GCM) |
| `locked` | non | non | oui | oui | oui | Verrouillage + suivi + signatures (détection d'altération), pas de confidentialité |
| `secure_max` | oui (cascade) | oui | oui | oui | oui | Maximum : cascade AES-256-GCM + ChaCha20, verrouillé, scellé, signé |

Pour qu'un document soit **vérifiable** (intégrité anti-altération réelle), il faut
le **sceller** — c'est le cas des profils `signed`/`locked`/`secure_max`. Un
profil chiffré protège la confidentialité, mais la détection d'altération vient du
sceau, pas du chiffrement.

---
