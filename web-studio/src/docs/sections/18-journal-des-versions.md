## Journal des versions

> Résumé des jalons majeurs jusqu'à la version courante **4.2.13**.

- **4.9.0 — Modifier le texte comme Acrobat** — le paragraphe s'édite directement sur la page (plus de fenêtre), le texte d'origine disparaît pendant la saisie, le paragraphe se reformate tout seul, la mise en forme (mots en gras, couleurs, tailles) est conservée et se change dans le panneau « Format du texte » ; fonctionne sur les PDF Word et PowerPoint, le texte incliné et les pages pivotées.
- **4.8.1 — PDF dans le Drive** — un PDF du Drive s'ouvre dans l'éditeur PDF ; chaque
  enregistrement crée une nouvelle version chiffrée, avec alerte si le fichier a changé
  entre-temps.
- **4.8.0 — Refonte PDF niveau Acrobat Pro** — formulaires (valeurs, calculs, aplatissement),
  enregistrement incrémental qui préserve les signatures, modification du texte et des
  images, commentaires complets (FDF/XFDF), organisation des pages, calques, liens, signets,
  sécurité et caviardage réels, signatures PAdES (certificats, horodatage, certification,
  vérification), Remplir et signer, OCR hors ligne, exports Word/Excel/PowerPoint/RTF/images,
  création depuis Word/Excel/PowerPoint/HTML/texte, comparaison, optimisation, PDF/A-2b/3b,
  vérification d'accessibilité, impression (livret, affiche, plusieurs pages par feuille),
  nouvelle interface (Tous les outils, recherche d'outils, menus contextuels, mode lecture).
- **Format `.elium` v4 (OPC/ZIP)** — manifeste, contenu, signatures, journal,
  ressources, RGPD ; profils de protection ; parité Python↔TS byte-for-byte.
- **Sceau de document Ed25519** — ancrage anti-altération suite à l'audit
  2026-06 (F-1…F-6), épinglage TOFU.
- **Durcissement Phase 2 (2026-07-11)** — rotation de clés à la révocation, MFA
  (TOTP), quotas de stockage, rate-limiting par route, padding (Padmé), login sans
  oracle (défi-réponse Ed25519).
- **PDF avancé (LIVRÉ)** — formulaires AcroForm, fusion/division multi-fichiers,
  couche texte + recherche, édition du texte existant, caviardage/effacement,
  AES-256, OCR, rotation correcte à l'export.
- **Documents — parité Word (LIVRÉ)** — listes multiniveaux, colonnes/sections,
  renvois, index, comparaison de documents, publipostage, légendes + table des
  illustrations, notes de fin, taquets/règle, symboles/lettrine/filigrane, styles
  de tableau, correcteur.
- **Tableur — complet (LIVRÉ)** — export XLSX, AutoFilter réel, validation de
  données, plages nommées, fusion de cellules, tableaux croisés dynamiques ;
  parité collaborative plein-modèle + XLSX en collaboratif.
- **Présentations v2 — parité dual-plateforme (LIVRÉ)** — animations par élément +
  déclencheurs, vue présentateur (2ᵉ écran), transition Morph, import/export PPTX
  (dont graphiques natifs), galerie de 12 modèles, multi-sélection/groupes ;
  éditeur unifié `SlidesEditor` local/collaboratif ; fusion texte caractère par
  caractère (`Y.Text`).
- **Recouvrement d'org — UI interactive (LIVRÉ)** — `recovery.ts` (`withOrgKey`
  + effacement mémoire) + onglet « Recouvrement », promotion d'admins + restauration
  d'accès, E2E + tests unitaires.
- **SSO (OIDC) + SCIM (LIVRÉ)** — provisioning/déprovisioning en restant
  zéro-connaissance, UI d'administration.
- **Import DOCX — fidélité (LIVRÉ)** — résolution de `styles.xml` (docDefaults +
  styles ¶/caractère + `w:basedOn`) et surlignage, persistés dans le `.elium`.
- **Auto-update de l'app de bureau (LIVRÉ, vérifié en prod 2026-07-18)** — modèle
  push = publication, releases Ed25519-signées, overlay LocalAppData + handoff exe,
  carte 1-clic avec historique multi-versions.
- **Auto-update du serveur Drive VPS (LIVRÉ, v4.1.30, 2026-07-20)** — releases
  signées, déploiement du commit exact signé, health-check + rollback,
  systemd/cron via `install.sh auto-update on`.
- **v4.2.12 — connexion et déverrouillage par clé d'accès** — WebAuthn PRF :
  déverrouillage local biométrique optionnel et connexion 100 % sans mot de passe
  (passkey découvrable, `userVerification` obligatoire, aucune énumération) ; la
  passphrase reste la racine de confiance. Auto-update : la carte annonce
  l'historique complet des nouveautés (charge signée).
- **v4.2.13 — durcissement suite à l'audit** :
  - **SSO `email_verified`** : refus si l'IdP n'a pas vérifié l'e-mail (ferme un
    vecteur de prise de contrôle par premier binding de `sub`).
  - **Rate-limit dédié aux blobs** (`PUT`/`GET` content, liens publics).
  - **Journal d'audit à intégrité chaînée** (`entry_hash` chaîné par org,
    `GET …/audit/verify`, verrou consultatif).
  - **Anti-usurpation d'IP** (`trustProxy` ne fait plus confiance à un XFF
    arbitraire, surchargeable via `TRUST_PROXY`).
  - **Relais collab anti-DoS** (`maxPayload`, plafonds message/débit/awareness/
    connexions par utilisateur).
  - **En-têtes API durcis** (CSP `default-src 'none'`, `Referrer-Policy`, CORP).
  - **Ménage périodique** (`lib/housekeeping.ts` : purge des défis/sessions/
    invitations expirés).
  - **Révocation d'admin de recouvrement** (`DELETE …/recovery/admins/:userId`,
    refuse le dernier).
  - **Cache local en Argon2id** (remplace PBKDF2-100k, compat descendante).
  - **Parité DoS du lecteur ZIP côté TS** ; **CLI `doc-sign`** préserve le
    chiffrement des métadonnées / le keyfile ; **doc collaboratif** synchronise
    page/styles/filigrane.

**Abandonné** : add-in Office / Microsoft 365 (prototype `office-addin/` supprimé
du dépôt) ; la suite reste 100 % locale, toute fonction en ligne future resterait
opt-in et conforme RGPD.

---
