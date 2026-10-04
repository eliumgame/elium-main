## Journal des versions

> Dernière version publiée : **4.10.0**, étiquetée le 4 octobre 2026. Ce journal est reconstruit à partir de l'historique Git et des étiquettes de version. L'historique complet des nouveautés depuis votre version est aussi affiché par la carte de mise à jour de l'application.

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
