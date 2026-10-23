## Journal des versions

> Dernière version publiée : **4.10.0**, étiquetée le 4 octobre 2026. Ce journal est reconstruit à partir de l'historique Git et des étiquettes de version. L'historique complet des nouveautés depuis votre version est aussi affiché par la carte de mise à jour de l'application.

### Version 4.20.0 — code d'activation et jauge de stockage réel

- **Code d'activation à usage unique** : au premier démarrage d'un Drive neuf, le serveur génère un code (12 caractères, 60 bits) affiché dans ses journaux et exigé pour créer le compte propriétaire puis le Drive. Il est consommé à la création du Drive, expire après 72 h (réglable) et les essais sont limités.
- **Jauge de stockage réel** dans le portail : espace libre et total du disque du serveur, quotas alloués, alertes de proximité de la limite et de sur-allocation.
- **Garde-fou disque** : les envois sont refusés (erreur 507) sous une marge de sécurité réglable (le plus grand de 5 % du disque et 2 Go par défaut), pour ne jamais saturer le disque ni la base.

### Version 4.18.0 — travaux enregistrés en fichiers (application Windows)

- L'application Windows miroite désormais vos documents, tableurs, présentations, PDF et passeport dans `Documents\Elium`, en plus de la base du navigateur : un changement de port ou un effacement des données ne fait plus perdre de travail (réimport automatique au démarrage, sans écraser).
- Copie de sécurité complète au premier lancement ; fichiers retirés conservés 30 jours dans `.corbeille`.
- Avec le coffre local, rien n'est écrit en clair sur le disque (fichiers scellés).
- API locale du lanceur protégée par jeton de session, contrôle d'origine et confinement des chemins.
- Site : demande de stockage persistant au navigateur.

### Version 4.17.0 — garde-fous anti-gel (lot A)

- **Veille des tâches longues** : toute interface figée plus de 200 ms est notée dans le journal d'incidents local (source « gel », avec la vue en cours) ; rien ne quitte l'appareil.
- **Coffre local** : l'encodage base64 se fait par blocs ; avec le coffre actif, enregistrer un gros PDF ou document ne fige plus l'onglet.
- **Détecteur** : lecture des métadonnées d'un .docx sans tout décompresser ; protection contre les « bombes de décompression » dans les métadonnées PNG.
- **Tableur** : un CSV de plus de 30 Mo est refusé avec un message clair (à enregistrer en .xlsx, qui gère les très gros fichiers).

### Version 4.16.0 — import Excel en flux, sans aucun gel

