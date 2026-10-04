### Détecteur

Le Détecteur est une **aide à la relecture**. Il analyse un fichier et signale des
**indices**. Il ne rend jamais de verdict : le score de 0 à 100 est indicatif, et
le rapport rappelle toujours qu'il n'est pas une preuve.

Formats acceptés : `.elium`, `.docx`, `.pdf`, `.png`, `.jpg`, `.webp`. Les fichiers
protégés par mot de passe ne sont pas analysés.

### Ce qui est analysé

| Famille | Exemples d'indices |
|---|---|
| Texte | Régularité des phrases et des paragraphes, tournures répétées, amorces répétées, tiret cadratin, densité de listes |
| Mise en forme | Incohérences de styles |
| Métadonnées | Révisions, temps d'édition, dates |
| Images | Marqueurs de provenance, justificatifs C2PA |
| Plagiat (optionnel) | Voir plus bas |

Chaque indice cite la valeur mesurée et son seuil. Les seuils du texte **ne sont
pas calibrés sur un corpus réel**. Un document administratif ou technique très
structuré peut donc déclencher de faux positifs.

### Réglages de sensibilité

« Réglages de sensibilité » permet de **désactiver des signaux un par un**. Le choix
est mémorisé sur l'appareil. Le bouton « Appliquer le préréglage style
administratif/technique » coupe les signaux les plus sensibles à ce type de
texte. Il n'y a pas de curseur de seuil.

### Aperçu annoté

Le rapport propose « Aperçu du document » : les passages repérés sont soulignés en
rouge. L'aperçu charge 400 paragraphes à la fois (boutons « Charger les
paragraphes précédents » et « suivants »). Depuis un indice, « Voir dans le
document » y amène.

### Vérification C2PA des images

C2PA est un standard de justificatifs de contenu : un manifeste signé indique
qui a produit une image et comment. Elium **vérifie réellement** ce manifeste :

- lecture des boîtes JUMBF et du CBOR (JPEG, PNG, WebP) ;
- signature COSE (ES256, ES384, ES512, PS256, PS384, PS512, EdDSA) ;
- chaîne de certificats X.509 ;
- liaison de la signature aux octets réels de l'image (`c2pa.hash.data`) et empreintes des assertions ;
- mention d'une génération par IA (`trainedAlgorithmicMedia`) lue dans les actions.

Pour un `.docx`, un `.pdf` ou un `.elium`, seules les images **incorporées** sont
vérifiées.

| Issue | Sens | Poids dans le score |
|---|---|---|
| Valide, émetteur reconnu | Signature correcte, racine dans votre liste de confiance | Fort |
| Valide, émetteur non reconnu | Signature correcte, mais n'importe qui peut signer avec son certificat | Moyen |
| Invalide | Image ou manifeste altéré. Une retouche légitime non re-signée donne le même résultat | Faible |
| Non vérifiable | Manifeste illisible ou incomplet | Signalé comme provenance non authentifiée |
| Absent | Aucun manifeste | **Non concluant**, jamais une preuve d'authenticité |

#### Liste de confiance importable

**Aucune racine n'est embarquée.** Importez les vôtres : « Racines de confiance
C2PA », bouton « Importer des racines… ». Formats `.pem`, `.cer`, `.crt`, `.der`.
La confiance repose sur l'empreinte SHA-256 du certificat. Le bouton « Retirer la
racine… » supprime une entrée. Sans racine, toute signature valide est « émetteur
non reconnu ».

La liste est conservée dans le stockage de l'application. Elle n'est **pas**
incluse dans la sauvegarde `.elium-workspace`.

### Analyse par lot

« Choisir un ou plusieurs fichiers… » ou « Analyser un dossier… ». Chaque fichier
est analysé seul : un fichier illisible n'arrête pas le lot. Le traitement est
séquentiel et annulable.

Le tableau montre Fichier, Statut, Score global, Confiance, Principaux constats,
C2PA. Exports : **CSV** (séparateur « ; », protégé contre l'injection de formule)
et **JSON**.

> Le lot **n'exécute pas** la recherche de plagiat.

### Rapport

Pour un fichier : « Exporter en .docx » ou « Exporter en PDF » (impression du
navigateur). Le rapport contient le score, les constats, le plagiat s'il a été
lancé et une section « Document analysé (annoté) ». Cette section reproduit le
texte, les titres et les listes, pas la mise en forme d'origine.

### Recherche de plagiat (optionnelle)

Case « Vérifier aussi le plagiat sur le web ». Choisissez un moteur (Serper ou
Bing) et saisissez **votre** clé API. Elium envoie jusqu'à 60 extraits
distinctifs, jamais le document entier, et compare les résultats à de courts
extraits. Aucune base académique n'est consultée.

- La clé API est stockée **en clair** dans le stockage de l'application.
- Une absence de correspondance ne prouve rien.

### Limites connues du Détecteur

- **Plagiat bloqué dans l'application de bureau.** La politique de sécurité du lanceur autorise les connexions vers l'application elle-même uniquement. Les requêtes vers Serper et Bing y sont refusées : chaque passage échoue. L'interface ne prévient pas. Le plagiat n'est utilisable que dans une version web servie sans cette politique, et à condition que le moteur accepte les appels depuis le navigateur (non vérifié).
- Ce sont des indices statistiques, pas un modèle d'IA entraîné et pas un verdict.
- Seuils non calibrés : faux positifs possibles sur les textes administratifs.
- Révocation des certificats, horodatage RFC 3161, usages de clé et `c2pa.hash.bmff` ne sont **pas** vérifiés.
- La vidéo n'est pas acceptée à l'import : seuls les formats listés plus haut le sont.
- L'absence de manifeste C2PA est non concluante.
- Les réglages de sensibilité et les racines de confiance ne voyagent pas avec les sauvegardes.
