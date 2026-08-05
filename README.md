# Elium

Suite bureautique **chiffrée, signée et scellée**, *local-first*, au format ouvert
`.elium` — Documents, Tableur, Présentations, PDF — plus un **Drive d'entreprise**
zéro-connaissance avec co-édition temps réel.

- **Chiffrement** : Argon2id + AES-256-GCM (cascade ChaCha20-Poly1305 en profil
  `secure_max`), multi-destinataires ECDH-ES P-256.
- **Preuve** : sceau et signatures **Ed25519**, journal à intégrité chaînée.
- **Interopérable** : cœur Python (`src/elium/`) et Web Studio TypeScript
  (`web-studio/`) byte-for-byte via JSON canonique.
- **Drive entreprise** : RBAC granulaire, partage & liens, SSO/SCIM, passkeys
  (WebAuthn + PRF), recouvrement d'organisation — le serveur ne voit que du chiffré.

## 📖 Documentation

**Toute la documentation vit désormais dans l'application**, sur une page unique et
complète : ouvre Elium → bouton **Documentation** (icône livre, en haut de
l'accueil). Elle couvre l'installation, le déploiement du Drive, le format, la
cryptographie, la sécurité, chaque module, l'authentification, le RGPD, la
contribution et le journal des versions.

## Démarrage rapide (développement)

```bash
# Web Studio (éditeurs + Drive)
cd web-studio && npm ci && npm run dev      # http://localhost:3100

# Cœur Python + CLI
pip install -e ".[dev]"
pytest tests/python

# Serveur Drive (optionnel — voir la page Documentation pour le déploiement)
cd server && npm ci && npm run dev
```

Tests : `npx vitest run` (web-studio & server) · `pytest tests/python`.
Lint : `npm run lint` (web/server) · `ruff check src/ tests/`.

## Licence

Voir [LICENSE](LICENSE).
