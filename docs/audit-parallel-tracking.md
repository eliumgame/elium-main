# Correction parallèle — audit 151 constats

Lancement depuis `c0f43e5`, le 2 novembre 2026. Tous les lots de l'audit
initial sont attribués. Un constat déjà corrigé doit être vérifié, et non compté
comme une nouvelle correction. Les rapports de lots distingueront les correctifs
terminés, les vérifications et les points encore ouverts.

| Lot | Constats attribués | Rapport attendu |
| --- | ---: | --- |
| Drive serveur/client, sauvegarde, Passeport | 74 | audit-lot-drive.md |
| PDF et signatures | 11 | audit-lot-pdf.md |
| Éditeurs | 23 | audit-lot-editors.md |
| Publication et bureau | 23 | audit-lot-chain.md |
| Cryptographie et Python | 17 | audit-lot-crypto-python.md |
| Détecteur et Parapheur | 3 | audit-lot-detector.md |

Les agents éditent des périmètres distincts dans le checkout partagé. Toute
modification transversale doit être coordonnée. La revue d'intégration vérifiera
les interfaces serveur/client, les migrations et les tests de régression avant
de conclure à la clôture des constats. Aucune publication n'est effectuée à ce stade.
