## Cryptographie

### Principe : la sécurité dépend du profil

Les protections sont **optionnelles**. Les profils `standard`/`signed`/`tracked`/
`locked` laissent le contenu **non chiffré** (portable mais pas confidentiel ;
`locked`/`tracked` offrent de la *détection d'altération*, pas de la
confidentialité). Les profils `protected`/`encrypted`/`secure_max` chiffrent le
corps.

### Primitives (zéro crypto maison)

- **KDF** : Argon2id (t=3, m=256 MiB, p=4 par défaut) — résistant GPU/ASIC.
- **Chiffrement authentifié** : AES-256-GCM, + **cascade ChaCha20-Poly1305** pour
  `secure_max`.
- **Dérivation de sous-clés** : HKDF-SHA256.
- **Intégrité du conteneur** : HMAC-SHA256 (comparaison à temps constant).
- **Signatures** : Ed25519.
- **Chiffrement multi-destinataires** : ECDH-ES sur courbe P-256 (une CEK emballée
  par destinataire).
- **Empreintes** : SHA-256.
- **Keyfile** optionnel comme second facteur (`password + "|KF|" + sha256(keyfile)`).

Aucune primitive « maison » : uniquement `cryptography` et `argon2-cffi` (Python),
et `@noble/*`, `hash-wasm`, WebCrypto (Web).

### Le sceau de document (ancrage anti-altération)

Le sceau est une signature **Ed25519** de l'auteur sur un condensé canonique qui
lie *ensemble* un sous-ensemble du manifeste, `sha256(signatures)` et
`sha256(journal)` :

```
message = canonicalJSON({ v:1,
  manifest:{ format, formatVersion, profile, title, language, createdAt,
             protection{encrypted, locked, keyfileRequired, contentEntry},
             integrity{algorithm, contentHash} },
  signaturesHash: sha256(canonicalJSON(signatures)),
  journalHash:    sha256(canonicalJSON(journal)) })
```

Toute modification du contenu, du journal, de l'ensemble des signatures ou du
profil **casse le sceau** — y compris sur un fichier `secure_max` modifié sans le
mot de passe. Les champs volatils sont exclus (`modifiedAt`, `generator`,
`features`, `rgpd`, `seal`) pour qu'un ré-enregistrement légitime ne le casse pas.
Verdicts : `valid | unknown_key | broken | unsealed`. Miroirs byte-for-byte
(`format/seal.py` / `sign/seal.ts`), interopérables (fixture Python vérifiée par
Vitest).

> **Le verdict n'est pas bloquant à l'ouverture.** `read_elium`/`readEliumPackage`
> calculent et renvoient `seal.verdict` mais **ne lèvent jamais d'exception** si
> `broken` : ils retournent quand même le document (pour permettre d'inspecter un
> fichier suspect). Toute intégration exigeant une garantie stricte doit vérifier
> `result.seal.verdict !== "broken"` elle-même. Les interfaces livrées (CLI, Web
> Studio) affichent le verdict sans bloquer l'ouverture.

### Chiffrement optionnel des métadonnées

Sur un profil chiffré, l'option « Chiffrer aussi les métadonnées » déplace
titre/signataires/journal dans une enveloppe AEAD *à l'intérieur* du conteneur
chiffré ; les entrées ZIP en clair sont caviardées. **Opt-in** : par défaut, les
métadonnées restent en clair pour permettre de lister/rechercher sans ouvrir.

### Stockage des clés

La clé privée Ed25519 du Web Studio n'est **jamais** en clair : elle est chiffrée
au repos (Argon2id + AES-256-GCM) sous un mot de passe utilisateur, et n'existe en
clair qu'en mémoire après déverrouillage explicite. `localStorage` ne contient que
la clé publique, l'empreinte et le blob chiffré. Les mots de passe ne sont jamais
écrits dans le `.elium`.

### Aucun recouvrement local (zéro-connaissance)

Elium ne connaît, ne stocke ni ne transmet jamais un mot de passe ou un
fichier-clé en clair. **La perte du mot de passe et/ou du fichier-clé d'un document
chiffré est définitive et sans recours** — aucune clé maîtresse, aucun « mot de
passe oublié ». Il en va de même pour le **coffre local** : l'oublier ne rend pas
le contenu récupérable, mais le coffre peut être réinitialisé (l'index local est
reconstruit vide ; les fichiers `.elium` sur le disque ne sont pas affectés).
Conservez vos secrets (gestionnaire de mots de passe). *(Côté Drive d'entreprise,
le recouvrement d'organisation — §12 — est la seule voie de récupération d'accès à
un nœud.)*

### DoS & robustesse

Bornes KDF **identiques** Python/Web (t≤6, m≤256 MiB, p≤16) ; décompression du
conteneur plafonnée à 512 MiB ; **ZIP externe** plafonné (128 MiB par entrée,
384 MiB au total) ; vérification de la taille RÉELLE post-inflate ; garde de
profondeur sur le JSON imbriqué ; erreurs typées (`EliumError`). La parité DoS du
lecteur ZIP est assurée côté TS (`format/elium-package.ts`) comme côté Python.

