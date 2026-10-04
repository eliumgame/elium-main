## Authentification

### Mot de passe (zéro-connaissance, sans oracle)

Le mot de passe ne quitte **jamais** le navigateur. Argon2id (t=3, m=256 MiB, p=4)
puis HKDF dérivent :

- une **clé Ed25519 d'authentification** (seule sa clé **publique** est enregistrée
  côté serveur) ;
- une **clé maître** (jamais transmise) qui chiffre le bundle de clés privées
  stocké côté serveur.

**Login = défi-réponse** : `/auth/login/init` émet un défi aléatoire à usage
unique ; le client le **signe** (Ed25519) ; `/auth/login/verify` vérifie la
signature. Aucun équivalent-mot-de-passe ne transite → **pas d'oracle de login**,
pas de fuite d'existence de compte, anti-lockout. *(Limite résiduelle, identique à
SRP : un vol du vérificateur — la clé publique d'auth — permet une attaque
dictionnaire hors-ligne au coût d'un Argon2id par essai ; c'est ce coût qui
protège.)*

### MFA — TOTP (RFC 6238)

Secret chiffré au repos (clé dérivée de `TOKEN_SECRET`), login en deux temps (le
bundle de clés n'est livré qu'après le 2ᵉ facteur : `/auth/login/verify` renvoie un
jeton court, `/auth/login/mfa` livre le bundle), codes de secours à usage unique,
enrôlement par QR.

### WebAuthn / passkeys (2ᵉ facteur)

Enrôlement et connexion via `@simplewebauthn/server` (attestation `none`, compteur
anti-clonage, défi à usage unique). Ne remplace **pas** la connexion (zéro-
connaissance : la clé vient de la passphrase) — c'est un 2ᵉ facteur alternatif au
TOTP. `WEBAUTHN_RP_ID` = domaine du Drive en production.

### Connexion sans mot de passe par clé d'accès (WebAuthn PRF)

WebAuthn **découvrable** (resident key) : la passkey authentifie directement au
serveur (`/auth/webauthn/assert/*`), **aucun e-mail transmis** → pas d'oracle
d'énumération, `userVerification` obligatoire. La **même cérémonie** produit le
secret PRF qui déverrouille localement (repli mot de passe si l'appareil n'a pas
d'enregistrement PRF). Un bouton dédié figure sur l'écran de connexion.

### Déverrouillage biométrique local (WebAuthn PRF)

Chemin de déverrouillage LOCAL optionnel : l'extension PRF fait produire à une
passkey (après vérification biométrique/matérielle) un secret stable de 32 octets ;
on en dérive (HKDF-SHA-256) une clé qui chiffre la `masterKey` en AES-256-GCM.
L'enveloppe vit en `localStorage`, à côté du `snapshot` (keyBundle) déjà présent —
**inutile sans le secret PRF**, que seul l'authentificateur régénère. Le serveur
reste **zéro-connaissance** (il ne voit ni le secret PRF, ni l'enveloppe ; côté
client `drive-cloud/prf-unlock.ts` ; le serveur se contente de demander
`extensions:{prf:{}}` à l'enrôlement). Activation dans *Sécurité* ; l'écran de
session verrouillée propose alors « Déverrouiller avec une clé d'accès », le mot
de passe restant le repli. **La passphrase demeure la racine de confiance** (perte
de tous les appareils ⇒ mot de passe ou recouvrement d'organisation requis).

### SSO (OIDC)

Le serveur vérifie un **jeton d'identité** signé par l'IdP (RS256/ES256/EdDSA
contre le JWKS configuré par org : issuer, clientId, clés publiques, domaines
autorisés), puis ouvre une session pour le membre correspondant. La connexion SSO
est **refusée si l'IdP n'a pas vérifié l'e-mail** (`email_verified`) — ce contrôle
ferme un vecteur de prise de contrôle par premier binding de `sub` sur un e-mail
non vérifié.

**Point crucial** : le SSO authentifie l'**identité** ; il ne déverrouille **pas**
les clés E2E — le client dérive toujours sa clé maître d'une **phrase de passe**
que le serveur ne voit jamais. Une org peut donc imposer le SSO tout en restant
zéro-connaissance (modèle Bitwarden/Proton : SSO + phrase de passe de coffre).
Endpoint public `POST /auth/sso/verify`. UI d'administration livrée (onglet
« SSO & SCIM » : configuration issuer/clientId/JWKS/domaines, activation).

### SCIM 2.0

Provisioning/**déprovisioning** par jeton SCIM d'organisation (`/scim/v2/Users` :
list/get, POST = invitation, PATCH `active`, DELETE). Le déprovisioning suspend
l'adhésion → **perte immédiate de tout accès** (SSO et session existante). SCIM ne
peut pas créer de clés E2E (générées côté client) : un POST crée donc une
**invitation** que la personne complète en s'inscrivant. Le jeton SCIM et son
endpoint sont générés depuis l'UI d'administration.

---
