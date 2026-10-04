## Modèle de sécurité et de menace

Ce chapitre dit ce qu'Elium protège, contre qui, par quel mécanisme, et surtout ce
qu'il **ne** protège **pas**. Chaque ligne renvoie à un comportement présent dans le
code. Ce qui n'est pas démontré n'est pas promis.

### Ce qui est protégé

| Actif | Propriété | Mécanisme |
|---|---|---|
| Contenu d'un document chiffré | Confidentialité | Argon2id et AES-256-GCM (profils chiffrés) ; ECDH-ES P-256 pour des destinataires |
| Document scellé | Détection d'altération | Sceau Ed25519 sur le manifeste, les signatures et le journal |
| Document signé | Authenticité de l'auteur et de l'état signé | Preuve Ed25519 liée à l'empreinte du contenu |
| Clés privées au repos | Confidentialité | Chiffrées par mot de passe (Argon2id, AES-256-GCM), jamais en clair sur disque |
| Contenu du Drive d'entreprise | Confidentialité vis-à-vis du serveur | Chiffrement côté client, une clé par nœud |
| Mises à jour | Authenticité | Manifeste signé Ed25519 et SHA-256 de chaque artefact |

### Hypothèses

La protection tient si ces conditions sont vraies :

- le poste de l'utilisateur n'est **pas compromis** (pas de logiciel malveillant, pas
  d'extension de navigateur hostile) ;
- les bibliothèques cryptographiques utilisées sont correctes ;
- le mot de passe est **long et unique** ;
- la clé publique attendue d'un correspondant est obtenue par un **canal de
  confiance** (comparaison hors bande, mots de sécurité) ;
- l'application elle-même provient d'une source authentique (mise à jour signée,
  installateur officiel).

### Adversaires et scénarios

| Scénario | Couvert ? | Mécanisme et réserve |
|---|:---:|---|
| Lecteur sans mot de passe d'un profil chiffré | Oui | Argon2id et AES-256-GCM. Réserve : métadonnées en clair par défaut |
| Altération d'un fichier **scellé** (contenu, journal, signatures, profil) | Détectée | Le sceau casse. Elium n'empêche pas l'ouverture : il l'affiche |
| Altération d'un fichier **non scellé** | Non | `contentHash` n'est pas une clé : un attaquant le recalcule. **Scellez** |
| Altération d'un document signé | Détectée | Le statut devient `modified` |
| Falsification d'une signature | Détectée | La vérification Ed25519 échoue : `invalid` |
| Retrait d'une signature, fichier **non scellé** | Non | Le fichier reste cohérent. Sur un fichier scellé : détecté |
| Réécriture complète du journal, fichier **non scellé** | Non | La chaîne réécrite reste cohérente. Sur un fichier scellé : détectée |
| Re-scellement d'un document falsifié avec la clé de l'attaquant | Partiel | Le sceau est `valid` mais l'empreinte de clé est **différente**. À repérer via carnet de confiance ou épinglage TOFU |
| Usurpation du nom d'un signataire | Partiel | Le nom saisi n'est pas une preuve. Seule la clé l'est, et seulement si vous la connaissez |
| Fausse « étiquette » de profil (un fichier simple qui affiche `secure_max`) | Partiel | Le manifeste d'un fichier non scellé n'est pas authentifié. L'interface signale que la promesse n'est pas vérifiable |
| Substitution d'une ressource (police) | Partiel | Son nom (sha256) est vérifié à la lecture. Les ressources ne sont pas dans le sceau |
| Bombe de décompression, JSON imbriqué, KDF gourmand | Oui | Bornes identiques Python et Web, tailles réelles contrôlées |
| Mise à jour falsifiée | Oui | Signature Ed25519 du manifeste, puis SHA-256 des artefacts |
| Serveur Drive curieux ou compromis | Partiel | Il ne voit que du chiffré, avec tailles par paliers. Il voit la structure, les droits et les dates. Voir « Le Drive d'entreprise » |

### Ce qui n'est pas protégé

**Poste compromis.** Un logiciel malveillant, un enregistreur de frappe ou une
extension hostile voient le mot de passe quand vous le tapez, les documents
déchiffrés à l'écran, et les clés pendant que le trousseau est déverrouillé. Le
verrouillage du trousseau réduit la fenêtre d'exposition (voir « Verrouillage manuel
et par inactivité ») ; il n'est pas une défense contre un attaquant déjà présent. Les
clés privées déverrouillées sont des chaînes JavaScript que le navigateur ne permet
pas d'écraser.

**Mot de passe faible.** Argon2id ralentit les essais hors ligne, il ne les empêche
pas. Le trousseau n'exige que 4 caractères au minimum.

**Métadonnées lisibles sans mot de passe.** Par défaut, un document chiffré expose son
titre, ses signataires, son journal (qui a fait quoi, quand), la liste des
destinataires, le profil et les dates. L'option « Chiffrer aussi les métadonnées » en
cache une partie, pas tout (voir « Chiffrement optionnel des métadonnées »). La taille
du fichier et les noms des entrées de l'archive restent visibles. Le **nom du fichier
sur le disque** est choisi par vous : Elium le propose d'après le titre.

