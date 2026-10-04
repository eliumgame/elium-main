## 10. Le Drive d'entreprise

### 10.1 Backend (Node/TypeScript Fastify + PostgreSQL)

- **Zéro-connaissance** : le serveur ne stocke que du **chiffré** (contenu, noms
  de fichiers, clés emballées) et des métadonnées d'autorisation. Jamais de mot de
  passe, de clé privée ni de contenu en clair.
- **Schéma** : utilisateurs, organisations, clés de recouvrement d'org, rôles,
  adhésions, groupes (clé P-256 par équipe), nœuds (arbre dossiers + fichiers),
  **node_keys (ACL cryptographique)**, versions, liens de partage, updates de
  collaboration, invitations, sessions, défis de connexion, codes de secours MFA,
  journal d'audit. Migrations idempotentes au démarrage.
- **Stockage** : driver `fs` (volume, LUKS recommandé) **ou `s3`/MinIO**,
  upload/download **en streaming** (multipart, sans bufferisation mémoire) — adapté
  aux fichiers volumineux. **Zéro configuration manuelle** : au démarrage, `fs`
  crée son dossier et `s3`/MinIO **crée son bucket** s'il manque (best-effort,
  idempotent ; sur un S3 externe verrouillé qui interdit `CreateBucket`, un bucket
  pré-existant est simplement détecté).

### 10.2 RBAC : rôles, permissions, héritage

- **Catalogue de 36 permissions** et **7 rôles système** clonés par organisation.
  Un rôle personnalisé est n'importe quel sous-ensemble de permissions.
- **Résolution des droits** = rôle d'org ∪ rôles des groupes ∪ ACL héritée des
  dossiers parents + droits du propriétaire du nœud.
- Le **propriétaire d'organisation** dispose des pleines permissions sur tout nœud
  de l'org (il détient la clé de recouvrement).
- Le partage est **profond** : un accès accordé sur un dossier est hérité par tout
  son sous-arbre.

### 10.3 Partage, versions, corbeille

- **Partage** vers un **membre**, une **équipe** ou par **lien externe** (liens
  publics chiffrés, avec page publique d'ouverture).
- **Versions** : historique par nœud.
- **Corbeille** : suppression réversible.
- **Journal d'audit** par organisation (à intégrité chaînée, §13).

### PDF dans le Drive

Un double-clic sur un PDF du Drive l'ouvre dans l'éditeur PDF d'Elium : il est déchiffré
dans le navigateur, avec tous les outils du module PDF. **Enregistrer** (Ctrl+S) le
rechiffre et le dépose comme **nouvelle version** du même fichier ; les versions
précédentes restent dans l'historique (Versions). Si le fichier a été modifié dans le Drive
depuis son ouverture (par exemple par un collègue), Elium le signale et demande avant de le
remplacer. Il n'y a pas de co-édition en temps réel des PDF. « Retour au Drive » ferme
l'éditeur ; « Télécharger » reste disponible dans les actions du fichier.

### 10.4 Co-édition temps réel chiffrée

CRDT **Yjs** pour Documents, Tableur et Présentations : curseurs colorés, présence.
Le **relais ne voit que du chiffré** — les updates Yjs sont chiffrées côté client
avant transit. Les éditeurs collaboratifs partagent l'essentiel du code des
éditeurs locaux (`SlidesEditor` unifié, `buildExtensions` partagés). La fusion de
texte se fait au caractère près (`Y.Text` + diff minimal `syncYText`) dans le
Tableur et les Présentations collaboratifs. Le document collaboratif persiste et
synchronise aussi page/styles/filigrane dans le Y.Doc (parité avec la surface
locale).

> **Limite d'échelle connue** : l'état du relais collab est aujourd'hui en mémoire
> de processus (mono-instance). La scalabilité horizontale (backplane Redis/NATS)
> est identifiée comme un chantier à venir.

### 10.5 Client (SDK + UI)

- **SDK chiffré typé** (refresh automatique des jetons), cryptographie par nœud,
  providers de co-édition.
- **UI** : authentification split-hero + onboarding par lien d'invitation,
  explorateur chiffré, partage (membre / équipe / lien externe), éditeur de rôles
  et permissions, membres, équipes, versions, corbeille, journal d'audit, page
  publique d'ouverture de liens, onglet **Sécurité (2FA)**, onglet **SSO & SCIM**
  (`drive-cloud/ui/SsoScimPanel.tsx`), onglet **Recouvrement**
  (`drive-cloud/ui/RecoveryPanel.tsx`).

---
