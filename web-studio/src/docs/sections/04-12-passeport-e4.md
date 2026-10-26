### Passeport professionnel E4 (BTS Gestion de la PME)

Le module **Passeport professionnel E4** remplace le classeur Excel à macros du CRCOM
(« passeport numérique ») pour l'épreuve E4 « Gérer les relations avec les clients et
les fournisseurs ». Il fonctionne dans Elium, sans macro ni Excel : ouvrez-le depuis
la tuile de l'accueil ou la palette de commandes.

Le passeport est enregistré **automatiquement sur l'appareil** (IndexedDB `elium-passeport`).
Si le coffre local est actif, tout son contenu (identité, situations, stages) est
**chiffré au repos**, comme le Parapheur. L'effacement des données du navigateur
supprime ce passeport local : activez l'une des sauvegardes ci-dessous.

### Passeport E4 : sauvegardes automatiques

| Sauvegarde | Où | Détail |
|---|---|---|
| Fichier sur le PC | Application de bureau et navigateurs Chromium | Vous choisissez un fichier une fois ; Elium le réécrit 2 secondes après chaque modification. Il est en JSON **non chiffré**. Après un redémarrage, le navigateur peut demander de confirmer l'accès (bouton « Réactiver ») |
| Drive entreprise | Serveur | Fichier `Passeport-BTS-GPME.json` **chiffré de bout en bout** à la racine du Drive, versionné par le serveur. Manuelle ou automatique (20 secondes après la dernière modification). Un conflit (fichier modifié ailleurs) propose de restaurer ou d'écraser |
| Export manuel | Téléchargement | Sauvegarde JSON réimportable depuis le tableau de bord |

Avec un serveur Elium, c'est la sauvegarde sur le Drive qui permet de retrouver son
passeport depuis un autre appareil.

### Passeport E4 : les six onglets

| Onglet | Rôle |
|---|---|
| Tableau de bord | Identité du candidat et de l'établissement, **suivi du dossier E4** (liste de contrôle), statistiques, sauvegarde / import / réinitialisation |
| Situations | Une fiche par situation professionnelle (SP1, SP2…) : ajouter, dupliquer, supprimer, transférer, générer la fiche d'analyse |
| Passeport | Tableau synoptique activités × modalités, tâches grisées, visa de l'équipe pédagogique, exports |
| Référentiel | Les 4 domaines, 22 activités et 102 tâches du BTS, avec la couverture par vos situations |
| Contexte commercial | Les 12 éléments minimaux de l'annexe V-3, cases à cocher et notes |
| Stages | Périodes de stage, attestation (annexe III-3) à préparer et à suivre |

### Passeport E4 : fiches de situation

Chaque fiche reprend la feuille « Fiche SPxx » du classeur : modalité de réalisation
(avant la formation, en établissement, en PME, en organisation), condition
(autonomie, accompagnée, observation), période, nature (GRCF, communication orale,
communication écrite), puis les rubriques de présentation et d'analyse.

- **Activités et tâches** : cocher une tâche coche son activité ; décocher une
  activité retire ses tâches. Les compétences associées s'affichent automatiquement.
  Les activités 1.1 à 1.6 relèvent de l'épreuve E4.
- **Numérotation** : le plus petit numéro libre est proposé, ce qui comble les trous
  laissés par les suppressions. « Dupliquer » copie une fiche vers un nouveau numéro.
- **Avancement** : un pourcentage indique la part des rubriques rédigées.
- **Suivi** : pièces à joindre, remarques de l'enseignant, case « relue ».

### Passeport E4 : transfert vers le passeport

Le bouton **Transférer vers le passeport** (équivalent du « Transfert » du classeur)
fige les activités, tâches, modalité et période de la fiche dans le passeport. Une
situation n'apparaît dans le passeport qu'après ce transfert.

Si vous modifiez ensuite l'un de ces éléments, la fiche passe à l'état **À
retransférer** : le passeport garde l'ancienne version tant que vous ne refaites pas le
transfert. Modifier seulement un texte n'a pas cet effet. Supprimer une fiche ou la
retirer du passeport dégrise ses tâches.

### Passeport E4 : exports

Les PDF sont **générés par Elium** (ce ne sont plus des impressions du navigateur) : leur mise en page reprend celle des documents officiels, mesurée sur le rendu Word du modèle `ficheAnalyseSPVierge.docx` et sur un passeport officiel rempli.

| Export | Format | Détail |
|---|---|---|
| Fiche d'analyse | PDF | Recto (identification, enjeux, rubriques) et verso « ANALYSE » à libellés verticaux, mêmes cadres, bandeaux gris, polices et cotes que le modèle. Les rubriques s'agrandissent avec le texte et passent à la page suivante |
| Fiche d'analyse | Word (.docx) | Le **modèle officiel** est embarqué et rempli balise par balise |
| Passeport synoptique | PDF A4 paysage, Word | Titre, identité, attestation de l'équipe pédagogique, bande verticale jaune du domaine, activités, solutions logicielles, compétences, identifiants par modalité (« GRCF 2 ; CE2 »), tâches grisées si réalisées. Par défaut le domaine 1 (épreuve E4) ; une case ajoute les domaines 2 à 4 |
| Dossier complet | PDF | Passeport synoptique suivi de toutes les fiches validées |
| Attestation de stage (annexe III-3) | PDF | Le formulaire officiel reproduit cote par cote d'après son rendu Word : cadres, filets, polices (Arial Narrow rendue en Helvetica étirée, Times pour les notes), textes réglementaires. Les valeurs saisies remplacent les pointillés ; les champs vides gardent leurs pointillés pour être complétés à la main. Disponible pour les périodes de nature « stage » |
| Contexte commercial (annexe V-3) | PDF | Les douze éléments minimaux de l'annexe, dans l'ordre et avec ses libellés exacts, chacun suivi du texte rédigé. L'annexe ne fournit aucun modèle de document : seule la typographie (Times, titres centrés) est reprise |
| Sauvegarde | JSON | Réimportable ; remplace le passeport actuel après confirmation |

