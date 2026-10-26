## Journal des versions

> Dernière version publiée : **4.29.3**, étiquetée le 26 octobre 2026. Ce journal est reconstruit à partir de l'historique Git et des étiquettes de version. L'historique complet des nouveautés depuis votre version est aussi affiché par la carte de mise à jour de l'application.

### Version 4.29.3 — correctif critique : isolation des données entre comptes

- **Changement de compte sur le même navigateur** : se déconnecter puis se connecter ou s'inscrire avec un AUTRE compte ne montre plus les documents, dossiers, brouillons et autres données locales (Tableur, Présentations, Parapheur, Passeport, trousseau…) du compte précédemment utilisé sur cet appareil. Le navigateur détecte désormais le changement de compte et réinitialise l'espace local avant d'afficher quoi que ce soit au nouveau compte. Se reconnecter à son propre compte ne perd rien, comme avant.
- Correctif supplémentaire : rotation du refresh token rendue atomique avec détection de réemploi, HTML des présentations assaini avant affichage, secrets S3 par défaut refusés en production (voir le détail en 4.29.2).

### Version 4.29.2 — durcissement suite à un audit de sécurité externe

- **Cache du navigateur** : le service worker ne met plus en cache les réponses d'API (données de compte, organisation…) ; la déconnexion purge aussi ce cache, pour qu'un changement de compte sur le même navigateur ne réutilise jamais une réponse du compte précédent.
- **Invitations** : un lien d'invitation transféré ou récupéré par quelqu'un d'autre n'attribue plus son rôle à ce compte — l'adresse e-mail est désormais vérifiée à l'acceptation.
- **Retrait de droits en temps réel** : retirer un membre d'une organisation ou d'un groupe, supprimer un groupe, ou déprovisionner via SCIM ferme désormais immédiatement ses connexions de collaboration (document et notifications), au lieu d'attendre sa prochaine déconnexion.
- **robots.txt et sitemap.xml** renvoient désormais une réponse correcte au lieu de la page d'accueil.
- Mentions de garanties cryptographiques corrigées dans le code et la documentation technique (promesse de résistance à un serveur compromis reformulée plus honnêtement). Aucune action n'est nécessaire côté utilisateurs ; mise à jour recommandée pour les Drive déployés.

### Version 4.29.1 — Documents testé de bout en bout

- **Documents** : 36 parcours automatisés au clavier réel (édition, références, mise en page, révision, recherche, publipostage) ; raccourci exposant/indice corrigé (Ctrl+Maj+= sur un texte déjà en indice ne faisait rien).

### Version 4.29.0 — campagne de tests complets et corrections

- **Tableur** : la frappe directe dans la grille garde son premier caractère ; nombres saisis à la française (12,5 ; 1 234,5) reconnus par les formules, le tri et le remplacement ; fonctions VALUE, REPT, SWITCH ; FLOOR/CEILING avec multiple ; menus lisibles en fenêtre étroite.
- **Présentations** : l'édition du texte d'une diapositive fonctionne (focus au double-clic, Échap), aperçus réels des modèles ; en collaboration, aucune modification n'est perdue pendant une coupure.
- **PDF et Détecteur** : Ctrl+Maj+P ouvre la palette du PDF, aperçu du Détecteur corrigé, parcours testés dans un vrai navigateur.
- **Drive, portail et Parapheur** : correctifs issus de 34 parcours navigateur multi-comptes ; une seule connexion temps réel quand ouverture et fermeture se croisent.
- **App Windows** : parcours complet lanceur + navigateur testé (fichiers, restauration, changement de port, conflit, sécurité).

### Version 4.28.2 — sauvegarde : derniers trous comblés, testée avec un compte membre

- **Ajouts à la sauvegarde Drive** : signatures et initiales manuscrites du PDF et identités de confiance (les identités privées de signature restent sur l'appareil), ainsi que les réglages du Détecteur (signaux désactivés, moteur de recherche, confiance C2PA ; la clé API de recherche n'est jamais envoyée). Les sources bibliographiques et tampons PDF personnalisés étaient déjà inclus ; les annexes du Passeport et les polices sont restaurées avec le reste.
- **Testé de bout en bout avec un propriétaire ET un simple membre** (navigateur vierge, reconnexion, contenu identique sans interaction) : Documents (enregistré et brouillon), Tableur, Présentations, PDF, Passeport, dossiers, favoris, étiquettes, corbeille, historique de versions, polices.