- Tableur : l'import d'un .xlsx tourne désormais dans un Worker (lecture en flux), avec barre de progression et bouton Annuler ; l'onglet reste fluide même sur un classeur de 45 Mo et 745 000 lignes (plus longue tâche mesurée : ~60 ms au lieu de ~17 s).
- Les très grandes feuilles sont plafonnées pour ménager la mémoire ; une fenêtre permet de choisir la plage de lignes (avec ou sans la ligne d'en-têtes) ou d'ignorer une feuille, et de relire le fichier à la demande.
- L'enregistrement local d'un gros classeur se fait par tranches (plus de blocage de plusieurs secondes juste après l'import).

### Version 4.15.2 — import Excel de très gros classeurs

- Tableur : un classeur dont une feuille dépasse 32 Mo de données (des centaines de milliers de lignes) ne fige plus l'application. Elium en lit le début, puis prévient du nombre de lignes importées ; les liens externes et la chaîne de calcul, inutiles à l'import, ne sont plus décompressés.

### Version 4.15.0 — Passeport E4 : annexes, import et analyse des fiches

- 4.15.1 : dossier complet plus robuste — annexes de plus de 12 Mo signalées par un intercalaire au lieu d'être recopiées, interface laissée libre pendant l'assemblage, et repli automatique sans annexes si l'une d'elles est illisible.
- Retour au **tableau du passeport** d'origine ; les colonnes portent le nom **SP** de chaque fiche (SP1, SP2…, modifiable) au lieu de « GRCF ».
- **Annexes** : joignez les fichiers de votre choix (PDF, images, Word…) à chaque fiche ; elles sont chiffrées avec le coffre local, ajoutées au dossier PDF et publiées dans le Drive.
- **Importation de fiches** (Word, PDF, texte) avec compte rendu rubrique par rubrique, et **analyse** de chaque fiche (complétude, cohérence des activités cochées, lisibilité).
- **Avancement** corrigé : calculé par rapport au nombre de fiches attendues (6 par défaut, modifiable) ; une fiche sur six ne donne plus 70 %.
- L'import relit les cases cochées des contrôles Word, des champs de formulaire et des symboles Wingdings ; les PDF produits par cette version portent des métadonnées invisibles pour une relecture exacte.

### Version 4.14.0 — Passeport E4 fidèle aux documents officiels

- 4.14.1 : attestation de stage (annexe III-3) reproduite en PDF d'après le formulaire officiel ; contexte commercial en PDF avec les douze éléments de l'annexe V-3.
- Passeport E4 : les PDF (fiche d'analyse, passeport synoptique, dossier complet) sont générés par Elium et reprennent la mise en page des documents officiels ; identifiants de situation (GRCF/CE/CO) et solutions logicielles par activité ; stages, alternance et activité salariée avec décompte des semaines (durée à confirmer) ; publication des vrais documents (PDF et Word) dans le Drive.

### Version 4.13.0 — sauvegarde de l'espace de travail dans le Drive

- Tout l'espace de travail local (documents, tableurs, présentations, PDF) peut être envoyé dans le Drive entreprise, à la demande ou automatiquement, puis restauré. Session Drive désormais partagée dans toute l'application.
- L'accueil du site hébergé affiche la version précise d'Elium, les notes de mise à jour et propose d'installer l'application Windows (MSI).

### Version 4.12.0 — Passeport professionnel E4 (BTS Gestion de la PME)

- Nouveau module **Passeport professionnel E4**, qui remplace le classeur Excel à macros du CRCOM : fiches de situation professionnelle, transfert vers le passeport, passeport synoptique, référentiel (4 domaines, 22 activités, 102 tâches), contexte commercial, stages et suivi du dossier.
- Fiche d'analyse générée en Word à partir du **modèle officiel**, et en PDF ; passeport synoptique Word (paysage) et PDF ; dossier complet PDF ; sauvegarde JSON.
- Données enregistrées localement, **chiffrées par le coffre local** quand il est actif.
- Sauvegardes automatiques du passeport : **fichier choisi sur le PC** (application de bureau) et **Drive entreprise** (chiffré de bout en bout, utile avec un serveur).
- 4.12.2 : le Passeport peut déverrouiller lui-même la session du Drive (mot de passe) pour sauvegarder sur le serveur ; fermeture d'un document collaboratif sans erreur d'awareness.
- 4.12.1 : exports PDF lisibles en thème sombre, synoptique en paysage dans le dossier complet, dates au format français.

### Version 4.10.0 — la refonte « hors ligne d'abord »

Plus de quatre-vingts changements depuis la 4.9.0. Ils se regroupent ainsi.

#### Hors ligne et polices

- Les polices sont **embarquées** dans l'application. Plus aucune police n'est chargée depuis Internet.
- Un **service worker de précache** permet de rouvrir l'application sans réseau.
- L'application s'exécute en **instance unique**, avec un journal d'incidents **local** (aucune télémétrie).
- Une **bibliothèque de polices** persistante, avec un gestionnaire, visible dans tous les sélecteurs.
- Le **téléchargement de polices en ligne** (catalogue Fontsource) est facultatif et passe par un relais verrouillé du lanceur.
- Un cadre de **migration versionné** pour toutes les bases locales (IndexedDB).

#### Clés et confiance

- **Trousseau unique** de clés : migration des anciennes clés, rotation, verrouillage après inactivité, clés dérivées de façon déterministe.
- Sauvegarde et restauration du trousseau au format **`.eliumkey` v2** (paquet chiffré), avec phrase de récupération, partage de secret de Shamir et clés d'accès (PRF).
- Contacts : niveau de confiance, notes, liste de révocation, expiration, succession vérifiée.
- Couche **facultative** de protection par Windows (DPAPI).
- Profils de dérivation de clé nommés ; lecture des fichiers avec d'anciennes clés de réception.
- Ligne de commande `elium keys` (liste, génération, export, import, rotation).

#### Mises à jour, installation et déploiement

- Mise à jour : revérification au lancement, états d'échec distincts, canaux **stable et bêta**, reprise, **paquet hors ligne** `.eliumupdate`, pack d'assets séparé.
- Deuxième MSI, **par utilisateur** et sans droits administrateur.
- Lanceur : contrôle d'hôte sur toutes les routes internes, plafond de taille des corps.
- **Publication en quatre jobs** : porte de CI, construction sans secret, images signées, publication. Test de fumée de l'exécutable, SBOM, attestation de provenance, verrous Python à empreintes, Dependabot.
- **Drive serveur durci** : secrets obligatoires, Redis protégé par mot de passe, images signées épinglées par empreinte, sauvegarde obligatoire avant mise à jour avec restauration de la base au retour arrière, unité systemd sans droits root.
- Drive : **changement de mot de passe**, avec nouvelle clé d'authentification et sessions révoquées.
- `scripts/next_version.py` : version déduite des commits conventionnels.

#### Espace de travail

- Espace de travail intégré : accueil, bibliothèque, corbeille, recherche, remplacement global, récupération.
- Sauvegarde et restauration, accès aux fichiers du système, port du serveur local choisi.
- Réglages par catégories, palette de commandes globale, raccourcis.
- Interface en **français et en anglais**.

#### Modules

- **Documents** : graphiques, citations et bibliographie (APA, MLA, ISO 690), fond, bordures et numérotation des lignes, galerie de modèles, import et export DOCX plus fidèles à Word, vérificateur d'accessibilité.
- **Tableur** : tableaux dynamiques avec débordement, `LET`, `LAMBDA` et fonctions matricielles, graphiques riches, tables nommées, tableaux croisés dynamiques persistants, mise en page d'impression, outils de données, listes de validation sur une plage, virtualisation des lignes (100 000), import Excel plus fidèle.
- **Présentations** : masques et dispositions, trieuse de diapositives, audio et vidéo, tableaux avec fusion, diagrammes générés, documents et pages de notes, import PowerPoint plus fidèle.

#### PDF et Détecteur

- PDF : contrôle indépendant du PDF/A, balisage PDF/UA de base, OCR en pool de workers interruptible, marques en lot (numérotation Bates, en-têtes, filigrane), vérificateur de caviardage, alerte si du texte survit sous une zone noircie.
- Détecteur : **vérification C2PA réelle** (signature, chaîne de certificats, liaison forte) avec racines de confiance importables, analyse par lot.

#### Accessibilité et performance

- Annonces pour lecteurs d'écran (cellule active, page PDF), anneau de focus du Tableur contrasté, accès au clavier du canevas des Présentations.
- Garde-fous de performance testés : 500 pages de document, 100 000 lignes de tableur, 300 diapositives, 1 000 pages de PDF.

#### Qualité et finitions

- Les erreurs avalées en silence sont remplacées par un message visible ou un enregistrement dans le journal local. Corrige notamment la perte silencieuse d'une autosauvegarde illisible du Tableur.
- Budget total de JavaScript relevé à 6,8 Mo, avec justification.
- Correctifs d'interface : accueil mobile sans débordement horizontal (666 px ramenés à 390 px), titres de groupes du ruban alignés, lanceur d'applications en grille 2×2, icônes de la liste de contrôle des clés, hauteur constante de la fenêtre des réglages.
- Documentation intégrée réorganisée : un fichier par chapitre, sommaire généré, test de structure.

### Versions précédentes

Dates des étiquettes Git. Résumé des changements marquants.

| Version | Date | Changements marquants |
|---|---|---|
| 4.9.0 | 3 octobre 2026 | Modifier le texte d'un PDF comme dans Acrobat : paragraphe édité sur la page, reformatage automatique, styles conservés, texte incliné et pages pivotées. Serveur sur Fastify 5.12.5 |
| 4.8.1 | 27 septembre 2026 | PDF du Drive : ouverture dans l'éditeur, enregistrement en nouvelle version chiffrée, alerte si le fichier a changé |
| 4.8.0 | 27 septembre 2026 | Refonte du PDF au niveau d'Acrobat Pro : formulaires, enregistrement incrémental, commentaires, organisation, sécurité et caviardage réels, signatures PAdES, OCR hors ligne, exports Office, création depuis Office, comparaison, optimisation, PDF/A, accessibilité, impression |
| 4.7.0 | 9 septembre 2026 | Rotation planifiée de la clé d'organisation exposée dans l'interface |
| 4.6.x | 8 et 9 septembre 2026 | Performance (mémoïsation, Argon2id en worker), couverture de tests du serveur, preuves d'attaque rejouées en CI |
| 4.5.x | 4 au 8 septembre 2026 | Port du serveur local choisi, fiche MSI enrichie, ruban compact sur petit écran, migration du Drive vers le vocabulaire visuel commun, circuit du parapheur fiabilisé |
| 4.4.14 | 2 septembre 2026 | Jeton anti-CSRF et contrôle d'origine sur les routes d'état du lanceur ; correctifs : autosauvegarde des Présentations, formules Excel tirées, santé de Redis suivie, publication conditionnée à la CI verte |
| 4.4.0 à 4.4.13 | 18 au 29 août 2026 | Fastify 5, accessibilité de sept vues, demandes de signature par lien (parties multiples, ordre, PDF), module Détecteur (4.4.13 : sensibilité, aperçu annoté) |
| 4.3.x | 8 au 12 août 2026 | Migrations versionnées, clés SSO dynamiques, groupes SCIM, rotation de clé d'organisation, signature PDF PAdES reconnue par Adobe, correctif WebAssembly du lanceur (4.3.6), confiance des signatures (mots de sécurité, carnet de clés), durcissement du format |
| 4.2.x | 1 au 7 août 2026 | Clés d'accès (second facteur, connexion sans mot de passe, déverrouillage biométrique), durcissement de sécurité issu d'un audit (4.2.13) |

> **4.3.7** (signature PAdES avec horodatage) a été **annulée** par la 4.3.8 : elle provoquait une régression dans Adobe.

Plus ancien : le format `.elium` v4, le sceau de document Ed25519 (suite à l'audit de juin 2026), la mise à jour automatique de l'application (vérifiée en production le 18 juillet 2026) et celle du serveur Drive (v4.1.30, 20 juillet 2026).

### Abandonné

L'add-in pour Office / Microsoft 365 (un prototype) a été supprimé du dépôt le 19 juillet 2026. La suite reste locale ; toute fonction en ligne reste facultative.
