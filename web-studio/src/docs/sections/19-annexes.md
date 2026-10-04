## Annexes

### Glossaire

- **Zéro-connaissance** : le serveur ne détient jamais de clé ni de contenu en clair. Il ne voit que du chiffré et des métadonnées d'autorisation.
- **Chiffrement de bout en bout** : le chiffrement et le déchiffrement ont lieu dans le navigateur de chaque participant.
- **CEK** (clé de contenu) : clé qui chiffre un fichier. Elle est emballée pour chaque destinataire, et pour l'organisation (recouvrement).
- **Nœud** : un fichier ou un dossier du Drive.
- **Emballer une clé** : la chiffrer pour la clé publique d'un destinataire (ECDH-ES sur P-256).
- **Sceau** : signature Ed25519 de l'auteur qui ancre l'intégrité d'un `.elium` (manifeste, signatures, journal).
- **Profil** : combinaison de protections appliquées à un `.elium`.
- **TOFU** : « faire confiance à la première utilisation ». Une clé inconnue est épinglée à sa première rencontre ; un changement ultérieur est signalé.
- **Argon2id** : fonction qui transforme un mot de passe en clé et rend les essais coûteux (mémoire et temps).
- **Ed25519** : algorithme de signature numérique. **P-256** : courbe utilisée pour emballer des clés.
- **Padmé** : rembourrage qui masque la taille réelle d'un contenu.
- **CRDT / Yjs** : structure de données qui permet à plusieurs personnes d'éditer en même temps sans conflit.
- **RBAC** : contrôle d'accès par rôles et permissions.
- **OIDC** : protocole d'identité (OpenID Connect) utilisé pour le SSO. **SCIM** : protocole de provisionnement des comptes depuis un annuaire.
- **WebAuthn / clé d'accès** : connexion par un authentificateur (biométrie, clé de sécurité). **PRF** : extension qui en tire un secret stable pour déverrouiller des clés.
- **PAdES** : signature électronique de PDF reconnue par les lecteurs. **RFC 3161** : horodatage qualifié par un tiers, sur une empreinte.
- **C2PA** : standard de provenance des images (manifeste signé).
- **SBOM** : inventaire des composants logiciels d'une version.
- **cosign** : outil de signature d'images de conteneurs. **Empreinte (digest)** : identifiant `sha256:…` d'une image, qui désigne des octets précis.
- **Canal** : suite de versions suivie par une installation (`stable` ou `bêta`).

### Formats de fichiers

| Extension | Usage |
|---|---|
| `.elium` | Document Elium (texte, tableur, présentation, PDF protégé) : archive ZIP avec manifeste, contenu, signatures et journal |
| `.eliumkey` | Sauvegarde chiffrée du trousseau de clés (format v2) |
| `.eliumshare` | Part d'un partage de secret de Shamir (récupération du trousseau) |
| `.eliumupdate` | Paquet de mise à jour hors ligne, signé |
| `.elium-workspace` | Sauvegarde de l'espace de travail local |
| `.docx`, `.xlsx`, `.pptx` | Import et export Word, Excel, PowerPoint |
| `.pdf` | Ouverture, édition, création, signature |
| `.csv`, `.tsv`, `.txt`, `.md`, `.html` | Import de texte ou de données ; export |
| `.p12`, `.pfx` | Certificat et clé privée pour signer un PDF (PAdES) |
| `.pem`, `.cer`, `.crt`, `.der` | Racines de confiance C2PA ou certificats |
| `.fdf`, `.xfdf` | Commentaires et données de formulaire PDF |
| `.dic` | Dictionnaire personnel du correcteur |
| `.msi` | Installeur Windows : `Elium-<version>-Setup.msi` (tous les utilisateurs) et `Elium-User-<version>.msi` (sans droits administrateur) |
| `.cdx.json` | Inventaire des composants (SBOM CycloneDX) joint à chaque release |

