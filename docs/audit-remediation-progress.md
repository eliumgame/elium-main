# Reprise de l'audit v4.32.0 — 2 novembre 2026

Base auditée : `a88de3b`. Corrections intégrées localement jusqu'à `85e1867`.
Ce fichier suit l'avancement ; il ne certifie pas la clôture des 151 constats.

## Intégré

- Passeport E4 : import des cases Word, récupération du coffre orphelin,
  vérification du fichier avant première écriture, propagation des échecs avant
  purge des annexes. Complément : attendre la validation IndexedDB, y compris
  un abandon tardif de transaction, avant d'annoncer une sauvegarde réussie.
- Authentification Drive : verrouillage MFA par compte, paramètres KDF canoniques
  dans prelogin, ré-authentification avant enrôlement TOTP.
- Sauvegarde Drive : contrôle du propriétaire du dossier, limitation des ancres
  de confiance restaurées, garde lors du changement d'organisation.
- Serveur Drive : protection des parts de clés et versions, canonicalisation du
  journal d'audit, erreurs explicites de collaboration, gestion de fermeture des
  sockets, quotas du journal collaboratif et des versions réécrites.
- Client Drive : conservation des parts d'équipe pendant la rotation, épinglage
  des clés dans la résolution des principaux, repli et réparation après rotation
  interrompue, reconstruction des parts héritées lors d'un déplacement.
- Changements locaux préexistants conservés : droits du rôle Éditeur,
  contrôle du gestionnaire d'équipe et protection des paramètres SCIM.

## Vérifications effectuées

- Web : 102 tests Drive/Passeport/collaboration réussis, puis 2 tests supplémentaires
  sur la validation de transaction réussis.
- TypeScript client et serveur : réussite.
- ESLint sur les fichiers de persistance Passeport modifiés : réussite.
- Serveur : première exécution, 500/511 réussis. Six échecs provenaient de mocks
  d'équipe non adaptés à la nouvelle garde (corrigés, avec un test anti-inscription
  ajouté) ; cinq provenaient du refus des connexions HTTP locales par le sandbox.
  Relance ciblée équipes + TSA hors sandbox : 37/37 réussis.
- Pas de publication, pas de migration exécutée sur une base de production.

## Travaux conservés à terminer

Les worktrees sous `.claude/worktrees/` contiennent encore des modifications non
commitées ; les préserver et les relire avant intégration :

- `agent-a64c04147873f4d13` : ré-authentification pour mot de passe/suppression du compte,
  adaptation client et tests. SSO, refresh multi-onglets et autres constats auth restent à traiter.
- `agent-a2d030d2b170c0293` : rôle Éditeur, moteur des droits, migration 0015 et documentation.
- `agent-aa431a3a866416b76` : rotation des clés d'équipe, API et interface.
- `agent-a43270b04a66d9f0e` : autre implémentation concurrente de rotation d'équipe.
  Ne pas fusionner les deux versions aveuglément : les commits client retenus viennent
  de `agent-aa431a3a866416b76`.
- `agent-ad296bc8fc4b05d94` : révocations et restauration du trousseau/sauvegarde.

Reprendre ensuite les autres constats Drive non couverts (révocations, SCIM,
recouvrement, autorisations), puis PDF/PAdES, éditeurs, chaîne de publication,
desktop, Python, cryptographie et Détecteur. Les lots JSON de l'audit initial
sont conservés dans le scratchpad de la session Claude `3e7aa5f6-bb03-469d-8747-a62856d2140c`.
