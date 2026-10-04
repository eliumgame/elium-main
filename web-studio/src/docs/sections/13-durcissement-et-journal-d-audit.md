## Durcissement et journal d'audit

Ce chapitre décrit les protections de l'API du Drive contre les abus et les fuites, puis le journal d'audit. Les secrets, le pare-feu et les sauvegardes sont dans le chapitre sur l'exploitation.

### Protections en un coup d'œil

| Risque | Protection |
|---|---|
| Fuite de la taille des fichiers | Rembourrage Padmé avant chiffrement |
| Force brute sur la connexion | Plafonds par route et par IP, partagés via Redis |
| IP usurpée par un en-tête | Confiance limitée aux proxys privés |
| Inondation du relais temps réel | Plafonds de taille, de débit et de connexions |
| Corps de requête géant | JSON limité à 1 MiO, blobs à 2 Gio (réglables) |
| Faux jeton SSO ou fausse URL | Validation stricte, aucune redirection suivie |
| Accès retiré mais clé conservée | Rotation de clé du nœud |
| Altération du journal | Chaînage SHA-256 vérifiable |

### Rembourrage des tailles

Avant chiffrement, le contenu est rempli jusqu'à une taille « ronde » (schéma **Padmé**, issu des PURBs). La longueur observable ne révèle plus que sa tranche, avec un surcoût inférieur à 12 % environ. Le rembourrage s'applique au contenu, aux noms, aux métadonnées et aux mises à jour collaboratives. Tout contenu fait au moins 64 octets.

### Plafonds des blobs et des liens

| Route | Appels par minute |
|---|---|
| Envoi du contenu d'un nœud | 120 |
| Lecture du contenu d'un nœud | 400 |
| Ouverture d'un lien public (et son contenu) | 120 |
| Signature par lien (envoi) | 30 |
| Création d'une demande de signature | 20 |

Le retour d'une signature par lien est de plus plafonné à **50 Mio** (`MAX_SIGN_ARTIFACT_BYTES`), car la route est publique.

### Anti-usurpation d'IP

Le serveur ne croit **pas** un en-tête `X-Forwarded-For` quelconque. Un client pourrait sinon s'inventer une IP neuve à chaque requête et contourner la limitation. Par défaut, seuls les proxys d'adresse privée ou locale (Caddy sur la même machine) sont crus. Une connexion publique directe voit son en-tête ignoré. La variable `TRUST_PROXY` permet de changer ce comportement : `false`, `true`, un nombre de sauts, ou une liste d'adresses.

### Plafonds du relais de collaboration

- Taille d'une trame WebSocket bornée.
- Taille d'une mise à jour chiffrée : `MAX_COLLAB_MESSAGE_BYTES` (512 Kio).
- Débit par connexion : `MAX_COLLAB_MESSAGES_PER_SEC` (300). Au dépassement, la connexion est fermée et le client se resynchronise.
- Taille de la présence (curseurs) bornée.
- Connexions simultanées par compte : `MAX_COLLAB_CONNECTIONS_PER_USER` (40).

### En-têtes et conteneurs

L'API répond avec une CSP `default-src 'none'` et `frame-ancestors 'none'` (c'est du JSON pur), `Referrer-Policy: no-referrer` et `Cross-Origin-Resource-Policy: same-site`. Les origines autorisées sont celles de `CORS_ORIGINS`.

Les conteneurs de l'API et de l'interface tournent **sans droits root**. Celui de l'interface a un système de fichiers en lecture seule, toutes les capacités Linux retirées et `no-new-privileges`. Les en-têtes de Caddy sont décrits dans le chapitre sur l'exploitation.

### Relais d'horodatage et récupération de clés SSO

Deux fonctions font des requêtes **sortantes** : le relais d'horodatage RFC 3161 (`POST /api/tsa`) et la récupération des clés publiques du fournisseur SSO. Elles sont encadrées pour ne pas servir à atteindre le réseau interne :

- HTTP ou HTTPS seulement, vers des adresses **publiques** (les plages privées, locales, de documentation et réservées sont refusées) ;
- le nom est résolu **une seule fois** et la connexion vise l'adresse vérifiée, ce qui ferme la voie au DNS rebinding ;
- aucune redirection n'est suivie ;
- tailles de requête et de réponse bornées, délai court, 20 appels par minute pour le relais.

Une requête d'horodatage ne contient qu'une **empreinte**, jamais le document.

### Journal d'audit à intégrité chaînée

Le journal enregistre les opérations de sécurité : connexions, échecs, changements de droits, partages, rotations, suppressions, recouvrement. Il stocke des **métadonnées d'autorisation**, jamais de contenu.

- Une entrée porte `entry_hash = SHA-256(hash précédent ‖ champs)`, une chaîne **par organisation**.
- Modifier, supprimer ou réordonner une entrée casse la chaîne.
- L'écriture est sérialisée par un verrou, pour que deux entrées simultanées ne créent pas deux branches.
- Lecture : `GET /api/orgs/:id/audit` (pagination par curseur, 500 entrées au plus). Vérification : `GET /api/orgs/:id/audit/verify`. Les deux exigent la permission `audit.view`.

### Ménage périodique

Toutes les 15 minutes, l'API supprime les défis de connexion et de clé d'accès expirés, les sessions expirées (ou révoquées depuis plus de 7 jours) et les invitations expirées. Elle supprime aussi définitivement les nœuds restés plus de 30 jours à la corbeille, avec leurs blobs. Elle signale enfin les rotations de clé d'organisation arrivées à échéance. Le journal collaboratif n'est jamais purgé par ce balayage.

### Limites connues du durcissement

- La chaîne du journal rend une altération **détectable**. Elle n'empêche pas un administrateur de base de données de **tout réécrire** et de recalculer les empreintes : il n'y a pas d'ancrage externe.
- L'écran du journal **ne lance pas** la vérification de la chaîne : l'appel passe par l'API.
- Caddy ne limite pas le débit lui-même (il n'a pas ce module). La limitation est dans l'API.
- La résolution DNS du fournisseur SSO n'est pas épinglée comme celle de l'horodatage : un nom public qui pointerait vers une adresse privée n'est pas bloqué par le contrôle d'adresse. Une politique de sortie réseau sur le serveur est le vrai remède.
- Pas de protection contre l'exfiltration par un membre légitime (DLP) : un membre qui peut lire un fichier peut le copier.
