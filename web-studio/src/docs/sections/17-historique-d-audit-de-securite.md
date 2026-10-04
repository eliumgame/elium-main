## Historique d'audit de sécurité

Ce chapitre garde la trace des audits passés et dit, **après vérification dans le code d'octobre 2026**, ce qui est corrigé. Un défaut corrigé n'est pas un défaut qui ne reviendra pas : les tests cités sont là pour l'empêcher.

### Audit initial de juin 2026

Revue de code et test d'intrusion du 10 juin 2026, onze scénarios. Le chiffrement lui-même était solide. En revanche, l'**intégrité**, le **suivi** et les **signatures** reposaient sur des données non authentifiées : manifeste, journal et signatures sont des entrées d'archive en clair. Le correctif central est le **sceau de document Ed25519** (voir le chapitre sur la cryptographie).

| N° | Faille | Gravité | État vérifié |
|---|---|---|---|
| F-1 | Intégrité non authentifiée (altération silencieuse) | Critique | Corrigé (sceau) |
| F-2 | Journal réécrivable sans détection | Critique | Corrigé (sceau) |
| F-3 | Signature « valide » forgée, interface trompeuse | Critique | Atténué (sceau, mention « clé non vérifiée », carnet de clés) |
| F-4 | Retrait de signature non détecté | Critique | Corrigé (sceau) |
| F-5 | Clé privée Ed25519 en clair dans le navigateur | Critique | Corrigé (chiffrée au repos) |
| F-6 | Usurpation de badge ou de profil | Élevée | Corrigé (sceau) |
| F-7 | Fuite de métadonnées sur fichier chiffré | Élevée | Corrigé (chiffrement des métadonnées, facultatif) |
| F-8 | Bornes de dérivation différentes entre Web et Python | Élevée | Corrigé (bornes alignées) |
| F-9 | Archive ZIP sans plafond, épuisement mémoire | Élevée | Corrigé (128 Mio par entrée, 384 Mio au total, 10 000 entrées) |
| F-10 | Robustesse de l'analyseur | Moyenne | Corrigé (erreurs typées, garde de profondeur) |
| F-11 | Application de bureau à l'écoute sur toutes les interfaces | Élevée | Corrigé (écoute locale uniquement, en-têtes de sécurité) |
| F-12 | Export : liens `javascript:`, injection CSS | Moyenne | Corrigé (filtrage des schémas, URL de type Blob) |

Les tests concernés : `tests/python/test_seal.py`, `web-studio/tests/seal.test.ts`, `seal-pinning.test.ts` et les tests d'interopérabilité du sceau. Deux scripts d'attaque (`security/poc_tamper.py`, `security/poc_dos_spoof.py`) sont rejoués dans la CI : `[BLOCKED]` signifie que la défense a tenu.

### Audit d'août 2026 et ses sept priorités

Un audit du code de toute la suite (version 4.4.13, 30 août 2026), module par module, avec citation du fichier et de la ligne, a relevé **79 constats** : 7 priorités P0, 24 P1, 36 P2 et 12 P3. Les sept P0 :

| P0 | Constat | État vérifié |
|---|---|---|
| 1 | Retour à une version antérieure forçable par une page web quelconque (lanceur sans protection) | Corrigé avant 4.10 : jeton de session et contrôle d'origine sur les routes d'état, contrôle d'hôte |
| 2 | Signal C2PA falsifiable présenté comme une vérification | Atténué avant 4.10 (présenté comme non authentifié) ; **vraie vérification** de signature livrée en 4.10 |
| 3 | Création d'organisation qui échoue en silence | Corrigé avant 4.10 (message d'erreur visible) |
| 4 | Document Tableur ou Présentations corrompu rouvert vierge sans avertir | Présentations corrigé avant 4.10 ; **Tableur corrigé en 4.10** (autosauvegarde illisible signalée) |
| 5 | `elium doc-sign` supprime les ressources embarquées | Corrigé avant 4.10 |
| 6 | Formules « tirées » d'Excel perdues à l'import | Corrigé avant 4.10 |
| 7 | Couleurs de thème Excel jamais résolues à l'import | Corrigé avant 4.10 |

**Bilan** : six P0 sur sept corrigés avant la 4.10, le dernier (Tableur, autosauvegarde illisible) corrigé en 4.10. Le cas du C2PA est plus nuancé que ce décompte : la présentation trompeuse a été retirée avant, la vérification réelle de la signature date de la 4.10.

Les autres constats (P1 à P3) n'ont pas tous été revérifiés pour ce chapitre. Pour l'état réel, fiez-vous aux tests et au journal des versions, pas à ce tableau seul.

### Autres durcissements issus des audits

| Sujet | État |
|---|---|
| SSO : refus si l'e-mail n'est pas vérifié par le fournisseur | Corrigé (4.2.13) |
| Récupération des clés SSO : redirections non revalidées (SSRF) | Corrigé : aucune redirection suivie |
| Limitation de débit des blobs et des liens publics | Corrigé |
| Journal d'audit à intégrité chaînée | Livré |
| `X-Forwarded-For` usurpable | Corrigé (confiance limitée aux proxys privés) |
| Relais collaboratif sans plafonds | Corrigé |
| Panne de Redis invisible | Corrigé : l'état est dans `/api/health` |
| Mot de passe par défaut des services du Drive | Corrigé : secrets obligatoires, Redis protégé |
| Images construites sur le serveur | Corrigé : images signées épinglées par empreinte |
| Course de mise à jour du lanceur (rejets « signature invalide ») | Corrigé (4.4.4) |
| Contrôle d'hôte sur toutes les routes internes du lanceur | Livré |

### Signaler une vulnérabilité

**Ne pas** ouvrir de ticket public. Contactez les mainteneurs par un canal privé : accusé de réception, puis calendrier de correction.

### Ce qui reste ouvert

- La chaîne de déploiement du serveur n'a jamais été exercée de bout en bout sur un vrai serveur.
- La signature de code Windows (Authenticode) n'est pas en place, faute de certificat.
- Le journal d'audit du Drive est vérifiable mais pas ancré à l'extérieur.
- Aucun audit de sécurité **externe** n'est documenté dans le dépôt : les audits ci-dessus sont des revues internes.
