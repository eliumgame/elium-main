# Confidentialité & RGPD

Elium est conçu **local-first** : par défaut, **aucun document n'est envoyé à un
serveur**. Le traitement (édition, signature, chiffrement, vérification, export)
a lieu sur votre poste, dans le navigateur ou via la CLI.

## 1. Ce qui est stocké dans un fichier `.elium`

| Donnée | Présence | Remarque |
| --- | --- | --- |
| Contenu du document | toujours | chiffré uniquement pour les profils chiffrés |
| Titre, dates création/modification | toujours (manifeste) | |
| Profil & paramètres de protection | toujours (manifeste) | en clair, pour pouvoir ouvrir le fichier |
| Empreinte d'intégrité (SHA-256) | toujours | détection d'altération |
| Signatures (visuel + placement) | si vous signez | image/texte de la signature |
| Données du signataire | si renseignées | nom, rôle, société, date — **minimisées** |
| Empreinte de clé publique | si preuve crypto | identifiant de clé, pas de donnée personnelle directe |
| Journal de suivi | si profil suivi | nom, date, rôle, empreinte de clé, action |

Le manifeste expose `rgpd.storedPersonalData` : la liste des catégories de données
personnelles **réellement** présentes dans le fichier. Le panneau **Infos** de
l'éditeur l'affiche en clair.

## 2. Principes RGPD appliqués

| Principe | Mise en œuvre |
| --- | --- |
| **Minimisation** | Le suivi ne stocke que nom, date, rôle, empreinte de clé, action. |
| **Transparence** | Le manifeste et le panneau Infos indiquent ce qui est stocké et si du contenu est chiffré. |
| **Traitement local** | Édition/signature/chiffrement 100 % locaux ; `rgpd.localOnly = true`. |
| **Consentement** | Toute fonction en ligne future (horodatage qualifié, invitations, partage) sera **explicitement** activée par l'utilisateur. |
| **Sécurité** | Chiffrement des données sensibles (profils chiffrés) ; protection des clés. |
| **Portabilité / export** | Export du document (PDF/HTML/Markdown) et d'un **rapport de preuve** JSON. |
| **Effacement / conservation** | Aucune donnée côté serveur par défaut (rien à effacer). Si un service optionnel est ajouté, il définira des durées de conservation et un droit à l'effacement. |

## 3. Données personnelles dans les signatures

Une signature peut contenir des données personnelles (nom, fonction, image
manuscrite). Renseignez uniquement ce qui est nécessaire. L'empreinte de clé
publique est un identifiant technique, pas une donnée personnelle directe, mais
elle peut devenir identifiante si elle est reliée à une personne hors bande.

## 4. Services en ligne (roadmap)

À ce jour Elium **n'envoie rien en ligne**. Les fonctionnalités futures
(horodatage qualifié, invitations à signer, partage, Microsoft 365) seront :

- **opt-in** et clairement signalées avant tout envoi de données ;
- accompagnées d'une information sur les données transmises, leur finalité, leur
  durée de conservation et le responsable de traitement ;
- assorties des droits d'accès, de rectification, d'effacement et de portabilité.

## 5. Vos droits

Pour les fichiers locaux, vous gardez le contrôle total : ils sont sur votre poste.
Aucune télémétrie n'est collectée par l'application. Si vous activez un service
distant à l'avenir, les modalités d'exercice de vos droits seront précisées dans
l'interface de ce service.
