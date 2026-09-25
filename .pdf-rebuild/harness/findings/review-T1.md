# Relecture adversariale T1 — constats

Relecteur démarré 2026-09-25. Base chantier : 337579c..028026f. Port 3241.

## Vérifications positives (exécutées)
- Build vite OK ; serveur CSP worktree sur 3241 (review-T1/csp_server.py).
- xref STRICTE (xrefcheck.mts : chaque décalage « n » → « num gen obj », chaîne /Prev, flux xref, hybrides /XRefStm) :
  27 fichiers produits (corpus iC, UI, chiffrés, flux xref form-acro, signés) → 0 erreur. (pdf.js/pdf-lib reconstruisent
  en silence : ils ne prouvaient rien sur la table.)
- Adobe Acrobat Pro 26.2 (IAC/COM invisible, acro.js) : 13 fichiers incrémentaux Elium (edge-1000, word-250, owner-only
  chiffré, form-acro flux xref, irt, rot-2, undo, merge, titres…) ouverts SANS réparation (doc.dirty=false), annotations
  et valeurs de formulaire vues par Acrobat, sécurité « Standard » conservée.
- Signatures dans Acrobat : référence = Acrobat lui-même ajoutant une note à signed-word.pdf en incrémental
  (acro-ref2.js) → « Signature NON VALABLE. Les documents ont été modifiés… Identité non valable », docValidity=True.
  Les sorties Elium (sig-1 note, sig-2 page ajoutée, sig-word-title, sig-word-note, sig-form-fill) donnent EXACTEMENT le
  même verdict (après attente de la validation asynchrone : sans attente Acrobat répond « INCONNUE », artefact de mesure).
  « Non valable » vient de l'identité auto-signée (l'original non modifié l'est aussi) : pas d'écart Elium/Acrobat.
- n1.mts : réponse /IRT d'une note parente modifiée → reliée au nouvel objet, pas de doublon ; annuler après
  enregistrement → note retirée au 2e enregistrement ; AES-256 /EncryptMetadata false → XMP réécrit lisible ; titre/auteur
  → Info + XMP ; formulaire (texte, case, radio, liste déroulante) → relus par pdf.js ET Acrobat.
- UI CSP : ouvrir annotated/word-contrat/form-acro sans rien toucher → pas de « ● Modifié », pas de brouillon ;
  pivoter puis note → 2 incrémentaux successifs dans la même poignée (EOF 1→2→3, rotation 90 et note relues).

## Constats
- R1 P0 — « Organiser > Depuis un PDF » (= onMergePick, aussi « Fusionner ») ROUVRE le document depuis une copie dérivée
  (buildDerived : réécriture complète, encryption:"remove") via openBytes(merged) SANS poignée ni source d'origine :
  le Ctrl+S suivant écrit une copie DÉCHIFFRÉE / DÉSIGNÉE en annonçant « enregistrement incrémental : +577 o, contenu
  d'origine intact ». Preuves (UI CSP 3241, poignée simulée) :
  · u3.mjs : encrypted-aes256-pwd-test.pdf ouvert avec « test » + insertion de mixed-geometry → Ctrl+S → fichier
    « encrypted-aes256-pwd-test.pdf » écrit, chk.mts : encrypt=false, 14 p., s'ouvre SANS mot de passe ; aucun
    « protection retirée » dans le rapport.
  · u2.mjs : T1/out/signed-word.pdf (PAdES) + insertion → Ctrl+S → aucun dialogue « document signé » ni à l'insertion ni
    à l'enregistrement ; fichier écrit : sigs=[] (signature détruite, widget vide), toast « contenu d'origine intact ».
  (Même schéma, lu seulement : OCR → openBytes(doc.save() d'un PDFDocument.load(ignoreEncryption)) → sur un PDF chiffré,
  c'est exactement l'ancien T1-02.)
- R2 P1 — après insertion/fusion (et OCR, images→PDF), le document est marqué PROPRE : openBytes(…) sans `recovered`
  → markClean. u2.mjs : 14 pages après insertion, badge absent, titre sans « ● », fermeture de page → AUCUN
  beforeunload (témoin : une note → badge « ● Modifié » + beforeunload) ; u1.mjs merge : aucun brouillon écrit ;
  lien au fichier perdu (destRef=null) → Ctrl+S rouvre le sélecteur (pickers 1→2). Fermer la fenêtre = insertion perdue
  sans avertissement ni récupération.
- R3 P1 — CAVIARDAGE contredit par le brouillon de récupération. u4.mjs (UI CSP) : mixed-geometry, « Rechercher »
  « prix » → 7 zones → Ctrl+S → dialogue « définitivement supprimées… révisions précédentes comprises » → fichier
  réécrit, redact-1.pdf ne contient plus « prix 12,50 » (grep 0) ; puis UNE note → 3 s plus tard IndexedDB
  « elium-pdf-recovery » contient { protected:false, sourceLen:4402, diskKey:true } dont les octets CONTIENNENT
  « prix 12,50 » : l'original non caviardé est recopié EN CLAIR dans le profil du navigateur (PdfWorkspace, effet
  brouillon : `source: diskKeyRef.current ? bytesRef.current : undefined`), et y reste si l'utilisateur ferme la fenêtre.