### Variables d'environnement du Drive (fichier .env)

Ces variables sont lues par `docker-compose.yml`.

| Variable | Rôle | Défaut |
|---|---|---|
| `SITE_ADDRESS` | Adresse de Caddy : un domaine active le HTTPS ; `:80` reste local | `:80` |
| `ACME_EMAIL` | Adresse pour Let's Encrypt | vide |
| `TOKEN_SECRET` | Signature des jetons, chiffrement des secrets TOTP (32 caractères au moins) | **obligatoire** |
| `POSTGRES_PASSWORD` | Mot de passe de la base | **obligatoire** |
| `S3_SECRET_KEY` | Mot de passe MinIO / S3 | **obligatoire** |
| `REDIS_PASSWORD` | Mot de passe du Redis intégré | **obligatoire** |
| `CORS_ORIGINS` | Origines autorisées (séparées par des virgules) | **obligatoire** |
| `REDIS_URL` | Redis externe (remplace le Redis intégré) | Redis intégré |
| `STORAGE_DRIVER` | `fs` (volume) ou `s3` | `fs` |
| `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY` | Réglages S3 / MinIO | `http://minio:9000`, `us-east-1`, `elium-blobs`, `elium` |
| `ELIUM_VERSION` | Version déployée, affichée dans `/api/health` (écrite par `install.sh`) | `dev` |
| `ELIUM_API_IMAGE`, `ELIUM_WEB_IMAGE` | Images signées épinglées par empreinte (écrites par la mise à jour automatique) | construction sur place |
| `BACKUP_RCLONE_REMOTE` | Destination `rclone` de la copie hors machine | vide |
| `UPDATE_INTERVAL_MIN` | Intervalle de la mise à jour automatique (minutes). Lue par `install.sh`, pas par Docker | 30 |

### Variables lues par l'API

Le processus de l'API lit ces variables. **Seules celles marquées « oui » sont transmises par `docker-compose.yml`** ; pour les autres, il faut modifier ce fichier (voir les limites de l'exploitation).

| Variable | Rôle | Défaut | Transmise |
|---|---|---|---|
| `TOKEN_SECRET`, `CORS_ORIGINS`, `DATABASE_URL` | Voir plus haut | | oui |
| `STORAGE_DRIVER`, `STORAGE_FS_ROOT`, `S3_*` | Stockage des blobs | `fs`, `./data/blobs` | oui |
| `REDIS_URL` | Relais temps réel et limitation de débit partagés | vide (mode seul) | oui |
| `ELIUM_VERSION`, `NODE_ENV`, `HOST`, `PORT` | Version, mode, adresse d'écoute | `dev`, —, `0.0.0.0`, `8787` | oui |
| `TRUST_PROXY` | Confiance dans `X-Forwarded-For` | proxys privés | non |
| `ACCESS_TOKEN_TTL_SECONDS` | Durée du jeton d'accès | 900 | non |
| `REFRESH_TOKEN_TTL_SECONDS` | Durée du jeton de rafraîchissement | 2 592 000 | non |
| `MAX_BLOB_BYTES` | Taille maximale d'un blob | 2 Gio | non |
| `MAX_JSON_BYTES` | Taille maximale d'un corps JSON | 1 Mio | non |
| `MAX_SIGN_ARTIFACT_BYTES` | Taille maximale d'un document signé renvoyé par lien | 50 Mio | non |
| `MAX_COLLAB_MESSAGE_BYTES` | Taille maximale d'une mise à jour collaborative | 512 Kio | non |
| `MAX_COLLAB_MESSAGES_PER_SEC` | Débit maximal par connexion | 300 | non |
| `MAX_COLLAB_CONNECTIONS_PER_USER` | Connexions collaboratives simultanées par compte | 40 | non |
| `WEBAUTHN_RP_ID`, `WEBAUTHN_RP_NAME` | Domaine et nom pour les clés d'accès | `localhost`, `Elium Drive` | non |
| `RUN_MIGRATIONS` | `false` pour ne pas jouer les migrations au démarrage | actif | non |

