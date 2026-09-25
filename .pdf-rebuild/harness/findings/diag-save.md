# FINDINGS — domaine save (3e tentative, rejoué de zéro : aucun FINDINGS.md antérieur n'existait)

## save-01 P0 — Exporter un PDF protégé par mot de passe (ouvert avec « test ») produit un fichier illisible
- Repro : `cd diag/save && npx tsx --import ./register.mjs 01-roundtrip.mts encrypted-aes` (sortie : out/01-all.txt)
- Preuve : src s'ouvre avec « test » (7 p., texte c99290d7c86b) ; sortie A (sans modif) et B (1 note) → pdf.js `Mot de passe incorrect.` avec le MÊME mot de passe ; Info/Producer de la sortie en clair alors que le reste est chiffré.
- Cause : PdfWorkspace.tsx:296 `bytesRef.current = raw.slice()` garde les octets CHIFFRÉS ; save.ts:76 exige des octets déjà déchiffrés mais save.ts:100 charge avec `ignoreEncryption:true` puis save.ts:354 `doc.save({useObjectStreams:true})` : l'/Encrypt du trailer est conservé, les objets chiffrés sont recopiés dans de nouveaux flux d'objets non chiffrés, les nouvelles chaînes (Info, annotations) sont écrites en clair → incohérent.
- Correction : à l'ouverture d'un PDF chiffré, déchiffrer une fois (`removeProtection(raw, pw)` existe déjà, security.ts:637) et garder les octets DÉCHIFFRÉS dans bytesRef ; ré-appliquer la protection d'origine à l'export si l'utilisateur ne l'a pas retirée (comme Acrobat, qui conserve la sécurité du document).

## save-02 P0 — Exporter un PDF à restrictions sans mot de passe d'ouverture (owner-only) produit un fichier corrompu
- Repro : `npx tsx --import ./register.mjs 01-roundtrip.mts encrypted-owner` (sortie : out/01-b.txt)
- Preuve : src s'ouvre sans mot de passe (3 p.) ; sortie A et B → pdf.js « Ce PDF est protégé par un mot de passe », warnings `Invalid stream: Unknown compression method in flate stream`, `XRef.parse - Invalid "Root" reference`. Le cas est très courant (relevés bancaires, PDF d'entreprise « non modifiable »).
- Cause : même chaîne que save-01 (PdfWorkspace.tsx:296 + save.ts:100/354) ; en plus engine.ts `encrypted: !!password` → le document owner-only est vu comme NON chiffré, aucun avertissement.
- Correction : détecter /Encrypt avec `inspectProtection` à l'ouverture, déchiffrer avec le mot de passe vide (`removeProtection(raw,"")`), respecter les permissions (ou demander le mot de passe propriétaire comme Acrobat) et ré-appliquer la protection à l'export.

## save-03 P0 — Tout enregistrement détruit les signatures électroniques (réécriture complète, pas d'incrémental) — sans avertissement
- Repro : `npx tsx --import ./register.mjs 02-signed-incremental.mts` puis `02b-sigdump.mts` (sortie out/02.txt)
- Preuve : word-contrat signé PAdES par Elium → `verifyPdfSignatures` = [{valid:true,covers:true}], engine.info.signed=true. Export SANS modification (A) : 123 210 → 74 280 o, préfixe signé non conservé, `verifyPdfSignatures(A)` = [] ; après UNE note (B) : [] et engine.info.signed=false. Le dict /V existe encore mais il est recompressé dans un /ObjStm, /ByteRange n'est plus lisible, le condensat ne peut plus correspondre. Elium lui-même ne voit plus AUCUNE signature (la casse est masquée : « Aucune signature »).
- Cause : save.ts:100 `PDFDocument.load` + save.ts:354 `doc.save({ useObjectStreams: true })` = réécriture totale ; aucune voie d'enregistrement incrémental ; exportPdf (PdfWorkspace.tsx:763) ne consulte pas `engine.info.signed` (seul le re-signe a `confirmResign`, PdfWorkspace.tsx:~880).
- Correction : implémenter l'enregistrement incrémental (ajout en fin de fichier des seuls objets modifiés + xref/trailer /Prev) pour les ajouts de commentaires/remplissage de champs quand le document est signé (c'est ce que fait Acrobat, contrôlé par /DocMDP) ; à défaut, avertir et proposer « Enregistrer une copie » en expliquant que les signatures seront invalidées.
