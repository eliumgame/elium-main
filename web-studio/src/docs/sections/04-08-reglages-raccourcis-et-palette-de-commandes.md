### Réglages, raccourcis et palette de commandes

Ouvrez les **Réglages** avec **Ctrl+,** ou le bouton Paramètres de l'accueil. Le
champ de recherche en haut retrouve un réglage par synonyme (« police », « mot de
passe », « port »…).

### Les dix catégories

| Catégorie | Réglages |
|---|---|
| **Général** | Langue ; page affichée au démarrage (accueil, bibliothèque ou récents) ; nombre d'éléments récents (4 à 24) |
| **Apparence** | Thème clair ou sombre ; densité confortable ou compacte |
| **Édition** | Police et taille par défaut des **nouveaux** documents ; délai des brouillons (1 à 60 s, 3 par défaut) ; langue du dictionnaire et correcteur du navigateur |
| **Polices** | Gestionnaire de polices (voir Polices) |
| **Raccourcis** | Raccourcis personnalisables |
| **Espace de travail** | Sauvegarde et rappel, restauration, corbeille, recherche et index |
| **Sécurité & clés** | Mes clés (identité), clé de réception, carnet de clés de confiance, coffre local |
| **Mises à jour & version** | Version, canal, historique, retour arrière, port de lancement |
| **Confidentialité & données** | Effacer les données locales, journal d'incidents |
| **À propos** | Version, licence, lien vers cette documentation |

Les préférences sont stockées dans le navigateur de l'application. Une valeur
corrompue retombe sur le défaut.

### Port de lancement

Réglable seulement dans l'**application de bureau** (Réglages, Mises à jour &
version). Dans un navigateur, le réglage est remplacé par une explication.

| Élément | Comportement |
|---|---|
| Défaut | Un port libre est choisi à chaque lancement entre 3000 et 3100 |
| Écoute | `127.0.0.1` uniquement : jamais accessible depuis le réseau |
| Port précis | Entre 1024 et 65535, validé. Occupé : message d'erreur |
| Retour à l'auto | « Revenir à automatique » |
| Effet | **Au prochain démarrage**. Bouton « Redémarrer maintenant » |
| Port préféré occupé au lancement | Elium en prend un autre pour cette fois et garde votre préférence |
| Port hors de la plage automatique | Possible, mais il doit rester libre à chaque lancement |

> **Vos données dépendent du port.** Le navigateur de l'application range les
> documents par adresse (`127.0.0.1:port`). Si Elium démarre sur un autre port,
> vos documents locaux semblent absents tant que vous n'êtes pas revenu sur le
> premier. Épinglez un port pour éviter ce piège. Voir Dépannage et FAQ.

### Raccourcis personnalisables

| Action | Défaut |
|---|---|
| Palette de commandes (module actif) | Ctrl+K |
| Palette de commandes globale | Ctrl+Maj+P |
| Rechercher dans tout l'espace | Ctrl+Maj+F |
| Ouvrir les paramètres | Ctrl+, |
| Retour à l'accueil | Alt+H |
| Nouveau document | Alt+N |
| Nouveau tableur | Alt+Maj+N |
| Nouvelle présentation | Alt+Maj+P |
| Ouvrir un fichier | Ctrl+O |
| Enregistrer | Ctrl+S |
| Enregistrer sous | Ctrl+Maj+S |

Pour changer un raccourci : **Modifier**, puis tapez la nouvelle combinaison
(**Échap** annule). Vous pouvez aussi **Désactiver** ou **Tout réinitialiser**.

Règles :

- Une combinaison doit contenir **Ctrl** ou **Alt**, ou être une touche de fonction (F1 à F12). Une lettre seule volerait la frappe.
- Les combinaisons réservées par le navigateur ou l'éditeur sont refusées (copier, coller, couper, annuler, tout sélectionner, fermer, onglet, nouvelle fenêtre, actualiser, quitter, gras, italique, souligné, imprimer).
- Une combinaison déjà utilisée par une autre action est refusée, avec le nom de cette action.

Les raccourcis de mise en forme de l'éditeur (gras, italique, annuler…) ne sont
**pas** modifiables. Le module PDF a ses propres raccourcis (voir PDF).

### Palette de commandes

**Ctrl+K** ouvre la palette du module affiché. **Ctrl+Maj+P** ouvre la palette
globale. Elle liste, avec leur raccourci :

- les actions du module actif (Documents, Tableur, Présentations) ;
- la navigation, les fichiers, l'espace de travail, les réglages ;
- vos éléments (« Ouvrir <titre> »), et une recherche dans tout l'espace.

La recherche est floue : les lettres dans l'ordre suffisent, les accents sont
ignorés. Les commandes récentes sont en tête. Dans le module **PDF**, Ctrl+K reste
à la palette du PDF ; Ctrl+Maj+P ouvre la palette globale.

### Port, coffre, clés : où les trouver

| Besoin | Où |
|---|---|
| Sauvegarder mon identité de signature (`.eliumkey`) | Réglages, Sécurité & clés, Mes clés |
| Nommer les clés de mes signataires | Sécurité & clés, Carnet de clés de confiance |
| Chiffrer ma bibliothèque avec un mot de passe | Sécurité & clés, Coffre local |
| Tout effacer | Confidentialité & données, Effacer les données locales |

« Effacer les données locales » supprime l'espace de travail, les brouillons,
l'identité, le carnet de clés et les préférences de ce navigateur. Les fichiers
`.elium` déjà enregistrés sur le disque ne sont pas touchés.

### Limites connues des réglages

- Les raccourcis ne sont personnalisables que pour les onze actions du tableau.
- Les réglages sont liés au profil de l'application (et à son port). Ils voyagent via la sauvegarde `.elium-workspace`.
- Le port ne se règle pas dans un navigateur.
