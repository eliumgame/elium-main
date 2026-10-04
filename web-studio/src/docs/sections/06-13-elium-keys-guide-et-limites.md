### Guide de récupération : que faire si…

Elium est **zéro-connaissance** : personne ne peut rouvrir vos documents ni vos clés à
votre place. Ce qui se récupère, c'est ce que vous avez préparé **avant**.

| Situation | Ce qui marche | Ce qui ne marche pas |
|---|---|---|
| Mot de passe d'un document perdu | Le fichier-clé, s'il existait. Une copie non chiffrée | Aucun recours sinon |
| Mot de passe du trousseau oublié | Clé d'accès, phrase, parts, sauvegarde `.eliumkey` | Rien d'autre |
| Navigateur réinitialisé | Phrase, parts, `.eliumkey`, sauvegarde d'espace de travail | Le carnet de confiance, sauf sauvegarde avec secrets |
| Nouvel ordinateur | `.eliumkey` ou phrase | La passkey et la couche Windows ne suivent pas |
| Clé compromise | Rotation, révocation, prévenir ses correspondants | Rendre invalide une signature déjà faite |

### Que faire si le mot de passe d'un document est perdu

Un mot de passe de document **ne se récupère pas**. Il n'existe ni clé maîtresse, ni
« mot de passe oublié ».

- Si le document a aussi un **fichier-clé**, il suffit à l'ouvrir seul : cherchez-le.
- Si le document est **encore ouvert** dans une session, enregistrez-en tout de suite
  une copie non chiffrée ou sous un nouveau mot de passe.
- Cherchez une autre copie du fichier, antérieure à son chiffrement.

### Que faire si le mot de passe du trousseau est oublié

Essayez dans cet ordre :

1. **Clé d'accès** : si vous en avez enrôlé une dans ce trousseau, déverrouillez
   avec elle. Elle ne dépend pas du mot de passe.
2. **Phrase de 24 mots** : « Restaurer le trousseau », onglet Phrase. Un nouveau mot de
   passe est demandé.
3. **Parts de Shamir** : onglet Parts, avec au moins k fichiers `.eliumshare`.
4. **Sauvegarde `.eliumkey`** : onglet Fichier. Il faut le mot de passe de la
   **sauvegarde** (distinct de celui du trousseau, sauf si vous avez choisi le même).

Sans aucune de ces voies, vos clés sont **perdues**. Conséquences :

- les documents chiffrés **pour votre clé de réception** deviennent illisibles ;
- vous ne pouvez plus sceller ni signer avec cette identité : créez-en une nouvelle ;
- les signatures et sceaux déjà posés restent vérifiables, car ils contiennent la clé
  publique ;
- les documents protégés par un simple **mot de passe** ne sont pas concernés.

### Que faire si votre navigateur est réinitialisé

Effacer les données du site, réinstaller le navigateur ou utiliser la fonction
« Effacer les données locales » des Réglages supprime **ensemble** : le trousseau, le
carnet de confiance, les sceaux épinglés, la bibliothèque locale, les brouillons et
l'historique. Les fichiers `.elium` enregistrés sur le disque ne sont pas touchés.

1. Restaurez les clés : phrase, parts, ou sauvegarde `.eliumkey`. Les clés héritées
   (non dérivées) ne reviennent que par le `.eliumkey`.
2. Restaurez la bibliothèque avec votre sauvegarde `.elium-workspace`, si vous en avez
   une. Si elle a été faite avec les secrets, elle ramène aussi le carnet et les
   sceaux épinglés.
3. Sinon, ré-ajoutez vos contacts. L'épinglage des sceaux repart de zéro : les
   documents apparaîtront comme « nouveaux ».

**Application de bureau.** Le navigateur sépare les données par origine, **port
compris**. Le serveur local choisit par défaut le premier port libre entre 3000 et
3100. Si le port habituel est occupé, l'application peut démarrer sur un autre port
et votre trousseau semblera vide. Il n'est pas perdu : relancez-la sur le port
habituel, ou épinglez un port dans les Réglages.

### Que faire si vous changez d'ordinateur

Le trousseau est **local** et ne se synchronise pas. Deux voies :

- **Sauvegarde `.eliumkey`** : « Sauvegarder tout » sur l'ancien poste, copiez le
  fichier par un moyen sûr, puis « Importer une sauvegarde » sur le nouveau. Le mot
  de passe de la sauvegarde devient celui du nouveau trousseau : changez-le ensuite si
  vous le souhaitez.
- **Phrase de récupération** : restaurez sur le nouveau poste. Attention aux limites
  de la restauration par phrase (indices 0 à 3, clés héritées absentes).

