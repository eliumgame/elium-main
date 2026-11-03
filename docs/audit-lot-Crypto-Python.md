# Audit Crypto/Python — lots H et I

État au 3 novembre 2026. **Lot non clos : 14 constats corrigés, 3 restent hors périmètre et nécessitent coordination.** L'intégration générale est laissée au parent.

## Base et périmètre

- Sources : `batch-H-python.json` (9 constats) et `batch-I-crypto.json` (8 constats), scratchpad `3e7aa5f6-bb03-469d-8747-a62856d2140c`.
- Base demandée : `68d913f`. Début effectif sur le checkout partagé : `61a0509`. Reprise après interruption : `e2c2831`, correctifs précédents conservés.
- Checkout : `C:/Users/ludov/Downloads/elium-main/elium-main`, branche `master`, sans changement de branche ni release.
- Modifications limitées à `src/elium/**`, `web-studio/src/{crypto,sign,format}/**`, tests associés et ce bilan. Aucun fichier Drive UI, secret ou fichier modifié par les autres agents n'a été inclus volontairement dans les commits du lot.
- L'historique et les références des anciens worktrees ont été consultés. Le correctif historique `57ed08d` couvrait déjà les ressources altérées et certaines formes malformées, mais pas la garde contenu/sceau/journal du constat H1. Il n'a pas été réappliqué.

Les identifiants H1–H9 et I1–I8 suivent l'ordre des tableaux JSON sources. « Déjà corrigé » ci-dessous signifie corrigé par ce lot avant l'interruption, puis recontrôlé à la reprise ; aucun des 17 constats n'a été classé comme entièrement résolu dans la base initiale sans intervention.

## Bilan par constat

| ID | Constat | État et correction | Commits / vérification |
|---|---|---|---|
| H1 | `doc-sign` réécrit un document altéré et retire le sceau | **Déjà corrigé.** Refus avant mutation si contenu ou sceau altéré, ou journal invalide. Un document scellé exige `--seal-key` pour être re-scellé après signature ; le sceau n'est plus retiré silencieusement. | `a47e62a` ; test de refus et conservation exacte des octets, tests CLI. |
| H2 | `doc-verify` ne dégrade pas les profils sans sceau et retourne toujours 0 | **Déjà corrigé.** `profile_expects_seal`, avertissement dans `doc-open`, verdict global JSON/console. Sortie 1 pour altération et 2 pour avertissement/non-vérifiable, après écriture du rapport. | `d11927f` ; tests CLI du code 1 et du profil signé sans sceau, code 2. |
| H3 | `--trusted` masque `modified` par `unknown_key` | **Corrigé, complété à la reprise.** La CLI réserve `--trusted` au sceau. Les API Python et TS vérifient contenu, placement, visuel et docId avant l'attribution. L'aide précise la portée de l'option. | `d11927f`, `ac64fff` ; preuve modifiée avec une autre clé de confiance, dans les deux langages. |
| H4 | Faute de mot de passe lors d'un ajout/import/rotation de clé | **Déjà corrigé.** Vérification d'une entrée existante avant génération, import ou rotation CLI. Une erreur ne réécrit pas le trousseau. | `e2342a2` ; 7 tests CLI clés, dont refus d'ajout et conservation du trousseau. |
| H5 | Journal malformé accepté ou exception sans verdict | **Corrigé, complété à la reprise.** Validation des séquences et des types en Python et TS ; verdict invalide pour structure incorrecte. Les preuves Python incomplètes renvoient `invalid`. | `d46457c`, `2592075`, `e8295d4` ; tests journal Python et 8 tests Web, cas acteur booléen/données numériques/null. |
| H6 | Divergence sur sceau vide et champs de preuve null | **Corrigé, complété à la reprise.** Sceau `{}`/liste malformée : `broken` ; champs de preuve `fingerprint:null` et `signedDocId:null` : `invalid` dans les deux langages. Une clé publique de sceau null ne lève plus `TypeError`. | `2592075`, `36899c3` ; tests sur preuves par ailleurs authentiques, sceau vide et clé null. |
| H7 | Perte de `accessExpiresAt` lors d'une signature CLI | **Déjà corrigé.** Transmission et écriture du champ avant scellement. | `a7c05d2` ; signature puis relecture : date conservée et sceau valide. |
| H8 | `doc-open` et `doc-verify` sans `--keyfile` | **Déjà corrigé.** Option acceptée, fichier lu et transmis aussi au second essai après saisie du mot de passe. | `8db1413` ; ouverture et vérification d'un document protégé par fichier-clé seul. |
| H9 | Erreur de sortie cp1252 après écriture par `doc-sign` | **Déjà corrigé.** Remplacement de la flèche non encodable par `->` dans le message final. | `24135b5` ; test avec `TextIOWrapper(encoding="cp1252", errors="strict")`. |
| I1 | Fichier-clé perdu au réenregistrement Web | **Déjà corrigé au niveau format.** Le writer dérive `keyfileRequired` du fichier-clé effectivement utilisé. Il refuse un réenregistrement chiffré sans la clé requise, ainsi que la combinaison fichier-clé/destinataires qui ignorerait la clé. | `6e10cda` ; 4 tests de cycle fichier-clé, dont refus de sauvegarde avec le seul mot de passe. |
| I2 | `contentHash:null` contourne l'avertissement d'intégrité | **Déjà corrigé au niveau lecture.** Rejet des archives dont l'empreinte de contenu est absente ou n'est pas un SHA-256 hexadécimal. Le fichier falsifié n'atteint donc plus le bandeau vert. | `e2c2831` ; mutation de manifeste dans `core-hardening.test.ts`, 6 tests réussis. |
| I3 | TOFU : retrait/changement d'identifiant et « reconnue » dès la première vue | **Reste hors périmètre.** Le module distingue bien `new` de `pinned`, mais `App.tsx` force `pinned` au premier affichage et ignore l'absence de sceau. Changer tous les identifiants reste une limite du TOFU, non une preuve d'identité. | À coordonner : `App.tsx` autour de 511–516 et `components/VerificationBanner.tsx`. Aucun contournement artificiel ajouté au module `sign/`. |
| I4 | `docId` absent des appels Web de création/vérification des preuves | **Reste hors périmètre.** L'API sait lier/vérifier le docId et la CLI le transmet, mais les appels Web actuels l'omettent. | À coordonner : `App.tsx:154`, appels `createProof` autour de 1436/1484/1527 ; `drive-cloud/ui/SignLinkView.tsx:203`, explicitement exclu du lot. |
| I5 | Restauration d'un autre maître et clés privées incohérentes | **Corrigé, renforcé à la reprise.** Validation des clés publiques dérivées dans `installMaster`, avant écriture. Refus sans référence vérifiable quand un maître existe. `unlockWithMaster` prépare les clés et n'adopte le maître qu'après validation complète. Les passkeys ne sont conservées que pour un maître compatible avec les références existantes. | `5fb51f6`, `741f773` ; 23 tests trousseau/restauration, dont mauvais maître : stockage inchangé, session non déverrouillée. |
| I6 | JSON canonique divergent sur les flottants/exposants | **Corrigé, compatibilité complétée à la reprise.** Écriture Python avec seuils et notation ECMAScript pour les nombres concernés. Vérification Python des anciennes preuves/sceaux/journaux avec l'ancienne représentation, sans utiliser celle-ci pour les nouvelles écritures. | `62d258c`, `939fe54`, `1580fd2` ; vecteurs `5e-5`, `1e16`, `1.5e-7`, `-0.0`, preuve et sceau dans les deux sens, fixture historique et refus d'une modification réelle. |
| I7 | Documentation : métadonnées en clair annoncées par défaut | **Reste hors périmètre.** Les pages continuent de contredire le défaut chiffré des nouveaux documents. | À coordonner : `docs/sections/06-00-cryptographie.md:215` et `08-modele-de-securite-et-de-menace.md:35,137` sous `web-studio/src/`. Aucun changement de ces pages dans ce lot. |
| I8 | Cache local : réutilisation du mot de passe avec un KDF moins coûteux | **Corrigé pour les nouvelles écritures.** Profil `document` pour cache JSON, cache binaire et nouveaux vérificateurs du coffre. Lecture conservée des enveloppes PBKDF2 et Argon2 historiques. | `ae052f3` ; 11 tests local-vault, coût document vérifié, ancien JSON/binaire lisible, mauvais secret refusé. Limite persistante des anciennes copies détaillée ci-dessous. |

