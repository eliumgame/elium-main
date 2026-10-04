## 8. Modèle de sécurité et de menace

**Actifs protégés** : confidentialité (profils chiffrés), intégrité (ancrée par le
sceau), authenticité d'auteur (preuve Ed25519 optionnelle).

| Adversaire | Couvert ? | Mécanisme |
|---|:---:|---|
| Lecteur sans mot de passe (profil chiffré) | ✅ | Argon2id + AES-256-GCM |
| Altération d'un fichier **scellé** (contenu/journal/signatures/profil) | ✅ | Le sceau Ed25519 casse |
| Altération d'un fichier **non scellé** | ⚠️ corruption seule | `contentHash` non clé → **scellez** |
| Altération d'un document signé | ✅ | `signedContentHash` ≠ empreinte ⇒ `modified` |
| Falsification de signature | ✅ | Vérif Ed25519 ⇒ `invalid` |
| Réécriture du journal (fichier **non scellé**) | ❌ | Chaîne de hash cohérente si réécrite en entier → **scellez** |
| Usurpation d'identité affichée | ⚠️ | Ed25519 ne s'attribue qu'avec une **clé de confiance** vérifiée hors bande |
| DoS (KDF / zip bomb) | ✅ | Bornes alignées + plafonds de décompression/ZIP |

**Hors périmètre** : poste compromis (malware, keylogger, lecture de la RAM), mot
de passe faible (Argon2id ralentit mais n'empêche pas le cassage hors-ligne),
non-répudiation qualifiée (eIDAS → prestataire qualifié), PKI (pas d'autorité de
certification), métadonnées du manifeste en clair par défaut.

**Hypothèses** : la clé publique attendue est obtenue par un canal de confiance ;
les bibliothèques cryptographiques sont sûres ; le poste n'est pas compromis.

### Ce qu'Elium n'est PAS

- **Pas une PKI** : la confiance s'établit hors bande (on fournit la clé publique
  attendue) ou par épinglage TOFU (`sign/seal-pinning.ts`). Pas d'autorité de
  certification.
- **Pas de signature électronique qualifiée eIDAS** : la preuve Ed25519 atteste
  qu'un détenteur de la clé a signé un état donné du document ; ce n'est pas une
  signature qualifiée (qui nécessite un prestataire de services de confiance
  qualifié).
- **La confidentialité n'existe que pour les profils chiffrés.** Un `.elium` non
  chiffré peut être lu par n'importe qui.

---
