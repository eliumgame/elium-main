# T1 — Enregistrement : journal de reprise

Démarré : 2026-09-25 (première tentative, pas de journal antérieur).
Base : pdf-rebuild @ 337579c (fin F1).

## Fait
- Diagnostic UI sous CSP (T1/ui-save.mjs + check.mts) → harness/T1/FINDINGS.md (T1-01…07)
- 7cefe62 : ops/incremental.ts (tail xref, empreintes, mise à jour incrémentale), security.ts (PdfCrypt openCrypt/
  createCrypt/writeEncrypted), save.ts (savePdf + DiskState, buildPdf = compat full, annotations importées intactes,
  signets inchangés gardés, rapport lost/warnings)
- tests/pdf-incremental.test.ts (17 tests verts) : table/flux, 2 enregistrements successifs, signé PAdES reste valide
  (annotation + remplissage), AES-256/owner-only/RC4-128/AES-128, caviardage/pages supprimées = complet, base pdf.js
  saveDocument (champ rempli via annotationStorage) en UNE mise à jour
- Corpus Node (T1/rt-incr.mts, out/rt-incr-1.txt) : les 11 fichiers en incrémental, texte/plan/structure identiques,
  chiffrés rouvrables avec le même mot de passe

- 0ae6685 : core/destination.ts (FS Access / téléchargement), model/recovery.ts (brouillons IDB chiffrés si coffre),
  useUndoable.version (+ tests/undoable-version.test.tsx)
- f00b618 + cbf971a : PdfWorkspace — Ctrl+S = enregistrement dans le fichier (poignée d'ouverture ou choisie une fois),
  Ctrl+Maj+S / bouton = « Enregistrer sous » / « une copie » (SaveDialog refait), avertissement signé (réécriture ou
  contenu), confirmation caviardage, rapport (incrémental/complet, protection, signature vérifiée, modifications
  perdues en dialogue), badge « ● Modifié / Enregistré », titre, beforeunload, garde retour accueil / ouverture,
  brouillon auto (1,5 s) + proposition de restauration à la réouverture + liste sur l'écran d'accueil, protéger /
  retirer la protection = appliqués à l'enregistrement ; engine.info.encrypted inclut owner-only.
- Vérifié UI CSP 3240 : word note (poignée simulée) incrémental +2,1 Ko ; owner-only & pwd-test : protection conservée,
  rouvrables ; --no-fs : téléchargement ; signé : note → signature valide (EOF=2), page ajoutée → dialogue puis
  incrémental (EOF=3) signature toujours valide ; 3e Ctrl+S → « Aucune modification ».

- 89ce4f7 : arbre des pages au plus juste (insertion/suppression via pdf-lib, permutation par réaffectation des feuilles)
  — edge-1000 + page insérée : 6 objets (au lieu de 1 003) ; déplacement p.1 → milieu : 128 objets.
- 50053cb : DocMDP (certificationLevel) + tests structure ; 7a40e04 : XMP synchronisé (ops/xmp.ts + tests)
- 9b9f5df : session .elium restaurée = propre ; Ctrl+S capté en capture + commit du champ en cours (commentaire tapé
  puis Ctrl+S sans quitter le champ → enregistré, vérifié UI)
- UI vérifiée : protéger → réécriture chiffrée (secret/proprio OK, faux refusé) puis note → incrémental même clé ;
  copie optimisée (document reste lié) ; récupération après rechargement (liste + dialogue « Restaurer ») ;
  beforeunload déclenché ; sans CSP (bypassCSP) identique ; téléchargement (--no-fs) identique.
- Mesure UI 1000 p. : incrémental 500–531 ms (toast), ~700 ms mur ; copie assainie (complète) ~960 ms mur.

- a58e6e5 Ctrl+S en capture ; 7f07bfa récupération après enregistrement dans le fichier ; c8040db empreintes SHA-256
  des gros objets ; 028026f lint des tests.
- Vérif. finale sous CSP (build final) sur 6 fichiers du corpus + signé + parcours → voir harness/T1/FINDINGS.md.
- Suite : vitest 147/1 823 verts, tsc OK, eslint/prettier OK (fichiers touchés).

## En cours
- (rien) — T1 TERMINÉ, rapport rendu.

## Reste (hors T1, notés dans FINDINGS « Constats hors périmètre »)
- T7 permissions owner-only / sourcePassword en clair dans .elium ; T8 signature incrémentale ; T2 brancher
  saveDocument ; T11 destination Drive ; doc in-app (documentation.ts) à mettre à jour en phase V.

## Décisions
- Détection des changements par comparaison d'empreintes (sérialisation pdf-lib des objets en clair) plutôt que
  suivi explicite : attrape tout, y compris la base pdf.js saveDocument (crochet T2 : savePdf({source, base})).
- Numérotation des nouveaux objets à partir d'un « plancher » fixe par session (DiskState.floor) : les objets créés
  par un enregistrement précédent gardent leur numéro → non réécrits s'ils sont identiques.
- Complet obligatoire : caviardage, pages supprimées (confidentialité), protection ajoutée/changée/retirée,
  optimisation, assainissement, aplatissement du formulaire, fin de fichier irrégulière. Réécriture complète
  = élagage des objets inaccessibles (contenu des pages supprimées absent).
- Téléchargement (pas de File System Access) : chaque enregistrement repart de la source (original + 1 mise à jour).
- « Enregistrer sous » avec options transformantes (aplatir, assainir, optimiser) = copie : le document reste lié
  à son fichier.
- Protéger / retirer la protection : appliqué par l'enregistrement qui suit (comme Acrobat), plus de copie
  « -protégé.pdf » téléchargée en douce ni d'option `protect` persistante.

## Mesures
- Node edge-1000 + 1 note : incrémental 233–312 ms (+2 130 o, 6 objets) ; complet 388–469 ms (4,15 Mo).
- UI (Edge headless, CSP) edge-1000 : incrémental 500–531 ms (savePdf), ~700 ms mur ; copie assainie ~960 ms mur.
- Petits fichiers : 17–70 ms ; incréments typiques +2 à +9 Ko (note + Info + XMP).

# CORRECTION DE LA REVUE ADVERSARIALE (R1…R9) — démarrée 2026-09-25
Constats : harness/review-T1/FINDINGS.md. Dossier de travail : harness/T1fix/. Port 3240.
## Fait (correction)
- (démarrage) lecture du plan, du journal, des constats
- (reprise 2) analyse faite, plan arrêté :
  A. ops : SaveInput.transform (insertion de pages / calque OCR dans le document de travail) + forceFullReasons ;
     R6 marques non appliquées écrites en /Redact (+ import /Redact) ; R8 pushAnnot sans normalize().
  B. recovery : source jamais recopiée si c'est un PRÉFIXE du fichier enregistré (cas incrémental) ; sinon (session
     dérivée) stockée UNE fois dans un magasin séparé, chiffrée AES-GCM brute avec clé dérivée une fois (R4) ;
     sourceProtected = source chiffrée || disque chiffré || protection en attente (R3bis).
  C. PdfWorkspace : document dérivé (insertion/fusion/OCR) = nouvelle source chiffrée avec la même clé, destination
     et lien au fichier conservés, marqué modifié, brouillon (R1/R2) ; réécriture complète dans le fichier = session
     rebasée sur les octets écrits (R3/R7) ; « signé » d'après le fichier de destination (R7) ; .elium attendu,
     version .elium suivie à part (R5) ; annotations/signets intacts par égalité structurelle (R9).
