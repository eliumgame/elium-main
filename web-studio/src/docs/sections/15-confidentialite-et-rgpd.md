## Confidentialité et RGPD

Traitement **100 % local par défaut** : aucun document n'est envoyé en ligne sans
action explicite. L'édition, la signature, le chiffrement, la vérification et
l'export ont lieu sur votre poste (navigateur ou CLI). Aucune télémétrie n'est
collectée.

### Ce qui est stocké dans un fichier `.elium`

| Donnée | Présence | Remarque |
|---|---|---|
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

### Principes RGPD appliqués

| Principe | Mise en œuvre |
|---|---|
| **Minimisation** | Le suivi ne stocke que nom, date, rôle, empreinte de clé, action |
| **Transparence** | Manifeste et panneau Infos indiquent ce qui est stocké et si du contenu est chiffré |
| **Traitement local** | Édition/signature/chiffrement 100 % locaux ; `rgpd.localOnly = true` |
| **Consentement** | Toute fonction en ligne future est **explicitement** activée par l'utilisateur |
| **Sécurité** | Chiffrement des données sensibles (profils chiffrés) ; protection des clés |
| **Portabilité / export** | Export du document (PDF/HTML/Markdown) et d'un **rapport de preuve** JSON |
| **Effacement / conservation** | Aucune donnée côté serveur par défaut (rien à effacer) |

Le **Drive d'entreprise** est auto-hébergé et zéro-connaissance : les données
restent chez vous, chiffrées de bout en bout. Une signature peut contenir des
données personnelles (nom, fonction, image manuscrite) ; ne renseignez que le
nécessaire. Toute fonctionnalité en ligne future (p. ex. horodatage qualifié)
resterait **opt-in**, signalée avant tout envoi, avec information sur les données
transmises, leur finalité, leur durée de conservation et les droits d'accès /
rectification / effacement / portabilité.

---
