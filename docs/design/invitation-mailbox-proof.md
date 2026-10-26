# Invitations : preuve de possession de boîte mail (analyse)

> **Statut : ANALYSE + une mitigation sûre appliquée — pas une implémentation
> complète.** Rédigé le 26/10/2026 suite au réaudit externe qui a confirmé que
> l'acceptation d'invitation (déjà corrigée pour un compte existant, voir le
> commit « lie les invitations à l'email ») ne couvre pas le cas d'un lien
> transféré à quelqu'un d'autre AVANT que le compte invité n'existe. Fermer ce
> cas correctement demande une décision produit (ajouter l'envoi d'e-mail
> transactionnel), pas un correctif de code isolé — ce document explique
> pourquoi, et ce qui a été fait sans attendre cette décision.

## 1. Le constat exact

- Création d'une invitation : stocke un e-mail destinataire + un jeton
  aléatoire, expirant (7 jours), à usage unique (`server/src/routes/orgs.ts`).
- Acceptation par un compte **déjà authentifié** : compare désormais l'e-mail
  de l'invitation à celui du compte courant (insensible à la casse) — corrige
  le cas « lien donné à un autre compte existant ».
- Acceptation par **inscription classique** (`assertSignupAllowed`, appelée
  depuis `/auth/register`) : exige déjà `lower(email) = lower($invité)` en SQL.
- **Ce qui reste ouvert** : si l'e-mail invité n'est PAS encore un compte,
  quiconque possède le LIEN (pas seulement l'e-mail) peut s'inscrire avec cet
  e-mail et consommer l'invitation — l'inscription classique ne prouve la
  possession d'aucune clé, uniquement la frappe d'une chaîne de caractères.
  Le SSO (`email_verified` du fournisseur d'identité) échappe à ce problème ;
  l'inscription classique, non.

## 2. Pourquoi ce n'est PAS un correctif de code isolé

Prouver la possession d'une boîte mail demande d'y **envoyer quelque chose**
(un code, un lien de confirmation) et d'attendre une preuve de lecture. Ce
dépôt n'a **aucune infrastructure d'envoi d'e-mail transactionnel** —
confirmé par une recherche exhaustive (`nodemailer`, `smtp`, `sendgrid`,
`resend`, `mailgun` : zéro résultat dans `server/`). Aujourd'hui, le jeton
d'invitation est renvoyé à l'API et c'est l'**administrateur** qui le
transmet lui-même (e-mail personnel, Slack, autre) — Elium n'envoie rien.

Fermer complètement ce point demanderait donc, au minimum :
- Un fournisseur SMTP/API (SMTP, SES, Resend…), ses secrets, sa configuration
  par déploiement, et sa gestion d'échec/retry.
- Des gabarits d'e-mail (au moins FR), un expéditeur et un domaine qui ne
  finissent pas en spam.
- Un flux de confirmation dédié (code ou lien de second facteur), avec ses
  propres limites de débit et expiration.
- Une décision produit sur CE QUE devient une invitation déjà existante
  pendant la transition (compatibilité ascendante).

C'est un projet d'infrastructure à part entière, pas une correction
ponctuelle — exactement la même nature de chantier que la migration OPAQUE
documentée à côté (`docs/design/auth-protocol-opaque.md`).

## 3. Trois contrats possibles (décision produit à prendre)

1. **Ajouter l'envoi d'e-mail transactionnel** et exiger une confirmation de
   boîte mail avant que l'inscription-sur-invitation ne devienne effective.
   Ferme réellement le problème ; coût = le chantier du §2.
2. **Redéfinir explicitement l'invitation comme un lien transférable** (une
   capacité, pas une identité) : documenter que quiconque obtient le lien
   obtient le rôle, point. Aucun développement requis, mais affaiblit la
   promesse implicite actuelle de l'interface (« invitation pour untel »).
3. **Statu quo documenté + mitigations** (ce qui est fait ci-dessous) : ne pas
   prétendre résoudre le problème sans l'infrastructure nécessaire, réduire la
   fenêtre d'exposition, et donner à l'administrateur de quoi réagir vite.

## 4. Mitigation appliquée maintenant (sans infrastructure d'e-mail)

- **Durée de vie de l'invitation réduite** : 7 jours → 48 heures
  (`server/src/routes/orgs.ts`, `INVITE_TTL_MS`). Un lien intercepté ou
  transféré a une fenêtre d'exploitation bien plus courte ; 48 h reste
  largement suffisant pour qu'un destinataire légitime s'inscrive.
- **Traçabilité déjà présente, vérifiée** : la création (`member.invite`) et
  l'acceptation (`member.invite.accept`) sont déjà auditées avec l'e-mail/le
  rôle concernés (`lib/audit.ts`) — un propriétaire qui consulte le journal
  voit QUI a rejoint et QUAND, donc une invitation détournée reste détectable
  après coup même sans alerte proactive.

Aucune autre modification de code n'a été faite : une preuve de contrôle de
boîte mail qui ne contrôle rien réellement (par exemple, un simple
« confirmez votre e-mail » sans envoi effectif) serait une fausse sécurité —
pire que documenter honnêtement la limite.

## 5. Recommandation

Ne pas improviser un envoi d'e-mail minimal pour « cocher la case » : un
mauvais fournisseur SMTP mal configuré ou un flux de confirmation bâclé
créerait de nouveaux problèmes (délivrabilité, spam, nouveaux jetons à
sécuriser) sans béné réel. Si l'inscription ouverte sur invitation doit un
jour accueillir des données sensibles à large échelle, l'option 1 (vrai envoi
d'e-mail) est la seule qui ferme réellement le problème — à traiter comme un
projet dédié. En attendant, l'option 3 (fenêtre réduite + traçabilité) est ce
qui pouvait raisonnablement être fait sans cette décision.
