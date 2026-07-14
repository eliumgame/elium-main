# Politique de sécurité

## Versions supportées

Le format documentaire **v4** est la version courante. Le conteneur **v3** reste
supporté en lecture/écriture (legacy) et sert de primitive de chiffrement à la v4.

## Principe : la sécurité dépend du profil

Elium applique des protections **optionnelles** via des profils (voir
[DOCUMENTATION.md §5.4](DOCUMENTATION.md#54-profils-de-protection-additifs-optionnels)). **Le niveau de sécurité réel dépend des protections
activées** :

- `standard` / `signed` / `tracked` / `locked` : le contenu **n'est pas chiffré**.
  Le fichier est portable mais **pas confidentiel**.
- `protected` / `encrypted` / `secure_max` : le corps du document est chiffré.

> Un `.elium` non chiffré peut être lu par n'importe qui. Le « verrouillage »
> (`locked`) et le « suivi » offrent de la **détection d'altération**, pas de la
> confidentialité.

## Primitives cryptographiques

- **KDF** : Argon2id (t=3, m=256 MiB, p=4 par défaut) — résistant GPU/ASIC.
- **Chiffrement authentifié** : AES-256-GCM ; cascade ChaCha20-Poly1305 pour `secure_max`.
- **Dérivation de sous-clés** : HKDF-SHA256.
- **Intégrité du conteneur** : HMAC-SHA256.
- **Sceau de document** : signature Ed25519 sur un condensé canonique
  `{ sous-ensemble du manifeste, sha256(signatures), sha256(journal) }`. Un seul
  ancrage qui rend toute altération du contenu, du journal, de l'ensemble des
  signatures ou du badge de profil **détectable**. Voir `format/seal.py` / `sign/seal.ts`.
- **Empreintes** : SHA-256.
- **Signatures** : Ed25519.
- **Keyfile** optionnel comme second facteur.

Aucune cryptographie « maison » : uniquement `cryptography`, `argon2-cffi`
(Python) et `@noble/*`, `hash-wasm`, WebCrypto (Web).

## Garanties et limites

1. **Confidentialité** : seulement pour les profils chiffrés, et seulement aussi
   forte que le mot de passe choisi. Un mot de passe faible reste cassable hors ligne.
2. **Intégrité** : deux niveaux. (a) `integrity.contentHash` n'est **pas** clé : il
   détecte une **corruption accidentelle**, mais pas une altération délibérée (un
   attaquant recalcule le hash dans le manifeste, qui est en clair). (b) Le **sceau
   de document** (Ed25519) est l'ancrage anti-altération : il couvre le contenu, le
   journal *et* l'ensemble des signatures, et casse à la moindre modification — y
   compris sur un fichier `secure_max` modifié sans le mot de passe. **Scellez** les
   documents qui doivent être vérifiables (profils `signed`/`locked`/`secure_max`).
3. **Signatures vs non-répudiation** : la preuve Ed25519 atteste qu'un détenteur
   de la clé a signé un état donné du document. Sur un document **non chiffré**,
   un tiers peut néanmoins retirer une signature et reconstruire le paquet : la
   non-répudiation forte suppose un profil verrouillé/chiffré et une clé de
   confiance vérifiée hors bande.
4. **Pas de PKI intégrée** : la confiance est établie hors bande (on fournit la
   clé publique attendue). Pas d'autorité de certification.
5. **Pas de signature qualifiée** : voir [DOCUMENTATION.md §7](DOCUMENTATION.md#7-signatures--elium-sign).
6. **Déni de service** : bornes KDF **identiques** côté Python et Web (t≤6,
   m≤256 MiB, p≤16) ; décompression du conteneur plafonnée à 512 MiB ; **taille du
   ZIP externe plafonnée** à 128 MiB par entrée et 384 MiB au total ; garde de
   profondeur sur le JSON imbriqué. Les erreurs de format sont typées (`EliumError`).

## Aucun recouvrement possible (zero-knowledge)

Le modèle est **zero-knowledge** : Elium ne connaît, ne stocke ni ne transmet
jamais un mot de passe ou un fichier-clé en clair. **La perte du mot de passe
et/ou du fichier-clé d'un document chiffré est définitive et sans recours** —
il n'existe aucune procédure de récupération, aucune clé maîtresse, aucun
« mot de passe oublié » qui redonnerait accès au contenu. Il en va de même
pour le **coffre local** optionnel (mot de passe d'application séparé qui
protège la bibliothèque « Récents » et le Parapheur sur ce poste, voir
`format/vault-store.ts`) : l'oublier ne rend pas le contenu récupérable, mais
peut être contourné en réinitialisant le coffre (l'index local est reconstruit
vide — les fichiers `.elium` eux-mêmes, sur le disque, ne sont pas affectés).
**Conservez vos mots de passe et fichiers-clés** (gestionnaire de mots de passe,
sauvegarde du fichier-clé) — c'est une conséquence assumée du modèle, pas une lacune.

## Le verdict du sceau n'est pas bloquant par défaut

`read_elium`/`readEliumPackage` calculent et renvoient le verdict du sceau
(`seal.verdict`) mais **ne lèvent jamais d'exception** si celui-ci est `broken` —
ils retournent quand même le document, à charge pour l'appelant de vérifier le
verdict avant de faire confiance au contenu. C'est le comportement voulu de
l'API bas niveau (elle ne doit pas empêcher un utilisateur d'inspecter un
fichier suspect), mais toute intégration qui a besoin d'une garantie stricte
doit vérifier `result.seal.verdict !== "broken"` elle-même avant utilisation.
Les interfaces livrées (CLI, Web Studio) affichent le verdict à l'utilisateur ;
elles ne bloquent pas non plus l'ouverture, par cohérence avec ce principe.

## Statut de l'add-in Office (prototype)

`office-addin/` est un **prototype non fonctionnel** : le chiffrement n'y est
**pas implémenté** (voir l'avertissement dans `taskpane.js`/`taskpane.html` et
dans `manifest.xml`). Il ne doit pas être distribué ni utilisé en pensant
bénéficier de la même sécurité que l'application principale (Web Studio/CLI).

## Stockage des clés

- La **clé privée Ed25519** du Web Studio n'est **jamais** stockée en clair : elle
  est chiffrée au repos (Argon2id + AES-256-GCM) sous un mot de passe choisi par
  l'utilisateur, et n'existe en clair qu'en mémoire après déverrouillage explicite.
  `localStorage` ne contient que la clé publique, l'empreinte et le blob chiffré.
- Les mots de passe ne sont **jamais** écrits dans le fichier `.elium`.

## Signalement d'une vulnérabilité

Merci de **ne pas** ouvrir d'issue publique. Contactez les mainteneurs par un
canal privé. Nous accuserons réception et fournirons un calendrier de correction.
