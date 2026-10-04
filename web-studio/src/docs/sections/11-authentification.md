## Authentification

L'authentification du Drive est **sans oracle** : le serveur ne reçoit jamais le mot de passe, ni rien qui lui équivaille. Les routes décrites ici sont sous `/api/auth`.

### Mot de passe et défi Ed25519

Dans le navigateur, Argon2id (t = 3, m = 256 MiB, p = 4) puis HKDF dérivent à partir du mot de passe :

- une **clé d'authentification Ed25519**, dont seule la partie **publique** est enregistrée sur le serveur ;
- une **clé maître**, qui ne quitte jamais le navigateur et chiffre le paquet de clés privées stocké sur le serveur.

La connexion est un **défi-réponse** :

| Étape | Route | Rôle |
|---|---|---|
| 1 | `POST /login/init` | Le serveur émet un défi aléatoire à usage unique |
| 2 | `POST /login/verify` | Le client renvoie la **signature** du défi, le serveur vérifie |
| 3 | `POST /login/mfa` | Seulement si un second facteur est actif |

Tous les échecs de l'étape 2 renvoient le **même message**. Un compte inconnu reçoit de faux paramètres de dérivation, de forme identique à un vrai compte (route `prelogin`). On ne peut donc ni deviner qu'un e-mail existe, ni verrouiller le compte de quelqu'un par essais répétés.

> Limite résiduelle, identique à SRP : si la clé publique d'authentification fuit, une attaque par dictionnaire hors ligne reste possible, au coût d'un Argon2id par essai. C'est ce coût qui protège un mot de passe faible.

### Jetons et sessions

- Jeton d'accès : **15 minutes** (`ACCESS_TOKEN_TTL_SECONDS`).
- Jeton de rafraîchissement : **30 jours** (`REFRESH_TOKEN_TTL_SECONDS`), **renouvelé à chaque usage**, stocké sous forme d'empreinte.
- `POST /logout` révoque la session.
- Les sessions expirées, ou révoquées depuis plus de 7 jours, sont purgées automatiquement.

Les routes `GET /api/users/me/sessions` et `DELETE /api/users/me/sessions/:id` permettent de lister et de révoquer ses sessions. **Aucun écran** ne les expose pour l'instant.

### Changer son mot de passe

L'onglet **Sécurité** propose le changement de mot de passe. La route est `POST /auth/change-password`.

1. Le client demande un défi et le **signe avec l'ancienne clé** : un jeton volé ne suffit pas.
2. Il dérive une **nouvelle clé maître** (nouveau sel) et rechiffre le **même** paquet de clés sous cette clé.
3. Il envoie la nouvelle clé publique d'authentification, avec une preuve de possession, et le paquet rechiffré.
4. Le serveur remplace le tout, **révoque toutes les autres sessions** et en ouvre une nouvelle.

Le serveur ne voit que des clés publiques et un paquet opaque. Les clés d'identité ne changent pas : les fichiers déjà partagés restent lisibles. Le mot de passe fait au moins 8 caractères. Le déverrouillage par clé d'accès doit être **réactivé** ensuite, car il protégeait l'ancienne clé maître. La route est limitée à 10 appels par minute.

Un compte créé par SSO utilise la même route pour fixer la phrase de passe qui protège ses clés.

### Second facteur : TOTP

Mot de passe à usage unique de type RFC 6238, avec enrôlement par QR code.

- Le secret est **chiffré au repos** avec une clé dérivée de `TOKEN_SECRET`.
- Le paquet de clés n'est livré qu'**après** le second facteur : `/login/verify` renvoie un jeton court, `/login/mfa` livre le paquet.
- Dix **codes de secours** à usage unique, stockés sous forme d'empreinte. Ils sont régénérables avec un second facteur valide.
- Désactiver le TOTP exige un second facteur valide.

> Changer `TOKEN_SECRET` rend les secrets TOTP illisibles. Les codes de secours restent utilisables : c'est la seule porte de sortie, puis un nouvel enrôlement.

### Clés d'accès (WebAuthn) comme second facteur

