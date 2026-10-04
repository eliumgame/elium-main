### 4.5 Drive local & Parapheur

- **Drive local** : bibliothèque de documents `.elium` en IndexedDB, chiffrée au
  repos ; **coffre local** optionnel chiffré (mot de passe d'application séparé,
  `format/vault-store.ts`) ; brouillons chiffrés (récupération/reprise) ;
  historique de **versions locales** indexé par `docId` ; purge exhaustive
  « Effacer les données locales ».
- **Parapheur** : circuit de signature déclaratif local (file de documents à
  signer, index par `docId`, suivi des statuts).
