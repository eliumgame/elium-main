# Authentification : limite du modèle actuel face à un serveur compromis (analyse)

> **Statut : ANALYSE — pas une spec à implémenter.** Rédigé le 25/10/2026 suite à
> l'audit externe (Manus AI) qui a identifié que le commentaire d'en-tête de
> `server/src/routes/auth.ts` comparait à tort ce schéma à SRP/OPAQUE. Ce
> commentaire a été corrigé le jour même (commit sur `master`) pour ne plus
> affirmer une garantie que le code ne tient pas. Ce document est l'examen que
> l'audit recommandait : « l'évolution du protocole doit être examinée par un
> spécialiste, en incluant à la fois l'authentification et le chiffrement du
> trousseau ». Il ne contient **aucune implémentation** — une réécriture du
> protocole d'authentification est une décision produit et cryptographique qui
> dépasse ce qu'il est raisonnable de trancher ou coder dans une session d'agent,
> et le risque d'une crypto maison mal revue est précisément le problème que ce
> document cherche à éviter.

## 1. Ce que le code fait réellement aujourd'hui

- Le client dérive, à partir du mot de passe, un `root` Argon2id (profil
  `account` : t3 / 256 Mio / p4, voir `web-studio/src/crypto/kdf-profiles.ts`),
  puis par HKDF deux secrets **distincts** : `authSign` (une paire Ed25519) et
  `masterKey` (chiffre le trousseau `key_bundle`).
- Seule la clé publique `authSignPublic` est envoyée au serveur, à
  l'inscription. Le serveur la stocke avec le sel et les paramètres KDF
  (`auth_sign_public_hex`, `kdf_salt`, `kdf_params`).
- La connexion est un défi-réponse : nonce aléatoire signé par la clé privée
  `authSign`. Aucune valeur équivalente au mot de passe ne transite sur le
  réseau, et une capture de l'échange de connexion n'est pas rejouable.
- **Limite** : `auth_sign_public_hex` est un vérificateur déterministe du mot
  de passe, au même titre qu'un hash salé classique. Qui obtient une copie de
  cet enregistrement (fuite de base, serveur compromis) peut, hors ligne, pour
  chaque mot de passe candidat : rejouer Argon2id → HKDF → clé publique Ed25519,
  et comparer. Argon2id renchérit le coût par essai ; il ne rend pas l'attaque
  impossible. Ce n'est PAS l'objectif atteint par SRP/OPAQUE (qui n'exposent
  aucun vérificateur hors-ligne crackable).

## 2. Pourquoi « remplacer juste la connexion par OPAQUE » ne suffit pas

C'est la mise en garde explicite de l'audit, et elle est fondée : le vrai
problème n'est pas limité à l'étape de connexion.

Le `masterKey` qui déchiffre `key_bundle` (le trousseau de clés privées) est
dérivé du **même** `root` Argon2id que `authSign`, avec un `info` HKDF distinct
mais la **même entrée mot de passe + même sel**. `key_bundle` chiffré et
`kdf_salt`/`kdf_params` sont tous les deux dans la base serveur.

Donc même si la connexion passait par un vrai OPAQUE (qui élimine le
vérificateur `authSignPublic`), un attaquant avec un dump de base pourrait
toujours, hors ligne, tenter de déchiffrer `key_bundle` pour chaque mot de
passe candidat (Argon2id → HKDF → tentative de déchiffrement AEAD du
trousseau) — un oracle hors-ligne tout aussi efficace, juste déplacé d'un
champ à un autre. **Corriger uniquement l'authentification laisserait le
trousseau chiffré directement attaquable de la même façon.**

## 3. Ce qu'il faudrait réellement (portée, pas un plan d'implémentation)

Une vraie résistance à un serveur compromis demanderait les deux volets
ensemble :

1. **Authentification** : migrer vers un VRAI OPAQUE (bibliothèque auditée,
   pas une implémentation maison — un PAKE mal implémenté est pire que le
   schéma actuel). Élimine `auth_sign_public_hex` comme vérificateur hors-ligne.
2. **Trousseau** : dériver la clé qui chiffre `key_bundle` d'un secret qui
   n'existe QUE côté client après un échange OPAQUE réussi (son « export key »),
   PAS directement d'Argon2id(mot de passe). Sans ça, le point 1 ne sert à rien
   pour le trousseau (cf. §2).
3. **Migration** : chaque compte existant doit re-dériver ses secrets au
   prochain mot de passe réellement saisi (le serveur ne peut pas migrer seul
   un secret qu'il ne connaît pas) — un plan de transition (ancien schéma
   accepté en lecture, nouveau à l'écriture) est nécessaire, pas un simple
   bump de version.
4. Les deux volets touchent le cœur cryptographique zero-knowledge du produit
   (inscription, connexion, reset, recovery d'organisation qui ré-enveloppe
   `key_bundle`) — à faire concevoir et relire par quelqu'un dont c'est la
   spécialité, avec des vecteurs de test avant tout déploiement.

## 4. Mitigations sûres, sans toucher au protocole

Ce qui réduit le risque réel sans réécrire la crypto :

- **Ne pas toucher aux paramètres Argon2id du profil `account`** (t3/256 Mio/p4)
  sans mesure dédiée : ils sont déjà nettement au-dessus du plancher OWASP, et
  le profil `document` a précédemment causé des OOM mobile à 256 Mio — un
  changement non mesuré du profil `account` risquerait la même régression pour
  un gain de sécurité marginal (le problème est structurel, pas le coût KDF).
- **Longueur minimale du mot de passe** : configurable par l'organisation
  (`AuthPanel.tsx`, `minLen`), pas câblée en dur — c'est une décision de
  politique du propriétaire du Drive, pas un défaut de code à corriger ici.
  Le point reste valable : documenter dans l'UI d'inscription qu'une phrase de
  passe longue est la seule vraie défense tant que ce protocole est en place
  (déjà partiellement fait, cf. l'avertissement de perte de données).
- **Rate-limiting** déjà en place (limite globale 600/min/IP + limites plus
  strictes par route sensible dans `auth.ts`) : ralentit les tentatives EN
  LIGNE, sans effet sur une attaque hors-ligne après fuite de base — à garder,
  insuffisant seul.
- **Réduire la surface de fuite** : s'assurer qu'aucune sauvegarde/export ne
  circule sans chiffrement au repos, que l'accès à la base de production est
  strictement limité et audité — la meilleure défense tant que ce protocole
  reste en place est d'empêcher la fuite elle-même.

## 5. Recommandation

Ne pas improviser une migration OPAQUE dans le cadre d'un correctif rapide.
Documenter la limite honnêtement (fait), appliquer les mitigations de
hygiène du §4, et traiter la migration cryptographique (§3) comme un projet à
part entière avec revue spécialisée dédiée — c'est la recommandation de
l'audit, et ce document ne cherche pas à la contourner.