Enrôlement et connexion avec `@simplewebauthn/server` : attestation `none`, compteur anti-clonage, défi à usage unique. La clé d'accès est un second facteur **alternatif** au TOTP. Elle ne remplace pas le mot de passe pour dériver les clés. `WEBAUTHN_RP_ID` doit être le **domaine du Drive**.

### Connexion sans mot de passe par clé d'accès

Une clé d'accès **découvrable** authentifie directement auprès du serveur (`/auth/webauthn/assert/*`). Aucun e-mail n'est transmis, donc rien à énumérer, et la vérification utilisateur est **obligatoire**. La même cérémonie produit le secret **PRF** qui déverrouille les clés localement. Si l'appareil n'a pas d'enregistrement PRF, le mot de passe sert de repli.

### Déverrouillage biométrique local

L'extension **PRF** fait produire à la clé d'accès un secret stable de 32 octets. Une clé dérivée (HKDF-SHA-256) chiffre la clé maître en AES-256-GCM. L'enveloppe vit dans le navigateur et est **inutile sans** l'authentificateur. Le serveur ne voit ni le secret ni l'enveloppe. Activation dans **Sécurité**. La **phrase de passe reste la racine de confiance** : si tous les appareils sont perdus, il faut le mot de passe ou le recouvrement d'organisation.

### SSO (OpenID Connect)

L'administrateur configure, par organisation, l'émetteur (`issuer`), l'identifiant client, les clés publiques (en ligne par `jwksUri`, ou saisies), et les domaines autorisés. L'API vérifie la signature du jeton d'identité (RS256, ES256 ou EdDSA), l'émetteur, l'audience et l'expiration.

- Le jeton est **refusé** si le fournisseur n'a pas vérifié l'e-mail (`email_verified`). Cela ferme une prise de contrôle de compte.
- Le compte doit **déjà exister** et être membre actif de l'organisation. Le `sub` est lié à la première connexion, puis comparé.
- Le téléchargement des clés (`jwksUri`) exige HTTPS, refuse les adresses privées et **ne suit aucune redirection**.
- Route publique : `POST /auth/sso/verify` (20 appels par minute).

**Le SSO prouve l'identité, il ne déverrouille aucune clé.** Le navigateur dérive toujours sa clé maître d'une phrase de passe que le serveur ne voit pas.

### SCIM 2.0

Un **jeton SCIM** par organisation, généré dans l'onglet **SSO et SCIM**, pilote le provisionnement depuis l'annuaire.

| Ressource | Opérations |
|---|---|
| `/scim/v2/Users` | lister, lire, créer (invitation), `PATCH active`, supprimer |
| `/scim/v2/Groups` | lister, lire, créer, remplacer, `PATCH`, supprimer |

- Le **déprovisionnement** suspend l'adhésion : perte d'accès immédiate, SSO et sessions comprises.
- SCIM ne peut pas créer de clés (elles naissent dans le navigateur). Un `POST` crée donc une **invitation**, que la personne finalise en s'inscrivant.
- Les groupes SCIM sont des **métadonnées**, pas des équipes chiffrées. Ils peuvent être associés à un rôle Elium ; le rôle le plus élevé des groupes associés s'applique.
- Rôle par défaut des nouveaux comptes : `editor`, modifiable.

### Limitation de débit

Limite globale de 600 requêtes par minute et par IP, resserrée sur les routes sensibles.

| Route | Appels par minute |
|---|---|
| Inscription | 20 |
| `prelogin` | 30 |
| `login/init` | 25 |
| `login/verify` | 30 |
| `login/mfa` | 20 |
| Rafraîchissement | 60 |
| Changement de mot de passe | 10 |
| Clé d'accès (connexion) | 20 à 30 |
| SSO | 20 |
| SCIM | 100 |
| Relais d'horodatage | 20 |

Avec Redis, les compteurs sont **partagés** entre instances. Voir le chapitre sur le durcissement pour la gestion de l'IP réelle derrière Caddy.

### Limites connues de l'authentification

- Le Drive ne propose **pas de bouton de connexion SSO** : le serveur vérifie le jeton d'identité, mais l'interface n'organise pas la redirection vers le fournisseur. La partie administration (configuration, jeton SCIM) existe.
- Pas de liste de sessions dans l'interface.
- Perdre mot de passe, appareils et recouvrement rend les fichiers définitivement illisibles.
