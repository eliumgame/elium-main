## Signatures — Elium Sign

Elium Sign repose sur **deux couches volontairement séparées** : la marque visible
d'une signature (une intention) et sa preuve cryptographique (un fait vérifiable).
S'y ajoutent le **sceau** du document, la signature **PDF** (PAdES) et deux façons de
faire signer d'autres personnes.

### Signature visuelle (toujours)

Dessin, texte tapé, image, tampon (Approuvé, Validé, Confidentiel, Payé, Reçu…),
initiales, QR code, ou mixte. Le placement est libre : déplacement, redimensionnement,
rotation, ordre d'empilement, ancrage à la page ou à un paragraphe. Il est stocké en
**pourcentage de la page**, donc portable d'un affichage à l'autre.

Seule, une signature visuelle **n'est pas une preuve** : une image se copie. C'est une
marque d'intention.

### Preuve cryptographique (optionnelle, niveau « avancé »)

La preuve est une signature **Ed25519** posée sur une structure canonique :

```
{ v:1, signatureId, signedContentHash, signer, signedAt,
  signedPlacement?, signedVisual? }
```

- `signedContentHash` est le SHA-256 du JSON canonique du **modèle du document**
  (réglages de page, styles et contenu) ;
- `signer` reprend le nom, le rôle et l'organisation saisis ;
- `signedPlacement` et `signedVisual` lient la preuve à **l'endroit** et à
  **l'apparence** de la signature. Déplacer ou modifier la signature après coup rend
  le statut `modified`. Les anciennes preuves sans ces champs restent vérifiables,
  sans couvrir le placement ;
- la preuve contient la clé publique et son empreinte, et un horodatage **local**
  non qualifié.

### Statuts (toujours recalculés à l'ouverture, jamais lus tels quels)

| Statut | Signification |
|---|---|
| `valid` | La signature est authentique **et** le document est identique à l'état signé |
| `modified` | La signature est authentique mais le document (ou la signature elle-même) a changé depuis |
| `invalid` | La signature ne vérifie pas |
| `unknown_key` | Une clé de confiance a été fournie et elle ne correspond pas à celle du signataire |
| `visual_only` | Signature visuelle sans preuve cryptographique |

`valid` est un verdict **purement cryptographique**. Sans clé de confiance fournie, il
dit « authentique et intacte », pas « signée par la personne dont le nom s'affiche ».
Le Web Studio traite l'attribution à part : une preuve dont la clé n'est pas dans le
carnet de confiance s'affiche comme « non attribuée », jamais en confiance pleine.

### Sceau et signatures : à quoi sert chacun

| | Sceau | Signature placée |
|---|---|---|
| Nombre | Un par fichier | Autant que de signataires |
| Ce qu'il couvre | Une partie du manifeste, **toutes** les signatures, le journal | L'état du contenu au moment de signer, plus le placement et l'apparence |
| Qui | L'auteur qui enregistre | Chaque signataire |
| Sert à | Détecter une altération du fichier | Prouver qu'une clé a signé un état |

Le sceau est posé à l'enregistrement dès qu'une identité est disponible, quel que soit
le profil. Il est décrit dans « Le sceau de document ». Un sceau **valide** dit que le
fichier n'a pas changé depuis qu'une clé donnée l'a scellé ; il ne dit pas qui possède
cette clé.

### Identité et mots de sécurité

L'**identité** d'un signataire est une paire de clés Ed25519 gardée dans le trousseau
(voir « Elium Keys »). Elle est créée sans compte ni serveur. Son **empreinte** est le
SHA-256 de la clé publique.

Une empreinte de 64 caractères hexadécimaux ne se compare pas à l'oreille. Les **mots
de sécurité** la rendent mémorisable : six mots tirés d'une liste fixe de 64 mots
français (6 bits par mot, 36 bits au total). Deux personnes peuvent les comparer au
téléphone ou en face à face. Ce n'est pas un secret, c'est une aide à la comparaison
d'une empreinte publique.

Pour attribuer un nom à une clé, ajoutez-la au carnet de confiance : « scellé par
Alice » ou « signé par Alice » remplace alors « clé non vérifiée ». Le niveau de
confiance du contact (non vérifié, vérifié par mots de sécurité) est détaillé dans
« Elium Keys ».

### Épinglage TOFU du sceau

Un sceau prouve qu'un fichier n'a pas été modifié, pas **qui** l'a scellé : un
attaquant peut re-sceller un document falsifié avec sa propre clé et obtenir un sceau
`valid`. L'épinglage **TOFU** (*trust on first use*) réduit ce risque pour les
documents que vous revoyez :

