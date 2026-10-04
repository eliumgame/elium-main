## Elium Keys

**Elium Keys** est le trousseau unique qui garde vos clés : votre **identité de
signature** (Ed25519) et votre **clé de réception** (P-256, pour recevoir des
documents chiffrés). On le trouve dans *Réglages, Sécurité* et dans le panneau
Sécurité d'un document, sous le nom « Mes clés ».

Il remplace deux anciennes entrées indépendantes (une par clé, chacune avec son
mot de passe, sans sauvegarde de la clé de réception ni expiration). Ce chapitre
décrit le modèle, la récupération et les limites. Le Drive d'entreprise a ses
propres clés de compte : voir « Authentification ».

### Ce que contient le trousseau

Le trousseau est une base **IndexedDB** nommée `elium-keys`, locale à ce navigateur
ou à cette application de bureau. Elle a deux magasins : les clés (`keys`) et des
métadonnées (`meta`), dont l'enregistrement du secret maître.

| Type d'entrée | Rôle | Usage |
|---|---|---|
| `identity-ed25519` | Signer, sceller, prouver | signer |
| `recipient-p256` | Recevoir des documents chiffrés pour vous | déchiffrer |
| `contact` | Type réservé dans le modèle. Le carnet de confiance n'est **pas** stocké ici | aucun |

Chaque clé porte ces champs :

| Champ | Contenu |
|---|---|
| `id` (`kid`) | 16 premiers caractères hexadécimaux de l'empreinte |
| `type`, `suite` | Type de clé et suite d'algorithmes (`ed25519/1` ou `p256-ecdh-es/1`) |
| `label` | Nom que vous donnez à la clé |
| `createdAt`, `expiresAt` | Création, expiration facultative |
| `status` | `active`, `retired` ou `revoked` |
| `publicHex`, `fingerprint` | Clé publique, et SHA-256 de la clé publique |
| `protection` | `derived` (dérivée du secret maître) ou `password` (clé héritée, avec son propre mot de passe) |
| `derivationIndex` | Rang de dérivation, pour une clé dérivée |
| `backedUpAt`, `retiredAt`, `revokedAt` | Dates de sauvegarde, de retrait et de révocation |
| `succession` | Certificat de succession, après une rotation d'identité |

Pour que l'application démarre sans attendre IndexedDB, et pour permettre un retour
en arrière, la clé **active** est aussi recopiée dans `localStorage`
(`elium_identity`, `elium_recipient_key`). Cette copie ne contient que la clé
publique, l'empreinte et, pour une clé héritée, son blob chiffré. Elle est vide de
secret pour une clé dérivée.

### Statuts des clés : actif, retiré, révoqué, expiré

| État | Signification | Signer ou recevoir | Vérifier ou déchiffrer l'ancien |
|---|---|:---:|:---:|
| Active | Clé courante du type | oui | oui |
| Retirée | Remplacée ou mise de côté. Réactivable | non | oui |
| Révoquée | Déclarée compromise ou abandonnée. **Non réactivable** | non | oui |
| Expirée | État **calculé** : une clé active dont la date d'expiration est passée | non | oui |

Une clé retirée, révoquée ou expirée **reste utilisable pour déchiffrer** d'anciens
documents. C'est voulu : sinon une rotation rendrait vos archives illisibles.

Actions disponibles sur chaque ligne : Exporter, Copier la clé publique, Faire
tourner (clé active seulement), Expiration, Retirer, Réactiver (clé retirée
seulement), Révoquer, Supprimer. Chaque ligne affiche l'empreinte, six mots de
sécurité, la date de création, l'expiration, l'état de sauvegarde et le mode de
protection.

**Supprimer une clé** exige qu'elle ait été sauvegardée. Pour une clé jamais
sauvegardée, l'interface demande une confirmation explicite de la perte.

### Migration depuis les anciennes clés

Au premier démarrage, Elium lit les anciennes entrées `localStorage`
(`elium_identity` et `elium_recipient_key`) et crée les clés correspondantes dans le
trousseau, une seule fois. La migration est **idempotente** et ne supprime
**jamais** l'ancienne entrée : elle reste lisible comme repli. Ces clés héritées
gardent leur propre mot de passe (`protection: password`).

La fonction « Changer le mot de passe » du trousseau les passe sous le nouveau mot de
passe si elles s'ouvrent avec l'ancien. Celles qui s'ouvrent avec un autre mot de
passe sont listées comme non traitées. L'opération recalcule tout en mémoire avant
toute écriture : un mauvais ancien mot de passe ne laisse aucun état intermédiaire.

### Un mot de passe et un secret maître

Quand vous créez votre première clé, Elium vous demande **un mot de passe de
trousseau** (4 caractères au minimum : choisissez un mot de passe long). Il tire
alors un **secret maître** de 32 octets au hasard et le chiffre avec ce mot de
passe (conteneur v3, Argon2id profil `document`). Un seul mot de passe déverrouille
identité **et** clé de réception.

