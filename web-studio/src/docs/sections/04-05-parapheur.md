### Parapheur

Le Parapheur organise la signature d'un document par **plusieurs personnes, dans
un ordre**. Il se trouve dans le panneau latéral d'un document. Il marche sans
compte et sans serveur.

### Le circuit

Un circuit est une liste ordonnée de signataires (nom, rôle facultatif).

| Bouton | Effet |
|---|---|
| Ajouter un signataire | Ajoute une personne au circuit |
| Monter, Descendre | Change l'ordre |
| Signer (preuve Ed25519) | Pose une vraie signature numérique pour ce signataire |
| Refuser | Marque le refus |
| Réinitialiser (retire la signature) | Remet le signataire en attente |
| Retirer du circuit | Supprime le signataire |

Statut global : **Brouillon, En signature, Terminé, Rejeté**. L'interface laisse
signer le **premier** signataire en attente seulement.

### Signer sans compte

Signer crée une signature Ed25519 **incorporée au document**, liée au signataire.
Si vous n'avez pas encore de clé, « Générer une identité pour signer (sans
compte) » en crée une. Elle est stockée chiffrée sur cet appareil (Argon2id et
AES-256-GCM).

> Sauvegardez votre identité dans un fichier `.eliumkey` (Réglages, Sécurité &
> clés). Si vous effacez les données locales sans sauvegarde, la clé est perdue
> pour toujours.

### Envoyer et recevoir

« Envoyer une demande de signature » **enregistre le fichier `.elium`**. Il n'y a
**aucun envoi automatique** : vous transmettez vous-même le fichier (courriel,
clé USB). Chaque signataire l'ouvre dans Elium, signe sa part et vous le renvoie.
Vous réimportez le fichier signé.

Le circuit **voyage dans le `.elium`** (fichier `parapheur/circuit.json`). Il est
chiffré avec les métadonnées quand cette protection est active.

### Ce que le Parapheur garantit, et ce qu'il ne garantit pas

- Les **signatures** Ed25519 sont la preuve. Elles sont vérifiables.
- Le **circuit** lui-même (l'ordre, les statuts) est une information de suivi **non scellée** : il peut être modifié.

### Limites connues du Parapheur

- Pas de notification, pas de rappel, pas d'envoi : tout passe par vous.
- L'ordre n'est pas imposé cryptographiquement : il est appliqué par l'interface.
- Deux copies signées en parallèle ne sont pas fusionnées automatiquement.
- La signature par lien sans compte (signataire externe sur un navigateur) est une fonction du **Drive d'entreprise**. Elle demande un serveur ; voir les sections sur les signatures et le Drive.
- Un ancien circuit enregistré dans la base locale est adopté dans le document à l'ouverture du panneau.
