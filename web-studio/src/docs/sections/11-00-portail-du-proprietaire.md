## Portail du propriétaire

Un déploiement VPS héberge **un seul Drive**. Son propriétaire le règle depuis une page d'administration, **sans toucher au code ni aux fichiers de configuration** : menu du Drive → **Portail du propriétaire** (visible uniquement par lui). Les réglages sont enregistrés **côté serveur** (table `site_settings`, routes `/api/site/admin/*`) ; chaque modification est écrite dans le journal d'audit.

### Qui est le propriétaire ?

C'est le propriétaire de l'organisation du Drive : **le premier compte créé** sur un déploiement neuf, qui crée l'organisation. Le portail **réutilise** le modèle existant — organisations, rôles, invitations, SCIM, clé d'organisation et recouvrement — il n'en crée pas un second. Les boutons « Rôles & permissions », « Recouvrement » et « SSO & SCIM » du portail ouvrent les écrans existants.

Entre le déploiement et la création de ce premier compte, n'importe qui pourrait s'inscrire en premier. Pour l'empêcher, définissez `OWNER_EMAIL` dans `.env` : seule cette adresse peut alors s'inscrire tant que le Drive n'a pas de propriétaire.

### Les réglages

| Section | Réglage | Effet |
|---|---|---|
| Inscription & accès | **Inscription** : ouverte, sur invitation, fermée | Ouverte : toute personne crée un compte et devient membre. Sur invitation : seules les adresses invitées (onglet Invitations) peuvent s'inscrire. Fermée : plus personne. |
| | **Rôle par défaut** | Rôle donné aux nouveaux inscrits (« Éditeur » = membre simple). Jamais « Propriétaire ». |
| | **Espace privé par membre** | Les membres créent leurs dossiers à la racine ; seuls eux, et le propriétaire via la clé d'organisation, y accèdent. |
| | **Nom du site** | Affiché sur l'écran de connexion. |
| Utilisateurs | Rôle, **quota individuel**, **suspendre / réactiver**, déconnecter tous les appareils | Une suspension coupe les sessions immédiatement et bloque la connexion ; les fichiers sont conservés. Le propriétaire ne peut pas être suspendu. |
| Stockage & sauvegarde | **Quota global** et **quota par utilisateur** | Dépassement : erreur 507 à l'envoi. Un quota individuel prime sur le défaut. Vide = illimité. |
| | **Sauvegarde automatique obligatoire** | La sauvegarde de l'espace de travail vers le Drive devient permanente et ne peut plus être désactivée par l'utilisateur. |
| | **Rétention** des anciennes versions et de la corbeille | Au-delà de N jours, les versions non courantes (dont les sauvegardes) sont supprimées par le ménage périodique ; la version courante est toujours conservée. 0 = pour toujours. |
| Sécurité | **2FA obligatoire** | Un compte sans second facteur ne peut rien faire d'autre que l'activer (le serveur répond `403 mfa_enrollment_required`). Le propriétaire doit d'abord avoir activé la sienne. |
| | **Longueur minimale du mot de passe** (8 à 128) | Contrôlée à la création et au changement de mot de passe. |
| Invitations | Création de liens d'invitation | Réutilise l'écran Membres. |

> La longueur du mot de passe est vérifiée **par l'application**, pas par le serveur : le chiffrement de bout en bout fait que le serveur ne voit jamais un mot de passe. Un client modifié pourrait donc l'ignorer ; la règle protège contre l'erreur, pas contre un attaquant qui contrôle son propre navigateur.

### Réglages de déploiement (`.env`)

Ces valeurs ne se changent pas depuis l'interface :

| Variable | Rôle |
|---|---|
| `SINGLE_DRIVE=true` | Un déploiement = un Drive : toute création d'une seconde organisation est refusée. Active aussi l'espace privé par membre par défaut. |
| `OWNER_EMAIL` | Adresse seule autorisée à s'inscrire avant le premier propriétaire. |
| `SIGNUP_MODE`, `DEFAULT_ROLE_KEY`, `MFA_POLICY`, `PASSWORD_MIN_LENGTH` | Valeurs de **départ** ; les réglages du portail les remplacent. |

### Garde d'authentification

Sur un site déployé, **aucun module** (Documents, Tableur, Présentations, PDF, Parapheur…) n'est accessible sans compte **connecté et déverrouillé** : l'application sonde `/api/site/policy` au démarrage et affiche l'écran de connexion tant que ce n'est pas le cas. Restent ouverts, par conception : les **liens de partage** (`?link=`), les **demandes de signature** (`?sign=`) et la fenêtre présentateur. L'application Windows et un poste sans serveur Drive restent en mode local, inchangés.

### Sécurité du compte (pour chaque utilisateur)

Menu **Sécurité** :

- **Vérification en deux étapes (TOTP)** : QR code à scanner dans une application d'authentification, **10 codes de secours** à usage unique, régénérables.
- **Clés d'accès** (passkeys) comme second facteur ou pour déverrouiller les données.
- **Appareils et sessions** : navigateur, adresse, dernière activité ; révocation d'une session ou de **tous les autres appareils**. Un jeton d'accès déjà émis reste valable jusqu'à 15 minutes au plus ; il n'est plus renouvelable.
- **Changement de mot de passe** (il révoque les autres sessions).

### Tests

- Serveur : `server/tests/site.test.ts` (routes, validation, contrôle d'inscription), lancé par `npm test` dans `server/`.
- Client : `web-studio/tests/owner-portal.test.ts`.
- Multi-utilisateurs de bout en bout (vrai PostgreSQL embarqué, vraie API, vrai SDK chiffré) : `npm run test:e2e:portal` dans `web-studio/`.
