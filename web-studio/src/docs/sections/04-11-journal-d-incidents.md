### Journal d'incidents local

Quand quelque chose échoue dans l'application, Elium le note dans un journal
**sur votre appareil**. Il n'y a **aucune télémétrie** : rien n'est envoyé.

| Point | Détail |
|---|---|
| Où | Stockage de l'application (clé `elium_crash_log`) |
| Taille | 50 entrées au maximum, les plus récentes. Champs coupés à 4 000 caractères |
| Contenu d'une entrée | Date, source, message d'erreur, pile technique |
| Alimentation | Erreurs non gérées, promesses rejetées, plantages d'affichage et erreurs signalées par les modules |

Le journal ne doit pas contenir le contenu de vos documents. Mais Elium ne filtre
pas les messages d'erreur : un message peut mentionner un nom de fichier. **Relisez
avant de partager.**

### Réglages, Confidentialité & données

| Bouton | Effet |
|---|---|
| Afficher le journal, Masquer le journal | Montre les entrées avec leur « Pile technique » |
| Copier le journal | Copie le texte pour un rapport de bogue |
| Vider le journal | Efface, après confirmation |

### Écran « Elium a rencontré un problème »

Si l'affichage plante, l'écran explique que vos documents ne sont pas perdus : les
sauvegardes automatiques sont conservées et proposées à la réouverture. Boutons :

- **Recharger Elium** ;
- **Copier le journal d'incidents** ;
- **Effacer le journal et recharger**.

### Limites connues du journal

- Il est lié à ce profil : il disparaît si vous effacez les données locales.
- Aucun envoi automatique : c'est à vous de le copier et de le transmettre.
- Il ne remplace pas `update.log`, qui concerne les mises à jour.