- R4 P1 (perf/mémoire) — après un enregistrement dans le fichier, CHAQUE brouillon (1,5 s après chaque modification)
  recopie et, coffre déverrouillé, RE-CHIFFRE toute la source (encryptBytesAtRest = base64 → JSON → Argon2id → AES-GCM →
  base64, sur le fil principal). draftbench.mts (buildPdfDraft réel) : 5 Mo → 525 ms, tas +352 Mo ; 60 Mo → 7 408 ms,
  tas +2 468 Mo, 106,7 Mo stockés, à chaque modification ; sans coffre : 60 Mo recopiés dans IndexedDB à chaque fois.
  La source ne change pas entre deux brouillons : la stocker une fois. (findPdfDraft/listPdfDrafts font aussi getAll()
  de tous les brouillons, sources comprises, à chaque ouverture / écran d'accueil.)
- R5 P1 — « .elium » marque le PDF comme enregistré AVANT/SANS que rien ne soit écrit : saveElium appelle
  onExportElium(…) sans l'attendre puis setSavedVersion + deletePdfDraft + toast « Document enregistré ». u5.mjs (UI CSP) :
  note → « ● Modifié », 1 brouillon → .elium → « Chiffrer » → Échap sur le mot de passe (0 téléchargement) → badge
  « Enregistré », brouillon SUPPRIMÉ (0), toast « Document enregistré — Scellé… », puis Ctrl+S → « Aucune modification à
  enregistrer. « word-contrat.pdf » est à jour. » (writtenCount reste 1 : le PDF sur disque n'a PAS la note). Même sans
  annulation, après un .elium réussi le PDF ouvert n'est pas à jour mais Ctrl+S l'affirme. Fermeture = perte sans garde.
- R6 P2 — « Enregistrer sous » avec « Appliquer le caviardage » décoché (option non « copie » → le document est ensuite
  lié au nouveau fichier et marqué enregistré) : les marques de caviardage ne sont écrites NI appliquées NI en annotations
  /Redact (Acrobat les garde marquées). n4.mts : savePdf(applyRedactions:false) → incrémental, p1 annots=[], lost=[],
  warnings=[] → perte silencieuse annoncée comme succès.
- R7 P3 (perf/UX) — une fois une page supprimée (ou un caviardage), TOUS les enregistrements suivants sont des
  réécritures complètes (fullRewriteReasons compare toujours à la source d'origine). n1.mts delpage word-250 : A/B/C =
  full 1 792–1 798 objets ; sur un PDF signé, le dialogue « Réécrire et perdre la signature » revient à chaque Ctrl+S
  alors que la signature a déjà disparu (info.signed vient de la source).
- R3bis P1 (même mécanisme que R3) — « Protéger » (secret/proprio) → Ctrl+S → fichier AES-256 (protect-1.pdf : encrypt,
  pdf.js exige le mot de passe) → une note → u6.mjs : brouillon IndexedDB { protected:false, state EN CLAIR,
  source 82 265 o = word-contrat NON chiffré (sans /Encrypt) }. `sourceProtected: engine.info.encrypted` décrit la SOURCE,
  pas le fichier désormais protégé : contredit la règle de recovery.ts « jamais en clair pour un PDF protégé ».
- R8 P2 (conformité signatures/certification) — ajouter UN commentaire réécrit le CONTENU de la page : pdf-lib
  PDFPageLeaf.addAnnot → normalize() → wrapContentStreams (wrap.mts : pile writeOne annots-pdf.ts:800 → addAnnot →
  normalize) : /Contents 4 0 R devient [187 0 R 4 0 R 188 0 R] (2 flux q/Q ajoutés) + /Resources normalisées, visible
  dans la mise à jour de sig-1.pdf / sig-word-note.pdf. Référence Acrobat (acro-ref-inc-other-out.pdf, note ajoutée par
  Acrobat) : /Contents 4 0 R INCHANGÉ. Pour un document certifié DocMDP P=3 (commentaires permis) — que confirmSignedSave
  laisse passer sans avertissement — une modification du contenu de page n'est pas un changement autorisé (ISO 32000
  12.8.2.2) ; non confirmé dans Acrobat faute de pouvoir produire ici une certification de confiance (P2, pas P1).
  Pour une signature d'approbation, verdict Acrobat identique à la référence (voir « Vérifications positives »).
- R9 P2 (fidélité, T1-07 non corrigé sur ce chemin) — session RESTAURÉE (brouillon de récupération, et par le même code
  une session .elium) : pristineAnnotsRef ne correspond plus (objets désérialisés) → TOUTES les annotations d'origine sont
  supprimées et réécrites depuis le modèle. u7.mjs (UI CSP) : annotated.pdf + note → rechargement → « Restaurer » →
  Ctrl+S → ids.mts : source 182R…190R ; sortie 193R…209R (7 annotations tierces remplacées, réponse re-liée), +12,8 Ko,
  toast « contenu d'origine intact » ; en session normale (T1/out/annotated-iB.pdf) elles restent 182R…190R. Même cause
  pour les signets (pristineBookmarksRef ≠ state.bookmarks restauré → plan réécrit à chaque enregistrement).

## Suite / outillage (exécuté)
- vitest 147 fichiers / 1 823 tests verts ; tsc --noEmit OK ; eslint (0 erreur) et prettier OK sur les 18 fichiers touchés.
- Chiffré RC4-40 AVEC flux d'objets + flux xref (n2.mts) → incrémental, relu avec « secret » et le mot de passe
  propriétaire, refusé sans mot de passe ; pwd-test ouvert avec « owner » → note relue avec « test » ; fichier > 16 Mo à
  flux xref (n5.mts, décalages sur 4 octets) → xref stricte OK ; duplication de page d'annotated.pdf OK.
- Parité Drive : rotation + note sans CSP (bypassCSP) identique à la CSP.
- Acrobat lancé par IAC pour la mesure puis refermé (processus arrêtés : aucun n'existait avant).

## Verdict relecteur
Le moteur incrémental (xref, chiffrement, signatures d'approbation, flux d'objets) tient, y compris devant Acrobat Pro.
Mais le « vrai Enregistrer » a des chemins qui contournent tout ce que T1 garantit : insertion/fusion (R1 P0, R2),
.elium (R5), brouillons de récupération (R3/R3bis confidentialité, R4 perf), sessions restaurées (R9). À corriger avant
de considérer T1 terminé : R1, R2, R3, R5 au minimum ; R4 avant tout usage sur gros scans avec coffre.
