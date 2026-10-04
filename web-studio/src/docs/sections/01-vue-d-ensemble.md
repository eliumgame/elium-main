## Vue d'ensemble

Elium est une suite bureautique et un Drive d'entreprise chiffrés. L'idée
centrale : **vos documents restent chez vous**. Par défaut, rien n'est envoyé en
ligne.

Elium existe en deux produits. Ils partagent le même format `.elium`, le même
moteur de signatures et les mêmes éditeurs.

| Produit | Ce que c'est | Où il tourne | Compte requis |
|---|---|---|---|
| **Suite bureautique locale** | Documents, Tableur, Présentations, PDF, Détecteur, Parapheur, espace de travail | Votre PC (Windows : MSI ou exe ; sinon navigateur) | Non |
| **Drive d'entreprise** | Stockage, partage et co-édition temps réel, multi-utilisateurs, zéro-connaissance | Un serveur que vous hébergez (VPS Linux, ou PC avec Docker) | Oui, créé sur votre serveur |

> L'application de bureau **n'embarque aucun serveur**. Le Drive est un service à
> part que vous hébergez. L'application s'y connecte avec son adresse
> (bouton **Serveur** de l'écran de connexion du Drive). Sans serveur configuré,
> la carte Drive affiche « Serveur Drive injoignable ».

### Les modules de la suite locale

Depuis l'accueil, vous accédez à ces modules.

| Module | Rôle |
|---|---|
| **Documents** | Éditeur de texte riche : mise en page, styles, tableaux, graphiques, citations, suivi des modifications. Import et export DOCX |
| **Tableur** | Feuilles de calcul, formules, graphiques, tableaux croisés dynamiques. Import et export XLSX |
| **Présentations** | Diapositives, masques, animations, mode présentateur. Import et export PPTX |
| **PDF** | Lecture, annotation, édition de texte, formulaires, caviardage, OCR, signature |
| **Détecteur** | Analyse un fichier pour repérer des signaux de rédaction par IA, des anomalies, et vérifie les justificatifs de contenu C2PA |
| **Parapheur** | Circuit de signatures ordonné, joint au document |
| **Espace de travail** | Bibliothèque locale : dossiers, étiquettes, corbeille, recherche plein texte, sauvegarde |
| **Réglages** | Langue, thème, polices, raccourcis, port, mises à jour, données locales |

Le **Drive d'entreprise** a aussi sa carte sur l'accueil. Voir les sections qui lui sont consacrées.

### Ce qui reste sur votre machine

- Vos documents, dans le stockage du navigateur intégré à l'application (base IndexedDB), ou dans les fichiers `.elium` que vous enregistrez.
- Le chiffrement et les signatures : ils se font localement, dans l'application.
- Les polices, le moteur PDF, l'OCR et les dictionnaires : ils sont livrés avec l'application.

Deux fonctions peuvent contacter Internet, **uniquement si vous les demandez** :

| Fonction | Ce qui sort |
|---|---|
| Recherche de plagiat du Détecteur | Des extraits du texte analysé, vers Serper ou Bing avec votre propre clé API. La politique de sécurité de l'application de bureau bloque ces connexions (voir Limites connues du Détecteur) |
| Catalogue de polices en ligne (Fontsource) | L'adresse du catalogue ou du fichier demandé, via le relais de l'application de bureau |

Les mises à jour interrogent GitHub pour chercher une nouvelle version signée. Aucun document n'est envoyé. Vous pouvez les couper (voir Mises à jour automatiques).

### Les deux modes de lancement

| Mode | Description |
|---|---|
| **Application de bureau** (Windows) | `Elium.exe` démarre un petit serveur sur `127.0.0.1` et ouvre une fenêtre dédiée. Mises à jour automatiques, association des fichiers `.elium`, instance unique |
| **Navigateur** | L'interface web seule (PWA installable). Mêmes éditeurs. Pas de mises à jour automatiques ni de réglage de port : le navigateur gère le cache |

### Limites connues de la suite locale

- L'application de bureau n'existe que pour **Windows**. Sur les autres systèmes, utilisez la version web.
- Le mode hors-ligne ne couvre pas le Drive d'entreprise : il demande une connexion à votre serveur.
- Aucune synchronisation automatique entre deux PC en mode local. Pour déplacer vos données, utilisez la sauvegarde `.elium-workspace` (section Espace de travail local).