1. à la **première** ouverture d'un document scellé de façon authentique, Elium
   mémorise la clé de son sceau (état « nouveau », puis « épinglé ») ;
2. si une version ultérieure du **même document** présente une **autre** clé de
   sceau, le bandeau de vérification passe en alerte et affiche les mots de sécurité
   de l'ancienne et de la nouvelle clé ;
3. vous pouvez **approuver** la nouvelle clé : l'épingle est remplacée.

L'épinglage est local à votre navigateur. Il est indexé par la date de création du
document (`createdAt`), qui est couverte par tous les sceaux, anciens comme récents.
Un document réellement nouveau donne simplement l'état « nouveau », sans alerte.
L'état « clé révoquée ou expirée » du carnet s'affiche à côté.

### Signature PDF (PAdES)

Un PDF se signe avec une signature **PAdES** : un dictionnaire de signature standard
dans le fichier PDF, que les lecteurs comme Acrobat savent afficher.

| Élément | Détail |
|---|---|
| Format | CMS détaché, sous-filtre `ETSI.CAdES.detached`, attributs signés : type de contenu, empreinte du message, certificat du signataire (`signing-certificate-v2`) |
| Algorithmes | RSA (PKCS#1 v1.5) ou courbes elliptiques P-256, P-384, P-521, via WebCrypto |
| Ajout | Une **mise à jour incrémentale** : les octets précédents ne bougent pas, donc les signatures antérieures restent valides et plusieurs personnes signent à la suite |
| Identité auto-signée | Un certificat RSA-2048 créé dans l'application, dont la clé est **non extractable** (elle ne quitte pas le magasin de clés du navigateur) |
| Fichier `.p12` | Importable pour utiliser votre propre certificat |
| Apparence | Facultative : signature visible à l'endroit choisi |
| Niveaux | Signature d'approbation, ou certification avec restrictions de modification (DocMDP) et verrous de champs (FieldMDP) |

À la vérification, Elium recalcule l'empreinte de chaque plage d'octets, contrôle la
signature CMS et le certificat, puis cherche une chaîne jusqu'à une **identité de
confiance de votre liste**. Il n'utilise pas de magasin de certificats du système. Il
compare aussi la révision signée au fichier final pour dire ce qui a changé depuis, au
regard du niveau de certification.

Un certificat **auto-signé** n'a pas d'autorité de certification : les autres lecteurs
affichent « identité non vérifiée » tant que le destinataire n'a pas ajouté votre
certificat exporté à ses identités de confiance. Pour une coche « approuvée », utilisez
un `.p12` d'une autorité reconnue.

### Horodatage RFC 3161

Une signature PDF peut être **horodatée** par une autorité (TSA) selon la RFC 3161. Le
jeton d'horodatage est ajouté à la signature. Seule l'**empreinte** de la signature
quitte l'appareil, jamais le document.

Les autorités répondent rarement aux appels directs d'un navigateur. Elium passe donc
par un **relais** :

- l'application de bureau expose `/__tsa__` (protégé par le jeton de session) ;
- le Drive d'entreprise expose `POST /api/tsa` ;
- sans relais, l'application tente un appel direct à l'autorité.

Le relais est borné : requête de 8 Kio au plus, réponse de 64 Kio au plus, délai de 15
secondes, redirections jamais suivies, adresses **publiques** uniquement (le nom est
résolu une seule fois et la connexion se fait vers l'adresse vérifiée, contre le
rebond DNS). L'autorité proposée par défaut est un service public gratuit ; vous pouvez
indiquer la vôtre.

À la vérification, une heure d'horodatage n'est retenue que si l'autorité qui l'a
émise est elle-même de confiance ; sinon elle est affichée, sans servir de preuve de
date. L'horodatage d'une preuve `.elium` reste, lui, **local**.

### Demande de signature par fichier (circuit parapheur)

Pour faire signer un `.elium` par plusieurs personnes **sans serveur ni compte** :

1. Dans le panneau **Parapheur**, vous listez les signataires dans l'ordre de signature.
2. « Envoyer une demande de signature » enregistre le `.elium`. Le **circuit voyage
   dans le fichier** (`parapheur/circuit.json`) : le fichier exporté **est** la demande.
3. Vous l'envoyez par le moyen de votre choix (courriel, messagerie, clé USB).
4. Chaque signataire l'ouvre dans Elium, génère au besoin une identité (aucun compte),
   signe **sa** partie avec une vraie preuve Ed25519, enregistre, et renvoie le fichier.
5. Vous réimportez le fichier renvoyé : les signatures et l'état des parties s'y
   trouvent.

Précisions :

- l'**ordre** est appliqué par l'interface (seule la partie suivante peut signer), pas
  par la cryptographie ;
- le circuit est une métadonnée **modifiable, non scellée**. La vérité cryptographique
  est dans les preuves Ed25519, qui sont, elles, couvertes par le sceau ;
- le circuit contient des noms : avec le chiffrement des métadonnées, il est chiffré ;
- il se lit et s'écrit aussi en Python.

### Signature à distance par lien

Un signataire **sans compte Elium** peut signer via un lien envoyé hors bande. Cette
fonction appartient au **Drive d'entreprise**. L'émetteur crée une demande de 1 à 50
parties, chacune avec son propre lien, avec en option : signature dans l'ordre, date
d'expiration du lien, date limite.

Le déroulé :

1. Le signataire ouvre une page dédiée. Le secret du lien est dans le **fragment
   d'URL** (`#k=…`), qui n'est **jamais envoyé au serveur**. Le document est déchiffré
   **dans son navigateur**.
2. Pour un `.elium`, une identité Ed25519 est générée à la volée et la preuve est
   posée. Pour un PDF, une signature PAdES est posée avec un certificat auto-signé
   généré à la volée (RSA-2048). Dans les deux cas **la clé privée ne quitte jamais le
   navigateur du signataire**.
3. L'artefact signé est **rechiffré** sous la même clé de contenu et renvoyé par une
   route publique protégée par le jeton du lien (`POST /api/links/:token/sign`). Le
   serveur ne voit que du chiffré, à l'aller comme au retour.
4. Le signataire peut aussi **refuser** de signer. L'émetteur peut relancer un lien
   expiré sans le régénérer.

Le serveur applique : lien non révoqué et non expiré, une seule signature par partie,
ordre respecté si demandé, date limite, taille maximale de l'artefact, limitation de
débit. Le jeton n'est stocké que sous forme d'empreinte.

À la fin, l'interface affiche au signataire les **mots de sécurité** de sa clé
générée : l'émetteur peut les comparer par un autre canal.

### Vérification en ligne de commande

Le miroir Python vérifie les mêmes preuves et le même sceau :

| Commande | Effet |
|---|---|
| `elium doc-verify <fichier>` | Vérifie intégrité, journal, sceau et signatures. `--trusted <clé>` fournit la clé de confiance, `--report <fichier>` écrit un rapport de preuve JSON |
| `elium doc-sign <fichier> --key <fichier de clé> --name …` | Ajoute une preuve Ed25519, et re-scelle avec `--seal-key` |

Pour un document chiffré pour des destinataires, voir `--recipient-kid` dans « Ligne de
commande : `elium keys` ».

### Limites connues des signatures

- **Pas de signature qualifiée.** Voir « Modèle de sécurité et de menace ».
- **Retrait de signature.** Sur un document **non scellé et non chiffré**, un tiers peut
  retirer une signature et reconstruire le paquet. Pour une garantie forte, scellez le
  document (profils `locked` ou `secure_max`, avec une identité) **et** vérifiez la clé
  du signataire hors bande.
- **Horodatage `.elium` local.** La date d'une preuve est celle de l'horloge du
  signataire. Rien ne prouve qu'une signature a précédé la compromission d'une clé.
- **Révocation non vérifiée.** Pour une signature PDF, Elium ne consulte ni OCSP ni
  liste de révocation : il ne détecte pas un certificat révoqué, y compris hors ligne.
  La révocation d'une clé `.elium` est locale.
- **Pas d'anti-rollback.** Une ancienne version valide d'un document scellé reste
  valide.
- **Lien de signature = jeton porteur.** Quiconque détient le lien entier (avec son
  fragment) peut signer à la place du destinataire prévu. Le serveur ne vérifie pas la
  signature, il la transporte : l'émetteur doit vérifier l'artefact reçu et comparer
  les mots de sécurité.
- **Certificat auto-signé.** Les signatures posées à distance sur un PDF s'affichent
  « identité non vérifiée » chez le destinataire.
- **Circuit non scellé.** L'ordre et l'état des parties d'un circuit par fichier ne
  sont pas garantis cryptographiquement.
- **Les chaînes de certificats** ne sont validées que contre vos identités de confiance.

---