Les nouvelles clés sont **dérivées** du secret maître. Conséquence importante :
protéger le secret maître protège **toutes** les clés dérivées d'un coup. La phrase
de récupération, les parts de Shamir, les clés d'accès et la couche Windows
protègent ce secret.

### Dérivation des clés

Les clés se dérivent du secret maître par HKDF-SHA-256 (sel de 32 octets nuls,
secret maître comme matériau). L'index `i` est un entier de 0 à 16 777 215. La
dérivation n'existe que dans le Web Studio : la ligne de commande crée des clés
aléatoires, sans secret maître.

| Clé | Dérivation |
|---|---|
| Ed25519 | graine = HKDF, info `elium-keyring/ed25519/<i>`, 32 octets |
| P-256 | `d` = (HKDF, info `elium-keyring/p256/<i>`, 48 octets, lus comme entier grand-boutiste) modulo (n − 1), plus 1 |

Les 48 octets rendent le biais de la réduction négligeable. Une rotation consomme
simplement l'index suivant. Le trousseau garde deux compteurs (`nextIndex`), un par
type.

### Verrouillage manuel et par inactivité

Une **session** garde en mémoire le secret maître et les clés privées déverrouillées.
Elle se déverrouille par le mot de passe, par une clé d'accès, ou par le secret
maître retrouvé (phrase, parts). Elle se verrouille :

- à la demande, avec « Verrouiller maintenant » ;
- après **15 minutes** par défaut sans utilisation d'une clé. Le réglage propose 1,
  5, 15, 30 ou 60 minutes, ou jamais ;
- à la fermeture ou au rechargement de l'application.

Au verrouillage, le secret maître est **écrasé de zéros** et la liste des clés
privées est vidée. Le fichier-clé du document ouvert est lui aussi oublié.

Précisions honnêtes :

- Le minuteur d'inactivité est réarmé par **l'usage d'une clé** (signer, sceller,
  déchiffrer), pas par chaque mouvement de souris.
- Les clés privées sont manipulées en JavaScript sous forme de chaînes
  hexadécimales. Le moteur ne peut pas écraser ces chaînes : il les **libère** et
  laisse le ramasse-miettes les effacer. Seul le secret maître est écrasé
  explicitement. Un attaquant qui lit la mémoire du processus pendant que le
  trousseau est déverrouillé peut donc récupérer des clés (voir « Modèle de
  sécurité et de menace »).

### Passkeys locales du trousseau

Une **passkey** (clé d'accès WebAuthn avec l'extension PRF) déverrouille le
trousseau sans taper le mot de passe : Windows Hello, Touch ID ou clé de sécurité.

- Vous pouvez en enrôler **plusieurs** (par exemple l'appareil et une clé de
  sécurité). Chacune détient une **enveloppe indépendante** du secret maître,
  chiffrée en AES-256-GCM sous le secret PRF de cette passkey, avec un sel PRF
  propre au trousseau.
- N'importe laquelle déverrouille le trousseau. **Révoquer** une passkey supprime
  son enveloppe sans toucher aux autres ni au mot de passe.
- La vérification de l'utilisateur est exigée à chaque usage.
- Si le navigateur ou l'authentificateur ne gère pas PRF, l'enrôlement échoue
  proprement et le **mot de passe reste le moyen de déverrouillage**.

Limites : l'enveloppe est stockée dans **ce** trousseau local. Une passkey ne sert
donc à rien sur un autre ordinateur tant que vous n'avez pas restauré le trousseau.
Révoquer une passkey supprime l'enveloppe locale, mais ne change pas le secret
maître. Elle n'ouvre pas les clés héritées protégées par leur propre mot de passe.

### Protéger avec Windows

Dans l'application de bureau sous Windows, une case « Protéger avec Windows » ajoute
une couche **facultative**. L'enveloppe du secret maître (déjà chiffrée par le mot
de passe) est ré-enveloppée par **Windows DPAPI**, portée utilisateur courant, via
le lanceur local (`/__keystore__/wrap` et `/__keystore__/unwrap`, protégé par un
jeton de session).

- Elle s'**ajoute** au mot de passe, elle ne le remplace pas.
- Le blob est illisible sur une autre machine ou un autre compte Windows, **même
  avec le bon mot de passe**. L'interface le dit : utilisez la phrase de
  récupération ailleurs.
- Elle n'existe pas dans un navigateur ni sur une autre plateforme : le trousseau y
  fonctionne comme avant.
- Elle ne protège que l'enveloppe par mot de passe. La sauvegarde `.eliumkey` et
  la phrase de récupération restent portables, par conception.
- Elle ne protège pas contre un logiciel malveillant qui s'exécute **sous votre
  compte Windows** : DPAPI déchiffre pour ce compte.

---