### Version 4.28.1 — restauration automatique sur un appareil vide

- **Appareil vide = restauration sans question** : après connexion sur un navigateur ou un appareil sans aucun élément, dossier ni brouillon, votre espace est restauré automatiquement (bandeau de progression puis résumé), puis la sauvegarde automatique reprend. Le comportement est le même à chaque fois.
- **Appareil non vide et différent du Drive** : seule situation où une fenêtre s'ouvre (garder les deux, remplacer, garder le local, ou repartir à neuf) ; l'envoi reste en pause tant que vous n'avez pas choisi. Un espace vide n'est jamais envoyé par-dessus une sauvegarde non vide.
- **Brouillons et autres données antérieures à la 4.28** (brouillons, versions, polices, passeport, circuits déjà présents sur l'appareil) sont envoyés au Drive dès la première sauvegarde.

### Version 4.28.0 — aucun travail perdu : sauvegarde Drive incrémentale et restauration automatique

- **« Enregistrer » ne perd plus rien** : si le navigateur refuse l'écriture sur le disque (permission, contexte non sécurisé), le document est tout de même enregistré dans la bibliothèque et dans le Drive, une copie est téléchargée et un message clair en français remplace l'erreur technique (Documents, PDF, archive de l'espace de travail).
- **Bouton « Enregistrer dans le Drive »** dans les Documents, le Tableur, les Présentations et le PDF : envoi immédiat, chiffré de bout en bout et versionné. Un « Enregistrer » normal pousse aussi vers le Drive quand la sauvegarde automatique est active.
- **Sauvegarde incrémentale** dans le dossier « Sauvegarde Elium » du Drive : un fichier par élément, seul ce qui change est renvoyé. Elle couvre désormais aussi les brouillons de récupération, l'historique de versions, les polices importées, le passeport (et ses annexes), les circuits du Parapheur, les dossiers, favoris, étiquettes, corbeille et réglages. Les clés privées et identités ne sont jamais envoyées.
- **Sur un site déployé, la sauvegarde automatique est activée par défaut** (obligatoire quand le propriétaire l'impose) ; une pastille d'état toujours visible indique « enregistré », « en attente » ou « hors ligne » ; les modifications en attente partent au retour du réseau, à la reconnexion et à la fermeture de la page.
- **Appareil neuf ou cache effacé** : dès la connexion, la restauration est proposée avec un choix explicite en cas de conflit (garder les deux, remplacer, garder le local) ; rien n'est envoyé tant que vous n'avez pas choisi, et un espace vide ne remplace jamais une sauvegarde existante.
- **Portail du propriétaire** : colonne « Dernière sauvegarde » par utilisateur, avec alerte au-delà de deux jours quand la sauvegarde est imposée.
- Parcours de persistance testé de bout en bout dans un vrai navigateur (`npm run test:e2e:persistence`).

### Version 4.27.1 — correctif de sécurité (2FA)

- **Contournement de la 2FA corrigé** : le jeton intermédiaire délivré après le mot de passe (en attente du code de vérification) n'est plus accepté comme jeton d'accès. Mettez à jour votre serveur ; aucune action n'est nécessaire côté utilisateurs.

### Version 4.27.0 — protections contre l'auto-blocage et réinitialisation de mot de passe

- **Imposer la 2FA ne peut plus vous enfermer dehors par inadvertance** : le portail demande une confirmation explicite (application et codes de secours en lieu sûr) ET un code valide saisi à l'instant (ré-authentification, vérifiée par le serveur).
- **Procédure de secours propriétaire** en ligne de commande sur le serveur : désactive la 2FA du compte, remet la politique à « facultative », coupe les sessions et écrit une entrée dans le journal d'audit.
- **Connexion avec 2FA** : champ « code de vérification ou code de secours », lien « Je n'ai plus mon application », saisie tolérante des codes de secours (majuscules, espace, sans tiret).
- **Enrôlement forcé** : l'écran laisse désormais voir les codes de secours avant d'ouvrir l'application.
- **Réinitialisation de mot de passe par le propriétaire** : lien à usage unique valable 24 h ; l'utilisateur choisit un nouveau mot de passe (nouveau jeu de clés) ; le propriétaire rétablit ses accès par la clé d'organisation (« Rétablir ses accès »).
- Parcours de connexion de bout en bout testé dans un vrai navigateur (`npm run test:e2e:login`).

### Version 4.26.0 — version officielle : fin des gels, portail du propriétaire, fichiers locaux

Cette version rassemble le travail des versions 4.16 à 4.25 :

- **Plus de gel** : import Excel en flux dans un Worker (avec progression, annulation et choix de plage), enregistrement et lecture PDF dans un Worker, Documents, Présentations, collaboration, Tableur, espace de travail et Détecteur sans tâche bloquante ; veille des tâches longues dans le journal d'incidents.
- **Portail du propriétaire** : un Drive par déploiement, compte obligatoire, réglages sans toucher au code (inscription, quotas, sauvegarde obligatoire, 2FA, sessions), code d'activation à usage unique et jauge de stockage réel.
- **App Windows** : enregistrement en fichiers locaux (Documents\Elium).
- **Reprise après mise à jour** : plus d'écran d'erreur si l'application est mise à jour pendant qu'une page est ouverte.
- **Serveur** : zod 4 et fastify 5.12.7 (audit de dépendances au vert).

### Version 4.25.0 — Documents : publipostage, import Word et recherche sans gel

- **Publipostage** : fusion par tranches (l'interface reste réactive, avec compteur), plafonnée à 200 enregistrements par document fusionné — au-delà, un message invite à fusionner par lots. Les champs utilisés ne sont plus recalculés à chaque rendu de la fenêtre.
- **Import .docx** : fichier plafonné à 200 Mo, texte à 48 Mo, images à 12 Mo chacune (80 Mo cumulés) ; les médias ne sont décompressés qu'à la demande, une image reprise plusieurs fois n'est encodée qu'une fois, et les images écartées sont signalées par un message.
- **Recherche** : résultats surlignés plafonnés à 2 000 (« Tout remplacer » reste exhaustif) ; plus de recalcul quand seul le curseur bouge ; une expression régulière à quantificateurs imbriqués (du type `(a+)+`) est refusée au lieu de figer l'onglet.
- Suivi des modifications et styles de tableau : décorations calculées une seule fois par état du document.

### Version 4.24.0 — anti-gel lot D (Présentations et collaboration Drive)

- **Miniatures** : la rampe et la trieuse ne redessinent plus que les diapositives modifiées, ne montent que celles proches de l'écran (par petites tranches) et plus rien quand le panneau est replié.
- **Deck collaboratif** : chaque mise à jour distante ne reconvertit que la diapositive touchée ; le rattrapage du journal à l'ouverture d'un document collaboratif s'applique en une seule transaction (un seul rendu) et rend la main au navigateur pendant le déchiffrement.
- **Import PowerPoint** : seules les parties XML sont décompressées d'emblée, chaque image n'est encodée qu'une fois, avec plafonds (fichier 400 Mo, média 40 Mo, total 256 Mo) et messages clairs ; l'analyse rend la main entre les diapositives. Sur un deck témoin de 300 diapositives (72 Mo), l'import prend ~7 s sans gel notable.
- **Enregistrement automatique** : sérialisation du deck par diapositive avec cache (seules les diapositives modifiées coûtent), fenêtre orateur mise à jour par delta, export PPTX sans recompression ni doublons de médias, documents imprimés par tranches.

### Version 4.23.0 — anti-gel lot C (PDF, Détecteur, format)

- **Helper Worker commun** (`web-studio/src/workers/`) : progression, annulation, délai maximal, plafond d'entrée et repli en ligne, pour que chaque module sorte ses calculs lourds du fil principal.
- **PDF** : la recherche par expression régulière tourne dans un Worker terminé au-delà de 2,5 s (un motif catastrophique comme `(a+)+$` figeait l'onglet ; il affiche maintenant un message clair) ; lecture des annotations enrichies à l'ouverture dans un Worker ; l'enregistrement, le caviardage et l'optimisation cèdent la main entre les pages et les images ; signature et détection de certification sans conversion du fichier entier en texte ; conversion en PDF plafonnée (feuilles de plus de 20 000 lignes, texte de plus de 25 Mo) avec message explicite.
- **PDF, enregistrement hors du fil principal** : Ctrl+S, « Enregistrer sous », les exportations et l'impression d'un gros PDF (plus de 2 Mo ou 60 pages) tournent dans un Worker pdf-lib persistant, qui garde l'état du fichier d'un enregistrement à l'autre (chargement, caviardage, écriture, chiffrement) ; sans Worker, ou pour les opérations qui ont besoin du canvas (optimisation), le travail se fait en ligne comme avant. Mise en page de la conversion en PDF et comparaison visuelle par tranches.
- **Format .elium** : un document trop gros est refusé à l'enregistrement avec un message clair, au lieu d'être écrit puis refusé à la réouverture.
- **Stockage** : les listes de la bibliothèque, des brouillons et des reprises lisent les métadonnées par curseur, sans charger les octets de tous les documents.
- **Détecteur** : l'extraction des images d'un PDF se fait dans un Worker réellement interrompable ; plafonds pour les .docx (taille et bombe de décompression) ; empreintes C2PA natives ; découpe en phrases en temps linéaire.

### Version 4.21.1 — reprise automatique après une mise à jour

- Une page restée ouverte pendant une mise à jour ne montre plus « Elium a rencontré un problème » (« Failed to fetch dynamically imported module ») au prochain module ouvert : Elium recharge tout seul, une fois ; les autosauvegardes sont conservées.

### Version 4.21.0 — garde-fous anti-gel (lot E : Tableur, espace de travail, Passeport)

- **Tableur** : le moteur de formules conserve l'analyse des formules d'une modification à l'autre (plus de ré-analyse de tout le classeur à chaque frappe) ; l'import d'un CSV (désormais jusqu'à 64 Mo), l'export .xlsx et la relecture d'un gros classeur enregistré se font par tranches ; le filtre d'une grande feuille se calcule en arrière-plan ; le calcul des champs calculés d'un tableau croisé et l'indicateur « à actualiser » sont allégés (désactivé au-delà de 200 000 cellules source) ; les règles de mise en forme conditionnelle d'étendue (échelle de couleurs, extrêmes, doublons) sont limitées à 250 000 cellules, avec un message ; MIN/MAX ne plantent plus au-delà de ~100 000 valeurs.
- **Espace de travail** : l'index de recherche se charge sans geler l'interface (pliage du texte ~6 fois plus rapide) ; avec le coffre, chaque élément est scellé séparément au lieu de ré-encrypter tout l'index (l'ancien format est migré) ; sauvegarde et restauration par flux avec plafond global de 1 Go ; la bibliothèque affiche ses éléments par tranches de 300 au défilement ; le rechercher/remplacer ignore les documents de plus de 40 Mo.
- **Passeport** : l'import d'une fiche .docx ne décompresse plus le fichier quand il ne contient aucune case à convertir.

### Version 4.20.0 — code d'activation et jauge de stockage réel

- **Code d'activation à usage unique** : au premier démarrage d'un Drive neuf, le serveur génère un code (12 caractères, 60 bits) affiché dans ses journaux et exigé pour créer le compte propriétaire puis le Drive. Il est consommé à la création du Drive, expire après 72 h (réglable) et les essais sont limités.
- **Jauge de stockage réel** dans le portail : espace libre et total du disque du serveur, quotas alloués, alertes de proximité de la limite et de sur-allocation.
- **Garde-fou disque** : les envois sont refusés (erreur 507) sous une marge de sécurité réglable (le plus grand de 5 % du disque et 2 Go par défaut), pour ne jamais saturer le disque ni la base.

### Version 4.22.0 — Documents : plus de gel en tapant dans un long document

- La frappe n'est plus répercutée à chaque touche vers le reste de l'application : la remontée est regroupée et vidée avant tout enregistrement, clic ou raccourci. L'enregistrement automatique (brouillon de récupération) ne sérialise plus le document entier à chaque changement et ne fabrique plus de .docx : la copie Word reste téléchargeable depuis l'écran d'accueil, reconstruite à la demande.
- Renvois, notes, légendes, table des matières et index : un seul balayage du document par modification (au lieu d'un par élément) ; les numéros de page se résolvent par dichotomie.
- Correcteur : les soulignements sont mis à jour seulement dans le paragraphe modifié. Barre d'état : totaux de mots et de caractères recalculés après un court temps de calme. Pagination : mesure des blocs en temps linéaire.
- Mesure sur un document témoin d'environ 250 pages (notes, renvois, index, images) : la plus longue tâche pendant la frappe passe de 1,7 s à 0,11 s.

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
