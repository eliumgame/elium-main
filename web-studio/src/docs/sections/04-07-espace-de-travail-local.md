### Espace de travail local

L'accueil est un **espace de travail unique**. Il liste tous vos éléments locaux :
documents `.elium`, tableurs, présentations et PDF. Le catalogue ne garde que des
informations (titre, dossier, étiquettes, favori, dates, taille). Le contenu est
rangé dans des bases séparées par type, dans le stockage de l'application.

### Bibliothèque

- Dossiers imbriqués, étiquettes, favoris.
- Renommer, déplacer, dupliquer.
- Affichage en grille ou en liste, tri, filtres par type.
- **Sélection multiple** : clic, Ctrl, Maj, cases à cocher.
- **Glisser-déposer** vers un dossier (barre latérale, fil d'Ariane ou carte de dossier).
- Chaque tableur et chaque présentation est un élément distinct. Un élément resté vierge n'est pas enregistré.
- Un PDF déposé ou importé rejoint la bibliothèque.

### Corbeille

Tout « Supprimer » passe par la corbeille, **30 jours**, avec restauration. Le
nombre de jours restants est affiché. Supprimer un dossier emporte son contenu ;
le restaurer le ramène. Les éléments de plus de 30 jours sont purgés au démarrage.

« Vider la corbeille » et « Supprimer définitivement » demandent confirmation.
Ils effacent aussi les brouillons et les versions locales du document.

### Recherche dans tout l'espace

Ouvrez-la avec **Ctrl+Maj+F**, le champ de l'en-tête ou la palette de commandes.

| Point | Comportement |
|---|---|
| Ce qui est indexé | Titre et texte : documents, cellules texte des tableurs (formules ignorées), diapositives (titres, corps, notes, tableaux, titres de graphiques), texte des PDF |
| Plafond | 200 000 caractères par élément |
| Casse et accents | Ignorés |
| Syntaxe | Aucune syntaxe spéciale (pas de guillemets, pas de OR, pas de `-mot`) |
| Mots | **Tous** les mots sont exigés |
| Correspondance | Par **sous-chaîne** : « cont » trouve « contrat » |
| Classement | Bonus si la phrase exacte est présente |
| Résultats | 200 au maximum, avec surlignage. Au-delà, affinez la recherche |
| Filtres | Type, dossier, étiquette, « Modifié depuis », « Modifié jusqu'au » |

L'index est **incrémental** : seuls les éléments modifiés sont relus, en tâche de
fond. Il est conservé. Avec le coffre local, il est chiffré. Un élément pas encore
indexé est trouvé par son titre et ses étiquettes. Un `.elium` chiffré par son
propre mot de passe, ou un PDF protégé, n'est indexé que par son titre. Les
éléments verrouillés sont exclus.

Réglages, Espace de travail, **Reconstruire l'index** repart de zéro.

### Rechercher et remplacer dans les documents

Accessible par « Rechercher / remplacer dans les documents ».

1. Saisissez **Rechercher** et **Remplacer par**. Options : « Respecter la casse », « Mot entier ». Le texte est **littéral** (pas d'expression régulière).
2. **Analyser** : Elium liste chaque occurrence avec son contexte.
3. Cochez ce qui doit changer, puis **Remplacer**.
4. Vous pouvez **annuler** : les trois dernières opérations sont conservées.

Il ne s'applique qu'aux `.elium`. Les documents chiffrés sont signalés « Chiffré :
non analysable ». Les documents **signés** ou **scellés** sont décochés par
défaut : les modifier invalide les signatures. Un document modifié depuis l'analyse
n'est jamais écrasé.

### Récents et récupération après arrêt anormal

L'accueil affiche les éléments récents (de 4 à 24, réglable). Au démarrage,
Elium détecte une fermeture anormale (plantage, processus arrêté). Il affiche
alors « Elium ne s'est pas fermé correctement » avec les brouillons récupérables.

| Bouton | Effet |
|---|---|
| Récupérer | Rouvre le brouillon |
| Télécharger en .docx | Exporte le brouillon |
| Supprimer le brouillon, Tout supprimer | Efface |
| Rouvrir | Pour un PDF modifié non enregistré, quand le fichier d'origine est connu |
| Masquer | Ferme l'avis |

Un brouillon chiffré s'affiche sans aperçu et demande son mot de passe. Les
brouillons restent jusqu'à ce que vous les supprimiez ou les enregistriez.

### Coffre local

Optionnel. Avec le coffre actif, les titres, étiquettes, dossiers, tableurs,
présentations, PDF et l'index de recherche sont chiffrés au repos, avec un mot de
passe séparé. Activer, changer ou désactiver le coffre rechiffre tous les magasins,
avec retour arrière si l'un échoue. **Un mot de passe de coffre perdu est
irrécupérable** : le réinitialiser supprime aussi ces contenus.

### Sauvegarde et restauration `.elium-workspace`

**Réglages, Espace de travail.** Une archive zip contient les éléments, dossiers,
étiquettes, favoris, corbeille et réglages.

| Réglages sauvegardés | `elium_prefs`, raccourcis, langue, thème, correcteur, commandes récentes |
|---|---|
| Sur demande seulement | Identité de signature, clé de réception, carnet de confiance, sceaux épinglés |
| Jamais | Historique de versions locales, circuits Parapheur (ils sont dans les `.elium`), brouillons, racines de confiance C2PA et réglages du Détecteur |

- Le **mot de passe d'archive** est facultatif (Argon2id + AES-256-GCM). Sans lui, le fichier est lisible par quiconque le détient. Avec le coffre actif, l'archive contient les données **déchiffrées** : Elium vous avertit.
- La **restauration** montre le contenu avant d'agir. Pour un élément déjà présent : « Garder les deux », « Remplacer par la version de la sauvegarde » ou « Ignorer ».
- Un **rappel de sauvegarde** (7, 14 ou 30 jours) peut être activé.
- Limites de lecture : 256 Mo par entrée, 50 000 entrées.

### Sauvegarde de l'espace de travail dans le Drive

Avec un serveur Elium, Réglages → Espace de travail → Sauvegarde propose d'envoyer **tout l'espace de travail** (documents, tableurs, présentations, PDF et dossiers) dans le Drive entreprise.

- C'est la même archive `.elium-workspace` que la sauvegarde manuelle, déposée à la racine du Drive sous le nom « Espace-de-travail-Elium.elium-workspace ». Le Drive la chiffre de bout en bout et le serveur en garde les versions successives. Les clés et l'identité de l'appareil n'y sont jamais incluses.
- **Sur demande** : « Sauvegarder maintenant » et « Restaurer depuis le Drive » (la restauration passe par le même dialogue que la restauration d'un fichier, avec choix en cas de conflit).
- **Automatique** : en cochant « Sauvegarder automatiquement », l'archive est renvoyée une minute après la dernière modification d'un élément, tant que la session Drive est déverrouillée. Elle l'est avec le mot de passe du Drive, saisi dans cette même section ; les clés ne sont jamais conservées, il faut donc la redéverrouiller après chaque rechargement de la page.
- Si une sauvegarde plus récente existe dans le Drive (autre appareil), l'envoi s'arrête : on peut la consulter ou l'écraser. L'automatique reste suspendu jusqu'à une action manuelle.
- Chaque envoi renvoie l'archive entière : avec de gros PDF, préférez la sauvegarde manuelle espacée.

### Ouvrir et enregistrer en place

Dans l'application de bureau et les navigateurs Chromium, **Ouvrir…** (Ctrl+O) et
**Enregistrer** (Ctrl+S) utilisent l'API d'accès aux fichiers. Le fichier est
**réécrit sur place**, sa poignée est conservée et la permission est redemandée
si besoin. **Enregistrer sous…** est Ctrl+Maj+S. Sans cette API (Firefox, Safari),
Elium télécharge le fichier.

### Fichiers locaux (application Windows)

Dans l'application Windows, vos travaux sont **aussi enregistrés en fichiers** dans
`Documents\Elium` (dossier modifiable par la clé `files_dir` du fichier
`%LocalAppData%\Elium\launcher-config.json`). IndexedDB reste le cache de travail
des modules ; le dossier en est le **miroir durable** : si l'adresse locale
change (port occupé) ou si les données du navigateur sont effacées, Elium
**réimporte au démarrage** les éléments présents en fichiers et absents de la base.
La restauration ne fait qu'**ajouter** : elle n'écrase jamais.

| Dossier | Contenu |
|---|---|
| `Documents\` | documents `.elium` (octets du format v2, ouvrables par double-clic) |
| `Classeurs\`, `Presentations\` | modèles `.classeur.json` / `.presentation.json` |
| `PDF\` | fichiers PDF |
| `Passeport\` | passeport professionnel E4 |
| `Annexes\` | brouillons de récupération (Documents et PDF), historique de versions, polices importées, annexes du passeport, circuits Parapheur (`*.elium-extra`), réglages (`reglages.json`) |
| `Sauvegardes\` | copie de sécurité `avant-migration-AAAA-MM-JJ.elium-workspace` |
| `_elium\`, `.corbeille\` | catalogue et état ; fichiers retirés (purgés après 30 jours) |

- **1er lancement** : une copie de sécurité complète est écrite avant le premier miroir ; rien n'est supprimé de la base.
- **Coffre local actif** : rien n'est écrit en clair. Contenus, catalogue et passeport sont scellés (extension `.vault`, nom réduit à l'identifiant). Les restaurer exige le coffre déverrouillé avec le même mot de passe. Activer le coffre après coup remplace les copies en clair, effacées définitivement.
- **Sécurité de l'accès** : le lanceur n'accepte les requêtes de fichiers qu'avec le jeton de la session (présent seulement dans la page servie), depuis l'origine de l'application ; les chemins sont logiques, validés (dossiers et extensions autorisés, noms Windows interdits) et confinés au dossier de travail.
- **Sur le site** : pas de fichiers ; Elium demande au navigateur un **stockage persistant** pour limiter l'éviction des données.
- L'état du miroir s'affiche dans Réglages, Sauvegarde.

**Cache vidé ?** Au prochain lancement, tout revient automatiquement depuis `Documents\Elium` (éléments, brouillons, historique, polices, réglages), sans fenêtre de confirmation. Si un même enregistrement existe des deux côtés, **le plus récent gagne** et le plus ancien ne remplace jamais le plus récent ; les réglages locaux déjà présents ne sont pas écrasés. Les clés privées et identités ne sont **jamais** écrites dans ce dossier.

Limites : les réglages du Détecteur ne sont pas miroités ; un fichier modifié à la main n'est pris en compte qu'au démarrage et seulement s'il manque dans la base.

### Limites connues de l'espace de travail

- Le travail vit dans la base de ce profil et, dans l'application Windows, dans `Documents\Elium` (voir ci-dessus). Aucune synchronisation entre PC.
- La recherche n'a pas de syntaxe avancée et plafonne à 200 résultats.
- Le remplacement en lot ne traite pas les tableurs et les PDF.
- La sauvegarde ne contient pas l'historique de versions locales.
- Un mot de passe de coffre ou d'archive perdu ne se récupère pas.