**Identifiants des situations.** Chaque case du passeport affiche l'identifiant de la situation : saisi sur la fiche (rubrique Identification, « GRCF 2 ; CE2 »), sinon déduit de la nature et du rang (GRCF 1, CO1, CE1…). **Solutions logicielles** : un texte par activité, saisi dans l'onglet Passeport ; « Reprendre les solutions logicielles des fiches » le préremplit sans écraser ce qui est déjà écrit.

### Passeport E4 : stages, alternance et activité salariée

L'onglet « Stages et alternance » suit toutes les périodes en entreprise : **stage**, **alternance** (apprentissage ou contrat de professionnalisation) et **activité salariée**. Chaque période a ses dates, sa durée en semaines (saisie, sinon calculée sur les dates), ses missions E4 et E51 et son justificatif (attestation de stage, contrat et certificat de l'employeur, certificat de travail).

- **Voie scolaire** : le nombre de semaines à réaliser est un champ modifiable, **12 par défaut** (le plus souvent indiqué : 6 consécutives en fin de 1re année et au moins 4 consécutives en 2e année). Les sources publiées ne concordent pas (8, 10, 12 ou 14 semaines selon le positionnement réglementaire du candidat, la session et l'établissement) : **Elium ne l'impose pas** : l'annexe III-3 (session 2024) parle de « 12 semaines de stage réglementaires », valeur gardée par défaut, mais saisissez celle que votre établissement vous donne. Le décompte, par type et par année du cycle, indique combien de semaines il reste.
- **Apprentissage, professionnalisation, candidat salarié** : pas de stage distinct ; les périodes en entreprise et leurs justificatifs fournissent les situations.

### Passeport E4 : documents dans le Drive

Dans le Drive entreprise, le Passeport est sauvegardé de deux façons. Le fichier `Passeport-BTS-GPME.json` est la **sauvegarde technique** (pour restaurer). Le bouton « Publier les documents (PDF + Word) dans le Drive » crée en plus le dossier « Passeport E4 — NOM Prénom » avec les **vrais documents** : passeport synoptique (PDF et Word), dossier complet, et chaque fiche d'analyse (PDF et Word). Chaque publication ajoute une version au fichier. La case « Publier aussi les documents à chaque sauvegarde automatique » les tient à jour.

### Passeport E4 : annexes, import et analyse des fiches

- **Annexes** : dans une fiche, section « Annexes », ajoutez les fichiers voulus (40 Mo au maximum chacun). Ils restent sur cet appareil, chiffrés quand le coffre local est actif, ne sont pas dans la sauvegarde JSON, sont ajoutés au dossier PDF (fiches transférées) et publiés dans le Drive avec les documents.
- **Importer des fiches** : le bouton de la liste des situations lit des fichiers Word, PDF, texte ou .elium et crée une fiche par fichier. Un compte rendu indique les rubriques reprises et celles à compléter. L'import lit le texte et les cases cochées lisibles ; un PDF fait par un autre outil, ou par une ancienne version d'Elium, n'a pas de cases lisibles : vérifiez-les.
- **Analyse** : chaque fiche reçoit un score et des remarques (rubriques vides ou courtes, nature et enjeux, activités évoquées mais non cochées, période, lisibilité). Ce sont des repères de rédaction, pas une note d'examen.
- **Avancement** : fiches créées, complètes et validées sont comptées par rapport au nombre de fiches attendues (6 par défaut, modifiable dans le suivi).

### Passeport E4 : limites connues

- Sans sauvegarde sur le Drive, le passeport reste **local** à ce navigateur. La
  sauvegarde sur le Drive n'est pas une édition collaborative : un seul passeport par
  personne, sans fusion automatique.
- Le PDF de la fiche reprend la mise en page du modèle mesurée sur le rendu Word ; les polices sont Carlito (mêmes métriques que Calibri) et Helvetica (Arial). Le PDF peut différer d'un pixel d'un rendu Word.
- Le contexte commercial n'a pas de modèle officiel à reproduire (l'annexe V-3 ne fait que lister ce qu'il doit contenir) : sa mise en page est celle d'Elium.
- Les signatures et le cachet de l'établissement se posent sur la version imprimée :
  le visa saisi dans l'onglet Passeport n'est pas une signature électronique.
- Le référentiel et le modèle de fiche sont ceux du classeur CRCOM fourni
  (session 2019, mis à jour pour la session 2024) : vérifiez auprès de votre équipe
  pédagogique qu'ils correspondent à la session visée.
- Les nombres de situations attendus à l'examen ne sont pas imposés par le module : la
  liste de contrôle signale seulement les activités E4 non encore couvertes.

Le dossier de la sous-épreuve **E51** (gestion des risques) se construit dans le même module, onglet
« Dossier E51 » : voir la section suivante.