## Vérifications réalisées

- Python : `python -m pytest tests/python/test_doc_cli.py tests/python/test_cli_keys.py tests/python/test_canonical.py tests/python/test_journal.py tests/python/test_seal.py tests/python/test_signatures.py tests/python/test_format.py -q` : **76 réussis** avant l'ajout du test de compatibilité historique. Avertissement attendu du test de ZIP à entrée dupliquée.
- Après ajout de la compatibilité historique : `test_canonical.py test_journal.py test_seal.py test_signatures.py` : **37 réussis**.
- Web : `proof.test.ts seal.test.ts core-hardening.test.ts keyfile.test.ts keyfile-modify-cycle.test.ts` : **31 réussis**.
- Web : `keyring-backup.test.ts keyring.test.ts` : **23 réussis** ; `local-vault.test.ts` : **11 réussis** ; `journal-record.test.ts` : **8 réussis**.
- Interopérabilité : `interop_seal.test.ts` : **9 réussis**, dont le nouveau test de coordonnées exponentielles, sans skip de Python.
- Observation pour le parent : exécuter uniquement `test_signatures.py` déclenche un import circulaire préexistant entre `crypto.primitives` et `core.__init__/container`. Le groupe ci-dessus passe. Aucun changement d'initialisation des modules n'a été ajouté à ce lot.
- Pas de release ni de build de publication. Les tests d'intégration globaux restent à la charge du parent, conformément à la consigne de reprise.

## Limites et coordination restante

1. **I3, I4, I7 restent ouverts.** Les fichiers concernés sont hors périmètre ; `App.tsx` était notamment modifié par un autre agent. Il faut coordonner ces corrections avant de conclure l'audit.
2. **I8 : copies historiques.** Les caches déjà écrits restent attaquables au coût historique jusqu'à réécriture ou suppression. Une copie déjà exfiltrée ne peut pas être renforcée. Le format binaire conserve `salt/iv/ct` pour compatibilité avec le miroir hors périmètre ; la lecture essaie le coût document puis l'ancien coût uniquement après un échec d'authentification GCM. Les nouvelles écritures n'utilisent jamais l'ancien KDF.
3. **I6 : anciens fichiers Python.** La compatibilité ajoutée permet leur vérification Python. Elle ne transforme pas les anciennes preuves au format historique en preuves interopérables Web : une signature existante ne peut pas être réencodée sans sa clé privée. Les nouvelles preuves utilisent le format corrigé.
4. Le contrôle d'intégration parent doit tenir compte des nouveaux codes de sortie de `doc-verify` (1 altération, 2 avertissement) et des refus désormais explicites du writer lorsque la protection fichier-clé ne peut pas être préservée.