Ne comptez pas sur la **passkey** ni sur « Protéger avec Windows » : elles sont liées
à l'ancien poste. N'essayez pas de copier le dossier IndexedDB du navigateur.

Pour emporter aussi les contacts, faites une sauvegarde d'espace de travail avec les
secrets, **chiffrée par mot de passe**.

### Que faire si une clé est compromise

**Votre identité de signature est compromise** (copie du fichier, poste infecté) :

1. Faites-la **tourner** pour obtenir une nouvelle identité liée à l'ancienne par un
   certificat de succession, puis **révoquez** l'ancienne.
2. Prévenez vos correspondants par un autre canal et donnez-leur les mots de sécurité
   de la nouvelle clé. Un certificat de succession prouve la maîtrise de l'ancienne
   clé : un attaquant qui la détient peut en produire un lui aussi.
3. Re-scellez les documents importants avec la nouvelle clé.

La révocation **n'invalide pas** les signatures déjà posées et ne prouve pas leur
date : l'horodatage d'une preuve `.elium` est local. Pour dater une signature
de façon indépendante, la signature PDF accepte un horodatage RFC 3161 : il prouve
que la signature existait à la date du jeton.

**Votre clé de réception est compromise** : révoquez-la, créez-en une nouvelle,
communiquez la nouvelle clé publique. Les documents déjà chiffrés pour l'ancienne clé
ont pu être lus par l'attaquant : faites-les rechiffrer pour la nouvelle clé.

**Votre phrase de récupération, vos parts ou votre secret maître sont compromis** :
toutes les clés **dérivées** le sont. Faire tourner une clé n'aide pas : la nouvelle
clé dérive du **même** secret maître. Il faut repartir d'un trousseau neuf (Réglages,
« Effacer les données locales », puis nouveau mot de passe et nouvelles clés), puis
prévenir vos correspondants et rechiffrer vos documents.

### Limites connues d'Elium Keys

Ce qui n'est pas fait, ou pas encore branché, à la version décrite :

- **Restauration par phrase ou parts** : elle ne connaît pas l'historique des
  rotations. L'indice 0 est « actif », les indices 1 à 3 « retirés », les suivants
  absents.
- **Clés héritées** (aléatoires, non dérivées) : couvertes **seulement** par la
  sauvegarde `.eliumkey`.
- **Pas de rotation du secret maître.** Changer le mot de passe ré-enveloppe le même
  secret. Un secret compromis impose un trousseau neuf.
- **Une sauvegarde `.eliumkey` contient le secret maître** (même celle d'une seule
  clé). Les parts de Shamir ne sont pas chiffrées.
- **Passkeys** : elles ne déverrouillent que le trousseau local où elles ont été
  enrôlées. Leur révocation est locale.
- **Carnet de confiance, révocations et sceaux épinglés** : stockés dans le
  navigateur, hors sauvegarde `.eliumkey`. Une révocation n'est ni publiée ni
  propagée.
- **Contacts** : l'interface permet d'ajouter, de retirer et de marquer comme vérifié
  (destinataires). Elle ne permet pas de fixer le niveau, les notes, l'expiration ou
  la révocation d'un contact. Le niveau « Attesté par l'organisation » n'est attribué
  par aucun code du client.
- **Succession** : le certificat est créé, stocké, exporté et vérifiable, mais aucun
  écran n'importe encore un certificat reçu dans le carnet pour transférer la
  confiance.
- **QR code et mots de sécurité** : le QR est affiché, il n'y a pas de lecteur
  intégré. Les mots représentent 36 bits.
- **Mot de passe du trousseau** : un minimum de 4 caractères seulement est exigé.
- **Mémoire** : les clés privées déverrouillées sont des chaînes JavaScript qui ne
  peuvent pas être écrasées. Seul le secret maître l'est.
- **Origine du navigateur** : un autre port, un autre navigateur ou un autre profil
  donne un trousseau vide. La sauvegarde d'espace de travail ne contient pas le
  trousseau `elium-keys`.
- **Pas de synchronisation** du trousseau entre appareils.
- **Ligne de commande** : pas de dérivation, de phrase, de parts ni de passkey. Les
  commandes `doc-sign --key` et `--seal-key` lisent un fichier de clé privée.
- **Connexion SSO dans le client** : le serveur Drive gère l'OIDC et le SDK expose
  l'appel `ssoVerify`, mais dans cette version aucun écran du client ne l'appelle.
  Voir « Authentification ».
- **Clés du compte Drive** : elles ne sont pas gérées par Elium Keys. Seule
  l'enveloppe des passkeys est partagée avec le Drive.

---
