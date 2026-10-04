## 9. Signatures — Elium Sign

Elium Sign repose sur **deux couches volontairement séparées**.

### 9.1 Signature visuelle (toujours)

Dessin, texte tapé, image, tampon (Approuvé / Validé / …), initiales, QR code, ou
mixte ; placement libre (déplacement, redimensionnement, rotation, z-index, ancrage
page) en **% de page** (donc portable). Seule, **elle n'est pas une preuve**
(copiable) — c'est une marque d'intention.

### 9.2 Preuve cryptographique (optionnelle, niveau « avancé »)

Empreinte du contenu `SHA-256(canonicalJSON(document))`, signature **Ed25519** sur
`{v, signatureId, signedContentHash, signer, signedAt}`, empreinte de clé publique,
horodatage **local** (non qualifié).

### 9.3 Statuts (toujours recalculés à l'ouverture, jamais lus tels quels)

| Statut | Signification |
|---|---|
| `valid` | La signature vérifie **et** le document est identique à l'état signé |
| `modified` | La signature vérifie mais le document a changé depuis |
| `invalid` | La signature ne vérifie pas |
| `unknown_key` | La clé de confiance fournie ≠ celle du signataire |
| `visual_only` | Signature visuelle sans preuve cryptographique |

Interopérable Web Studio ↔ CLI (`elium doc-verify`). La confiance dans la clé
s'établit hors bande (empreinte) ou par épinglage TOFU.

> **Attention** : sur un document **non chiffré / non verrouillé**, un tiers peut
> retirer une signature et reconstruire le paquet. Pour une non-répudiation forte,
> utilisez `locked` ou `secure_max` **et** vérifiez la clé publique du signataire.

### 9.4 Signature à distance par lien

Un signataire **sans compte Elium** peut signer via un lien transmis hors bande
(courriel, message) : il ouvre une page dédiée (`SignLinkView`), le document est
déchiffré **dans son navigateur** grâce au secret porté par le fragment d'URL
(`#k=...`, jamais envoyé au serveur), une identité Ed25519 est générée à la volée
pour signer — **la clé privée ne quitte jamais le navigateur du signataire** —
puis l'artefact signé est re-chiffré sous la **même clé de contenu** et renvoyé
par une route publique scellée par jeton (`POST /api/links/:token/sign`,
`server/src/routes/signing.ts`). Le serveur ne voit donc que du chiffré, à
l'aller comme au retour ; il ne stocke ni ne transmet jamais la clé privée du
signataire. Fonctionne pour les `.elium` (preuve Ed25519) et pour les PDF
(PAdES, certificat auto-signé) ; le signataire peut aussi refuser, et l'émetteur
relancer un lien expiré sans le régénérer.

---
