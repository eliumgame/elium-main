## Les sept profils de protection

Un **profil** est un préréglage qui active un sous-ensemble de protections : chiffrement,
mot de passe, verrouillage, journal de suivi, signatures. La protection est
**optionnelle et additive** : on part de `standard` et on en ajoute quand on veut.
Changer de profil d'un document existant ajoute un évènement `protection.enabled` à
son journal quand le suivi est actif.

### Ce que chaque profil active

| Profil | Nom affiché | Corps chiffré | Mot de passe | Couche ChaCha20 | Journal de suivi | Verrouillé | Signatures attendues |
|---|---|:---:|:---:|:---:|:---:|:---:|:---:|
| `standard` | Document simple | non | non | non | non | non | non |
| `signed` | Document signé | non | non | non | oui | non | oui |
| `tracked` | Document suivi | non | non | non | oui | non | non |
| `protected` | Document privé | oui | oui | non | non | non | non |
| `encrypted` | Document confidentiel | oui | oui | non | non | non | non |
| `locked` | Document final | non | non | non | oui | oui | oui |
| `secure_max` | Document ultra sécurisé | oui | oui | oui | oui | oui | oui |

Le sceau Ed25519 et les signatures s'ajoutent à tout profil dès qu'une identité est
disponible ; ils ne dépendent pas du profil.

### Ce que ces colonnes veulent dire

- **Corps chiffré** : le contenu est chiffré en AES-256-GCM avec Argon2id (mot de
  passe et/ou fichier-clé), ou pour des destinataires. Voir « Cryptographie ». Les
  profils `protected` et `encrypted` sont **techniquement identiques** : seuls le nom
  et le badge changent. Tous les profils chiffrés acceptent un fichier-clé, des
  destinataires et le chiffrement des métadonnées.
- **Couche ChaCha20** : seule `secure_max` ajoute ChaCha20-Poly1305 par-dessus
  AES-256-GCM, avec un mot de passe comme avec des destinataires.
- **Journal de suivi** : le journal chaîné par empreinte est créé avec le document
  (évènement `document.created`) et tenu à jour. Un document peut aussi avoir un
  journal sans profil de suivi s'il en a déjà un.
- **Verrouillé** : le manifeste porte `protection.locked: true`, ce champ est **signé
  par le sceau**, et le journal reçoit un évènement `document.locked`. Dans cette
  version, ce verrouillage est une **déclaration vérifiable**, pas un blocage de
  l'éditeur : l'application n'empêche pas de continuer à modifier le document (et
  d'enregistrer un nouveau fichier). Elle désactive seulement les brouillons
  automatiques d'un document verrouillé.
- **Signatures attendues** : le profil s'attend à ce que le document soit signé.
  Rien ne l'**impose** : aucun blocage si aucune signature n'est posée.

### Scellement et avertissement

Les profils `signed`, `tracked`, `locked` et `secure_max` **promettent** une garantie
d'intégrité (suivi, verrouillage ou signature). Cette promesse n'est vérifiable que si
le document est **scellé**, car le hash de contenu seul est recalculable par un
attaquant. Quand un tel profil n'est pas scellé, le bandeau de vérification passe à
« à confirmer » au lieu d'afficher « document intègre ».

Un profil chiffré protège la **confidentialité**. La détection d'altération vient du
sceau, pas du chiffrement : le chiffrement authentifié empêche une modification du
corps sans le mot de passe, mais le manifeste, les signatures et le journal restent en
clair par défaut (voir « Chiffrement optionnel des métadonnées »).

### Choisir un profil

| Besoin | Profil |
|---|---|
| Échanger un document sans protection particulière | `standard` |
| Garder la trace de qui a fait quoi | `tracked` |
| Prouver l'auteur et garder un journal | `signed` |
| Que personne sans le mot de passe ne puisse lire | `encrypted` (ou `protected`) |
| Figer une version finale, signée et suivie | `locked` |
| Confidentialité maximale, avec trace et signature | `secure_max` |

### Ce que les profils ne font pas

- Aucun profil non chiffré n'apporte de **confidentialité**. Un `.elium` `locked`,
  `signed` ou `tracked` est lisible par tout le monde.
- Aucun profil ne fournit une **signature électronique qualifiée** ni une
  non-répudiation au sens légal (voir « Modèle de sécurité et de menace »).
- Aucun profil ne protège contre un poste compromis.
- Le nom d'un profil, le badge et les descriptions affichées dans l'interface sont des
  libellés. Ce qui est vérifiable, ce sont les champs du manifeste (`encrypted`,
  `locked`, `keyfileRequired`) et le sceau qui les couvre.

---
