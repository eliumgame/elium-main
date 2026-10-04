## 19. Annexes

### 19.1 Référence de configuration (Drive `.env`)

| Variable | Rôle | Défaut |
|---|---|---|
| `SITE_ADDRESS` | Adresse Caddy (domaine → HTTPS auto ; `:80` → local) | `:80` |
| `TOKEN_SECRET` | Signature des jetons **et** chiffrement des secrets MFA au repos (≥ 32 car. en prod) | *(généré)* |
| `POSTGRES_PASSWORD` | Mot de passe Postgres | *(généré)* |
| `CORS_ORIGINS` | Origines navigateur autorisées (CSV) | origine du site |
| `ELIUM_VERSION` | Version déployée, exposée à `/api/health` (écrite par install.sh) | *(généré)* |
| `UPDATE_INTERVAL_MIN` | Intervalle de l'auto-update serveur (minutes) | `30` |
| `STORAGE_DRIVER` | `fs` (volume) ou `s3` (MinIO/S3) | `fs` |
| `S3_ACCESS_KEY` / `S3_SECRET_KEY` / `S3_BUCKET` | Identifiants + bucket S3 | `elium` / *(généré)* / `elium-blobs` |
| `TRUST_PROXY` | Surcharge de la confiance XFF (défaut : proxys privés/loopback) | *(auto)* |
| `RUN_MIGRATIONS` | Migrations au démarrage | `true` |

Variables API surchargeables (service `api`) : `PORT` (8787), `HOST` (0.0.0.0),
`ACCESS_TOKEN_TTL_SECONDS` (900), `REFRESH_TOKEN_TTL_SECONDS` (2592000),
`MAX_BLOB_BYTES` (2 Gio), `MAX_JSON_BYTES` (1 Mio),
`MAX_SIGN_ARTIFACT_BYTES` (50 Mio — plafond de l'artefact de signature à
distance renvoyé par `POST /api/links/:token/sign`), `S3_ENDPOINT`, `S3_REGION`,
`S3_FORCE_PATH_STYLE`, `WEBAUTHN_RP_ID`, plafonds collab
(`MAX_COLLAB_MESSAGE_BYTES`, `MAX_COLLAB_MESSAGES_PER_SEC`,
`MAX_COLLAB_CONNECTIONS_PER_USER`).

### 19.2 Glossaire express

- **Zéro-connaissance** : le serveur ne détient jamais de clé ni de contenu en
  clair ; il ne voit que du chiffré et des métadonnées d'autorisation.
- **CEK** (Content Encryption Key) : clé de contenu d'un nœud, emballée vers chaque
  destinataire (et vers la clé d'org pour le recouvrement).
- **Sceau** : signature Ed25519 de l'auteur ancrant l'intégrité (manifeste +
  signatures + journal).
- **Profil** : combinaison de protections appliquées à un `.elium` (§7).
- **Padmé / PURB** : schéma de rembourrage qui masque la taille réelle du contenu.
- **PRF (WebAuthn)** : extension permettant à une passkey de dériver un secret
  stable servant à déverrouiller localement la clé maître.

### 19.3 Licence

MIT.
