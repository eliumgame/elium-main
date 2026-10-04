## Confidentialité et RGPD

La suite locale est **hors ligne par défaut**. Aucun document n'est envoyé nulle part sans une action explicite de votre part. Aucune télémétrie n'est collectée : pas de statistiques d'usage, pas de rapport d'erreur automatique, pas de compte obligatoire.

### Ce qui reste sur votre appareil

- Vos documents, tableurs, présentations et PDF : l'édition, la signature, le chiffrement, la vérification et l'export se font dans l'application.
- Vos clés (trousseau), vos préférences, votre espace de travail local, votre bibliothèque de polices.
- La **clé API de recherche** du Détecteur, si vous en saisissez une : elle est gardée dans le stockage du navigateur (`localStorage`) et n'est envoyée qu'au moteur de recherche choisi.
- Les journaux : un **journal d'incidents local** (50 entrées au plus : message, pile technique, version, heure, jamais le contenu d'un document), consultable et exportable depuis les réglages, et le journal de mise à jour dans `%LOCALAPPDATA%\Elium`.

### Ce qui peut partir sur le réseau

Tout ce qui sort est listé ici. Rien d'autre n'est envoyé.

| Fonction | Destination | Quand | Données envoyées |
|---|---|---|---|
| Mises à jour | GitHub (`api.github.com`, `github.com`) | Au lancement et périodiquement, ou à la demande | Une requête de lecture. Un identifiant de client `Elium-Updater` et l'adresse IP, comme pour toute requête web. Aucun document |
| Polices en ligne (facultatif) | Fontsource et jsDelivr | Seulement quand vous téléchargez une famille dans le gestionnaire de polices | Le nom de la police demandée. Liste fermée d'adresses, via le lanceur local |
| Horodatage RFC 3161 | Le serveur d'horodatage **que vous choisissez** | Quand vous demandez un horodatage | Une **empreinte** du document, jamais le document |
| Recherche de plagiat du Détecteur (facultatif) | Serper ou Bing, avec **votre** clé API | Quand vous lancez la recherche | Jusqu'à 60 extraits courts du texte analysé |
| Drive d'entreprise (si configuré) | Votre serveur | Quand vous vous connectez | Contenu **chiffré**, voir ci-dessous |

La CSP de l'application de bureau interdit à la page toute connexion vers l'extérieur. Les trois premières lignes passent donc par de petits relais du lanceur local, strictement limités (adresses publiques, tailles bornées, aucune redirection suivie).

> **La recherche de plagiat ne fonctionne pas dans l'application de bureau installée.** Elle appelle directement `google.serper.dev` ou `api.bing.microsoft.com` depuis la page, et la CSP du lanceur (`connect-src 'self'`) bloque ces appels. Elle n'est utilisable que dans une suite servie **sans** cette CSP (par exemple le mode développeur). Les autres analyses du Détecteur sont entièrement locales. Aucun relais n'existe pour elle, car elle exigerait d'ouvrir la CSP ou d'ajouter une route au lanceur.

### Ce qui est stocké dans un fichier .elium

| Donnée | Présence | Remarque |
|---|---|---|
| Contenu du document | toujours | chiffré pour les profils chiffrés |
| Titre, dates de création et de modification | toujours (manifeste) | |
| Profil et paramètres de protection | toujours (manifeste) | en clair, pour pouvoir ouvrir le fichier |
| Empreinte d'intégrité (SHA-256) | toujours | détecte l'altération |
| Signatures (visuel et placement) | si vous signez | image ou texte de la signature |
| Données du signataire | si renseignées | nom, rôle, société, date, réduites au minimum |
| Empreinte de clé publique | avec une preuve cryptographique | identifiant de clé, pas de donnée personnelle directe |
| Journal de suivi | avec le profil de suivi | nom, date, rôle, empreinte de clé, action |

Le manifeste contient `rgpd.storedPersonalData` : la liste des catégories de données personnelles **réellement** présentes. Le panneau **Infos** de l'éditeur l'affiche.

### Principes RGPD appliqués

| Principe | Mise en œuvre |
|---|---|
| **Minimisation** | Le suivi ne garde que nom, date, rôle, empreinte de clé, action |
| **Transparence** | Le manifeste et le panneau Infos montrent ce qui est stocké |
| **Traitement local** | Édition, signature, chiffrement locaux (`rgpd.localOnly`) |
| **Consentement** | Toute fonction en ligne est **activée par vous** et s'arrête sans action de votre part |
| **Sécurité** | Chiffrement des profils chiffrés, clés protégées |
| **Portabilité** | Export PDF, HTML, Markdown, DOCX, et rapport de preuve JSON |
| **Effacement** | Local : vous supprimez vos fichiers. Drive : voir ci-dessous |

Une signature peut contenir des données personnelles (nom, fonction, image manuscrite). Ne renseignez que le nécessaire.

### Le Drive d'entreprise et vos données

Le Drive est **auto-hébergé** : les données sont chez vous, ou chez l'organisation qui l'héberge. Le serveur stocke du contenu et des noms **chiffrés**. Il connaît toutefois en clair :

- les adresses e-mail et noms d'affichage des comptes ;
- les clés **publiques** ;
- l'arborescence, les dates, les tailles arrondies, qui a accès à quoi ;
- le journal d'audit, avec les adresses IP des actions.

L'hébergeur du Drive est donc, au sens du RGPD, le responsable de ces données. Elium ne fournit pas de contrat, de registre de traitement ni d'analyse d'impact : c'est à l'organisation de les établir.

### Suppression de compte (droit à l'effacement)

L'onglet **Sécurité** du Drive propose **Supprimer mon compte**. Une vérification préalable (`GET /api/users/me/deletion-preflight`) liste ce qui bloque.

**Conditions** :

- ne plus être propriétaire d'une organisation qui a d'autres membres (transférer la propriété) ;
- ne plus être le seul administrateur de recouvrement d'une organisation qui subsiste (en promouvoir un autre).

**Preuve exigée** : une signature faite avec votre clé d'authentification, pour qu'un jeton volé ne puisse pas détruire le compte.

**Effet** :

- une organisation dont vous êtes l'unique membre est **supprimée** avec ses fichiers ;
- les fichiers que vous possédiez dans une organisation qui subsiste sont **transférés** à son propriétaire ;
- vos clés d'accès aux fichiers, sessions, secrets TOTP, clés d'accès WebAuthn et appartenances sont supprimés ;
- le compte devient une **coquille anonymisée** : e-mail, nom et clés effacés, compte désactivé. Seul l'identifiant opaque reste, pour que la chaîne du journal d'audit demeure vérifiable.

> Les entrées déjà écrites dans le journal d'audit (action, date, adresse IP) restent, rattachées à cet identifiant anonyme. Prévoyez une durée de conservation de votre journal si votre contexte l'exige.

### Limites connues de la confidentialité

- La recherche de plagiat est inopérante dans l'application de bureau (voir plus haut).
- Les paquets de mise à jour viennent de GitHub : GitHub voit l'adresse IP de la machine qui vérifie.
- Aucune fonction d'export « toutes mes données » côté serveur n'existe pour un compte Drive ; la portabilité passe par l'export de vos fichiers.
- L'effacement d'un compte Drive anonymise l'identifiant mais ne réécrit pas le journal d'audit.