- A FAIT 85b86f4 : SaveInput.transform + forceFullReasons, appendPdfPages (organize.ts, déchiffre owner-only / demande
  le mot de passe), writeRedactMarks + import /Redact, pushAnnot (R8) ; tests/pdf-save-derive.test.ts (5 verts).
- B FAIT 2f3a611 : recovery.ts v2 (magasins drafts + sources, index diskKey, migration v1), sealBytesAtRest /
  openSealedBytes (local-vault.ts, clé Argon2id par session) ; tests pdf-save-flow (12 verts).
- C FAIT (non vérifié UI) 5ede104 : openBytes(…, extra {recovered, rebased, derived, unsaved}) ; adoptDerived ;
  onMergePick = appendPdfPages dans le document (transform) ; OCR = transform sur état identité + adoptDerived(keep
  state) ; runSave : disque/signé du fichier, forceFull, rebase après complet ; brouillon (sourceProtected étendu,
  source stockée une fois si !sourceOnDisk) ; saveElium attend onExportElium (App → Promise<boolean>), eliumVersion,
  pdfDirty vs dirty ; pristineOptions (identité + snapshot structurel sameValue, signets sans ids) ; tsc/eslint OK.
- D FAIT : UI sous CSP 3240 — u1 merge/draft, u2, u3, u4, u5, u6, u7, u8 (nouveau, signé + page supprimée) tous
  conformes ; n4, wrap, draftbench2 OK ; résultats détaillés dans harness/T1/FINDINGS.md (section « Correction »).
  d9c5900 tests OCR chiffré + sameValue.
- E FAIT : vitest 148 fichiers / 1 832 tests verts ; tsc OK ; eslint 0 ; prettier OK (11 fichiers touchés) ; build OK ;
  parité sans CSP (u3, u7 --no-csp) et mode téléchargement sans File System Access (u9) identiques ; restauration
  d'une session recomposée (u10) OK ; régression u1 rotate OK. 1824686 (instantané gardé à travers l'OCR).
## En cours (correction)
- (rien) — CORRECTION T1 TERMINÉE (85b86f4 → 1824686), rapport rendu.
## Reste (hors périmètre, noté)
- /Redact réimporté sans /IC ni texte de recouvrement (pdf.js le livre en annotation de base) → noir par défaut.
- Historique d'annulation remis à zéro après une réécriture complète (rebase) — dit dans le rapport d'enregistrement.
- OCR non testable dans l'UI headless (modèles locaux absents) : vérifié en vitest (calque chiffré, incrémental).
- Vérification Acrobat des nouvelles sorties (insertion signée, /Redact) non refaite ici.
## Reste (correction)
- R1 P0, R2, R3, R4, R5 (P1) ; R6, R8, R9 (P2) ; R7 (P3)
