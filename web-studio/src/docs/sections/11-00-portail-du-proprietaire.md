## Portail du propriétaire

Un déploiement VPS héberge **un seul Drive**. Son propriétaire le règle depuis une page d'administration, **sans toucher au code ni aux fichiers de configuration** : menu du Drive → **Portail du propriétaire** (visible uniquement par lui). Les réglages sont enregistrés **côté serveur** (table `site_settings`, routes `/api/site/admin/*`) ; chaque modification est écrite dans le journal d'audit.

### Qui est le propriétaire ?

C'est le propriétaire de l'organisation du Drive : **le premier compte créé** sur un déploiement neuf, qui crée l'organisation. Le portail **réutilise** le modèle existant — organisations, rôles, invitations, SCIM, clé d'organisation et recouvrement — il n'en crée pas un second. Les boutons « Rôles & permissions », « Recouvrement » et « SSO & SCIM » du portail ouvrent les écrans existants.

### Amorçage : le code d'activation

Entre le déploiement et la création du premier compte, n'importe qui pourrait s'inscrire en premier. Pour l'empêcher, **le serveur génère au démarrage un code d'activation à usage unique** (12 caractères groupés, par exemple `K7QM-4WXD-R9TB`, 60 bits d'entropie) et l'affiche dans ses journaux :

```bash
docker compose logs api | grep "CODE D'ACTIVATION"
```

- Le code est demandé sur l'écran d'inscription du premier compte, puis à la création du Drive. Il est **consommé à la création du Drive** : il ne sert qu'une fois.
- Le serveur n'en conserve que l'**empreinte** ; la comparaison se fait en temps constant.
- Il **expire** après `ACTIVATION_TTL_HOURS` (72 h par défaut) ; redémarrer le serveur tant que le Drive n'est pas créé en génère un nouveau (l'ancien est invalidé).
- Les essais sont limités : 5 échecs bloquent l'adresse 15 minutes, 30 échecs au total bloquent tout essai pendant une heure (compteurs en mémoire, déploiement mono-instance).
- `ACTIVATION_CODE` dans `.env` impose un code choisi à l'avance (au lieu d'en générer un).
- `OWNER_EMAIL` reste un garde-fou **en plus** : s'il est défini, l'adresse doit correspondre *et* le code être valable.
- `GET /api/site/policy` indique `activationRequired` tant que le code est exigé.

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

### Jauge de stockage réel et garde-fou disque

Dans **Stockage & sauvegarde**, le portail affiche l'espace **réellement libre et total** du disque qui porte le dossier de stockage (`STORAGE_FS_ROOT`, mesuré par `statfs`), l'espace occupé par les utilisateurs et la **somme des quotas alloués**.

- **Sur-allocation** : un bandeau prévient quand la somme des quotas dépasse la capacité du disque. Si certains utilisateurs sont illimités, la somme n'est pas calculable et le portail le dit.
- **Marge de sécurité** (réglable) : le plus grand de *X % du disque* (5 par défaut) et d'un *volume minimal libre* (2 Go par défaut). Sous cette marge, **tout envoi est refusé avec une erreur 507 explicite**, pour ne jamais saturer le disque — et donc la base de données qui le partage. Le contrôle a lieu avant l'écriture (taille annoncée), puis sur la taille réelle.
- **Alertes** : bandeau d'avertissement quand il reste moins de deux marges libres, bandeau critique sous la marge.
- Avec `STORAGE_DRIVER=s3`, il n'y a pas de disque local à mesurer : la jauge est remplacée par une explication, et le garde-fou ne s'applique pas (surveillez le stockage chez votre fournisseur).

### Réglages de déploiement (`.env`)

Ces valeurs ne se changent pas depuis l'interface :

| Variable | Rôle |
|---|---|
| `SINGLE_DRIVE=true` | Un déploiement = un Drive : toute création d'une seconde organisation est refusée. Active aussi l'espace privé par membre par défaut. |
| `OWNER_EMAIL` | Adresse seule autorisée à s'inscrire avant le premier propriétaire (en plus du code d'activation). |
| `ACTIVATION_CODE`, `ACTIVATION_TTL_HOURS` | Code d'activation imposé (sinon généré et affiché dans les journaux) et sa durée de validité (72 h). |
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

- Serveur : `server/tests/site.test.ts` (routes, validation, contrôle d'inscription) et `server/tests/activation-disk.test.ts` (code d'activation, disque), lancés par `npm test` dans `server/`.
- Client : `web-studio/tests/owner-portal.test.ts`.
- Multi-utilisateurs de bout en bout (vrai PostgreSQL embarqué, vraie API, vrai SDK chiffré) : `npm run test:e2e:portal` dans `web-studio/`.
