# Sécurité — PoC adversariaux

Scripts de démonstration de l'audit 2026-06 (voir [`../DOCUMENTATION.md §9`](../DOCUMENTATION.md#9-historique-daudit-de-sécurité)).
Ils montrent l'état **avant** le sceau : sur un fichier `.elium` **non scellé**, le
contenu, le journal et les signatures sont altérables sans détection.

Les correctifs (sceau de document) sont couverts par des tests de non-régression :
`tests/python/test_seal.py` et `web-studio/tests/seal.test.ts`.

## Exécution

Depuis la racine du dépôt, avec un environnement Python où `elium` est installé :

```bash
python security/poc_tamper.py      # F-1/F-2/F-3/F-4 : altération, journal, forge, retrait
python security/poc_dos_spoof.py   # F-8/F-9/F-10 : DoS, usurpation de badge, robustesse
```

Sortie `[PWNED]` = l'attaque réussit (sur fichier non scellé). Sceller le document
(`write_elium(..., seal_private_key_hex=...)`) ferme F-1/F-2/F-4/F-6.
