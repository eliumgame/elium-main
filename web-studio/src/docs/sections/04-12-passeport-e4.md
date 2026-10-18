### Passeport professionnel E4 (BTS Gestion de la PME)

Le module **Passeport professionnel E4** remplace le classeur Excel à macros du CRCOM
(« passeport numérique ») pour l'épreuve E4 « Gérer les relations avec les clients et
les fournisseurs ». Il fonctionne dans Elium, sans macro ni Excel : ouvrez-le depuis
la tuile de l'accueil ou la palette de commandes.

Le passeport est enregistré **automatiquement sur l'appareil** (IndexedDB `elium-passeport`).
Si le coffre local est actif, tout son contenu (identité, situations, stages) est
**chiffré au repos**, comme le Parapheur. Exportez régulièrement une sauvegarde JSON :
l'effacement des données du navigateur supprime le passeport.

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

| Export | Format | Détail |
|---|---|---|
| Fiche d'analyse | Word (.docx) | Le **modèle officiel** `ficheAnalyseSPVierge.docx` est embarqué et rempli balise par balise : mise en page identique à celle du classeur |
| Fiche d'analyse | PDF | Impression par le navigateur (« Enregistrer en PDF ») |
| Passeport synoptique | Word paysage, PDF | Tâches grisées, situations à l'intersection activité × modalité, visa et zone de signature |
| Dossier complet | PDF | Passeport synoptique suivi des fiches d'analyse validées |
| Contexte commercial, attestation de stage | PDF | Documents pré-remplis à imprimer |
| Sauvegarde | JSON | Réimportable ; remplace le passeport actuel après confirmation |

### Passeport E4 : limites connues

- Le passeport est **local** : il n'est pas synchronisé entre appareils. Utilisez la
  sauvegarde JSON pour le déplacer.
- L'export PDF passe par la boîte d'impression du navigateur ; les fenêtres
  contextuelles doivent être autorisées.
- Les signatures et le cachet de l'établissement se posent sur la version imprimée :
  le visa saisi dans l'onglet Passeport n'est pas une signature électronique.
- Le référentiel et le modèle de fiche sont ceux du classeur CRCOM fourni
  (session 2019, mis à jour pour la session 2024) : vérifiez auprès de votre équipe
  pédagogique qu'ils correspondent à la session visée.
- Les nombres de situations attendus à l'examen ne sont pas imposés par le module : la
  liste de contrôle signale seulement les activités E4 non encore couvertes.
