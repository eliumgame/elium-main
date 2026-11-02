# Audit : Détecteur et Parapheur

Trois constats du lot J corrigés dans `68d913f`.

- C2PA : seule une assertion référencée par le claim et dont le hachage a été
  validé peut servir de liaison au contenu. Ses exclusions doivent correspondre
  aux segments du manifeste du conteneur, sans couvrir les octets d'image.
- Le statut `valid_*` exige une liaison au contenu vérifiée. Le Détecteur ne
  présente pas une origine IA comme vérifiée lorsque cette liaison manque.
- Le Parapheur vérifie la présence et le verdict de la signature, ainsi que
  l'identité de la partie, avant d'afficher « signé » en vert ou « terminé ».

Vérifications : 16 tests C2PA, typage et ESLint passent. Le lot Parapheur doit
encore être inclus dans la validation navigateur globale avant publication.