---

### Trousseau de clés (« Mes clés »)

Toutes les clés locales vivent dans **un trousseau unique** (IndexedDB `elium-keys`) : identité de signature
**Ed25519**, clé de réception **P-256**, et le carnet de contacts. Chaque clé a un état (**active**, **retirée**,
**révoquée**, **expirée**), une date d'expiration facultative et un témoin de **sauvegarde**. Les anciennes entrées
`elium_identity` / `elium_recipient_key` sont migrées une seule fois, sans jamais être supprimées.

**Un mot de passe, un secret maître.** Les nouvelles clés sont **dérivées** (HKDF-SHA-256) d'un secret maître de
32 octets, lui-même chiffré par votre mot de passe (Argon2id + AES-256-GCM). Un seul mot de passe déverrouille
identité **et** clé de réception. Le trousseau se **verrouille** à la demande (« Verrouiller maintenant ») ou après
inactivité (réglable, 15 min par défaut) : le secret maître et les clés privées sont alors effacés de la mémoire,
ainsi que le fichier-clé d'un document ouvert.

**Profils Argon2id nommés** (un seul module) : `document` (t3 / 64 Mio / p1 — chaque ouverture), `account`
(t3 / 256 Mio / p4 — une fois par connexion Drive ; les comptes existants gardent leurs paramètres), `local-cache`
(t2 / 19 Mio / p1 — brouillons et historique, dérivation dans un Worker). Les bornes de décodage anti-DoS sont communes.

**Sauvegarde `.eliumkey` v2.** Un seul fichier chiffré porte **toutes** vos clés (Ed25519 et P-256) et le secret
maître : `{format:"elium-key", version:2, suite:"elium-keybundle/1", kdf, cipher, keys, enc}`. L'en-tête en clair est
**authentifié** : le conteneur chiffré transporte son empreinte SHA-256 et ses paramètres KDF/chiffrement doivent
correspondre exactement — modifier un libellé, un état ou une étiquette est détecté. Un `suite` inconnu est refusé
(agilité cryptographique). Le nom de fichier ne contient aucune empreinte (`elium-cles-AAAA-MM-JJ.eliumkey`). Le
lecteur v1 (identité seule) est conservé. Une sauvegarde est **imposée** à la création d'une clé de réception et
proposée avant toute suppression ; supprimer une clé jamais sauvegardée exige une confirmation explicite.

**Récupération.** Rubrique « Préparation à la récupération » (sauvegarde faite, phrase vérifiée, clé d'accès enrôlée) :
- **Phrase de 24 mots** (BIP-39, liste anglaise) codant le secret maître, avec étape de vérification (4 mots à ressaisir).
  Elle retrouve toutes les clés dérivées ; les clés importées non dérivées restent couvertes par le `.eliumkey`.
- **Parts de Shamir k-parmi-n** du secret maître, exportées en fichiers `.eliumshare` (GF(256), k-1 parts n'apprennent rien).
- **Clés d'accès (WebAuthn PRF)** : plusieurs possibles (appareil + clé de sécurité), révocables une à une, avec repli sur
  le mot de passe si PRF est indisponible.

**Cycle de vie et confiance.** *Faire tourner* une identité crée une nouvelle clé liée à l'ancienne par un **certificat de
succession** (signé par les deux clés, vérifiable, miroir Python) ; une clé de réception tournée reste dans la liste de
déchiffrement (le champ `kid` de l'enveloppe `elium-recipients/1`, additif, retrouve la bonne clé). Le carnet de confiance
gagne un **niveau** (non vérifié, première vue, vérifié par mots de sécurité, attesté par l'organisation), une nature
(signataire / destinataire), des notes, une expiration et une **liste de révocation** ; une clé révoquée ou expirée s'affiche
à côté de l'état TOFU du sceau. Le choix des destinataires se fait depuis le carnet, avec **mots de sécurité** et QR.

**Protéger avec Windows (application de bureau).** Couche **optionnelle** : le secret maître chiffré est ré-enveloppé par
Windows DPAPI (compte courant) via le lanceur local. Elle s'ajoute au mot de passe, ne le remplace pas, et rend le trousseau
illisible sur une autre machine : gardez la phrase de récupération.

**Ligne de commande.** `elium keys list|generate|public|export|import|rotate` gère un trousseau (`ELIUM_KEYS_DIR`) sans
jamais passer de clé privée en argument ; `--recipient-kid` remplace `--recipient-key`, désormais **déprécié** (avertissement).

**Drive d'entreprise : changer de mot de passe.** `POST /api/auth/change-password` ré-enveloppe le paquet de clés sous
une nouvelle masterKey (sel neuf), fait tourner la clé d'authentification, et révoque les autres sessions. La
ré-authentification se fait par signature d'un défi avec l'ancienne clé : aucun mot de passe ne circule. Le même flux
permet à un utilisateur SSO de définir la passphrase de ses clés (la réponse SSO fournit les paramètres KDF publics).