**Polices embarquées.** Elles sont écrites en clair dans l'archive, même pour un
profil chiffré (voir « Le format `.elium` »).

**Journal de suivi.** Il est stocké **dans le fichier**. Les consultations
(ouvertures, exports, validations) qu'il consigne sont visibles de quiconque lit le
fichier, tant que les métadonnées ne sont pas chiffrées. Il n'a de valeur de preuve
que si le fichier est scellé.

**Copies locales dans le navigateur.** Brouillons et historique d'un document **non
protégé** sont stockés en clair dans IndexedDB. Pour un document protégé, ils sont
chiffrés avec son secret. L'index local du Drive (titres) n'est chiffré que si vous
activez le **coffre local**.

**Retour en arrière (rollback).** Une ancienne version valide d'un document scellé
reste valide : le sceau ne contient ni numéro de version ni date de modification.
Rien n'empêche de vous présenter une copie plus ancienne. Comparez les dates et les
journaux.

**Distribution des clés publiques.** Elium n'a pas d'annuaire de confiance. Si on vous
fait accepter une fausse clé publique, tout ce qui en découle est faux.

**Horodatage.** La date d'une preuve `.elium` est celle de l'horloge locale du
signataire : elle n'est pas qualifiée. Seule la signature PDF accepte un horodatage
RFC 3161.

**Révocation.** La révocation d'une clé est locale. Elle n'est pas publiée. Pour les
certificats PDF, Elium ne consulte ni OCSP ni liste de révocation : il ne sait pas
qu'un certificat a été révoqué.

**Non-répudiation qualifiée.** Voir la section suivante.

**Algorithmes.** Ed25519, P-256 et ECDH ne résistent pas à un ordinateur quantique
suffisamment grand. Aucun mécanisme post-quantique n'est implémenté.

**Récupération.** Il n'existe aucune porte dérobée. La perte d'un mot de passe de
document est définitive. Les clés se récupèrent seulement par les voies que vous avez
préparées (voir « Elium Keys »).

### Ce qu'Elium n'est PAS

- **Pas une PKI.** La confiance s'établit hors bande (on fournit la clé publique
  attendue, on compare des mots de sécurité) ou par épinglage TOFU des sceaux. Il n'y a
  pas d'autorité de certification.
- **Pas de signature électronique qualifiée au sens d'eIDAS.** La preuve Ed25519
  atteste qu'un détenteur de la clé a signé un état donné du document. Une signature
  qualifiée exige un prestataire de services de confiance qualifié. La signature PDF
  d'Elium est reconnue par Acrobat, avec un certificat auto-signé ou le vôtre, mais
  elle n'est « qualifiée » que si le certificat l'est.
- **Pas de confidentialité hors des profils chiffrés.** Un `.elium` non chiffré peut être
  lu par n'importe qui.
- **Pas un service d'horodatage ni d'archivage probant.**
- **Pas un audit.** Les preuves de sécurité de la CI sont des tests de non-régression.

### Preuves de sécurité en intégration continue

Deux scripts d'attaque, dans `security/`, sont exécutés à chaque lancement de la suite
de tests Python (`tests/python/test_security_poc.py`), donc à chaque passage de la CI.
Chacun lance des attaques réelles contre le lecteur et échoue (code de sortie non nul)
dès qu'une propriété de sécurité est violée. Il affiche `[BLOCKED]` quand la défense a
tenu et `[PWNED]` quand l'attaque a réussi.

| Script | Attaque | Résultat attendu |
|---|---|---|
| `poc_tamper.py` | 1. Modifier le contenu d'un document verrouillé | Sceau `broken` |
| | 2. Réécrire tout le journal | Sceau `broken` |
| | 3. Forger une signature avec la clé de l'attaquant | Rejetée si la clé de la victime est fournie |
| | 4. Retirer une signature | Sceau `broken` |
| | 5. Fuite de métadonnées d'un fichier chiffré | Fuite par défaut constatée ; aucune fuite avec le chiffrement des métadonnées |
| | 6. Mauvais mot de passe, octet de chiffré modifié | Refusés |
| | 7. Écart des bornes KDF entre Python et Web | Bornes identiques |
| `poc_dos_spoof.py` | 8. Promouvoir un fichier simple en `secure_max` | Possible sans sceau : le script le constate sans échouer |
| | 9. Bombe de décompression ZIP | Refusée par les plafonds |
| | 10. Entrées malformées | Erreur propre, pas de plantage |
| | 11. JSON imbriqué sur 20 000 niveaux | Refusé, pas de récursion |

Le script d'attaque 8 documente une **limite connue** : sans sceau, un manifeste
réécrit peut afficher un autre profil. Le bandeau de vérification compense en
dégradant son verdict.

D'autres tests renforcent ce dispositif : tests d'interopérabilité Python et Web,
plafonds de lecture (`test_dos_caps.py`), chiffrement des métadonnées, épinglage TOFU,
parité du JSON canonique. Ils ne remplacent pas un audit externe, qui n'a pas été
réalisé.

---