### Variables de l'application de bureau et des outils

| Variable | Rôle |
|---|---|
| `ELIUM_NO_UPDATE=1` | Désactive toute mise à jour (application de bureau, et passe `self-update` du serveur) |
| `ELIUM_UPDATE_CHANNEL` | Force le canal : `stable` ou `beta` |
| `ELIUM_NO_BROWSER=1` | Lance le serveur local seul, sans fenêtre (tests, usage avancé) |
| `ELIUM_WEB_DIR` | Sert un autre dossier d'interface que celui embarqué |
| `ELIUM_UPDATE_MANIFEST_URL` | URL de manifeste imposée (tests) |
| `ELIUM_NO_HANDOFF=1`, `ELIUM_NO_ARP_SYNC=1`, `ELIUM_CURRENT_VERSION` | Réservées aux tests de l'installeur |
| `ELIUM_KEYS_DIR` | Dossier du trousseau de la ligne de commande (`~/.elium/keys` par défaut) |
| `UPDATE_SIGNING_KEY` | Clé privée de signature des releases : **secret du CI uniquement**, jamais sur un poste ni un serveur |
| `SIGN_CERT`, `SIGN_CERT_PASSWORD` | Certificat Authenticode (secrets du CI, facultatifs, inactifs sans certificat) |
| `PW_CHROMIUM` | Chemin d'un Chromium déjà installé pour Playwright |

### Routes internes du lanceur (/__*)

L'application de bureau sert l'interface sur `127.0.0.1` et expose quelques routes internes, jamais accessibles depuis Internet.

Protections communes :

- **GET** : le contrôle d'**hôte** refuse tout nom autre que `127.0.0.1` ou `localhost` avec le bon port (contre le DNS rebinding).
- **POST** : en plus, un **jeton de session** (en-tête `X-Elium-Token`, fourni à la page dans une balise `<meta>`) et un contrôle d'**origine**. Au plus 6 appels par fenêtre de 10 secondes (40 pour les polices).

| Route | Méthode | Rôle |
|---|---|---|
| `/__open__` | GET | Fichier `.elium` passé en argument à l'ouverture |
| `/__open_seq__` | GET | Compteur des ouvertures (pour réagir à un nouveau fichier) |
| `/__update__` | GET | État de la mise à jour |
| `/__version__` | GET | Version installée, de base, dernière publiée |
| `/__releases__` | GET | Liste des versions pour le retour en arrière |
| `/__ports__` | GET | Port courant, port configuré, état des ports voisins |
| `/__elium_update.js`, `/__elium_update.css` | GET | Carte de mise à jour (fichiers externes, à cause de la CSP) |
| `/__update__/start` | POST | Lance la mise à jour |
| `/__update__/check` | POST | Vérification manuelle |
| `/__update__/channel?name=` | POST | Choisit le canal |
| `/__update__/bundle` | POST | Reçoit un paquet `.eliumupdate` (420 Mio au plus), vérifié ensuite par signature |
| `/__update__/restart` | POST | Redémarre l'application |
| `/__rollback__?version=` | POST | Retour à une version précédente |
| `/__rollback__/undo` | POST | Annule le dernier retour |
| `/__ports__/set` | POST | Change le port de lancement |
| `/__tsa__` | POST | Relais d'horodatage RFC 3161 (8 Kio en entrée, 64 Kio en sortie, 15 s, adresses publiques) |
| `/__keystore__/wrap`, `/__keystore__/unwrap` | POST | Protection par Windows (DPAPI), Windows seulement |
| `/__fetch_font__` | POST | Relais de polices : liste fermée d'adresses (Fontsource, jsDelivr) |

### Licence

Elium est publié sous licence **MIT**. Voir le fichier `LICENSE` à la racine du dépôt.
