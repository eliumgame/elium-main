## 13. Durcissement et journal d'audit

### 13.1 Rotation de clé à la révocation

Retirer un accès régénère la clé de contenu (CEK) : révocation profonde du
sous-arbre (parts de clé héritées nettoyées, propriétaire préservé), re-chiffrement
nom/méta/contenu/**toutes les versions** + compaction du backlog collab sous la
nouvelle clé, révocation des liens externes, garde d'époque `key_epoch` (écriture
périmée → 409), éviction live des pairs (WS close 4001 → re-fetch transparent de
clé), reprise après interruption (slot `prev_key_wrapped`). Côté suite locale, le
`.elium` re-chiffre avec une CEK fraîche à chaque sauvegarde → un destinataire
retiré ne peut plus ouvrir le nouveau fichier.

### 13.2 Quotas, padding, rate-limiting

- **Quotas de stockage** par organisation (dépassement → 507).
- **Padding des tailles** (Padmé / PURBs) : le contenu est rembourré avant
  chiffrement ; la longueur ne révèle plus qu'un bucket (surcoût < ~12 %).
  S'applique au contenu, aux noms, aux métadonnées et aux updates collab.
- **Rate-limiting par route** sur l'authentification (anti-brute-force, clé = IP),
  et **rate-limit dédié aux blobs** : `PUT /nodes/:id/content` (120/min), `GET`
  content (400/min), liens publics `/links/:token(+/content)` (120/min).

### 13.3 Anti-usurpation d'IP (trustProxy)

`trustProxy` ne fait plus confiance à un `X-Forwarded-For` arbitraire (qui
permettait de se donner une IP neuve par requête et de contourner le rate-limit).
Défaut : confiance aux seuls proxys privés/loopback (Caddy co-localisé) ; une
connexion publique directe voit son XFF ignoré. Surchargeable via `TRUST_PROXY`.

### 13.4 Relais collab anti-DoS

`maxPayload` sur le frame WebSocket ; plafond de taille du ciphertext par update
(`MAX_COLLAB_MESSAGE_BYTES`) ; plafond de débit par connexion
(`MAX_COLLAB_MESSAGES_PER_SEC`, fenêtre 1 s, fermeture au dépassement puis re-sync
via backlog) ; borne de la charge d'awareness (anti-amplification) ; plafond de
connexions simultanées par utilisateur (`MAX_COLLAB_CONNECTIONS_PER_USER`).

### 13.5 En-têtes API

CSP verrouillée (`default-src 'none'` ; `frame-ancestors 'none'`) adaptée à une
API JSON pure, `Referrer-Policy: no-referrer`, `Cross-Origin-Resource-Policy:
same-site`.

### 13.6 Journal d'audit à intégrité chaînée

Chaque entrée porte `entry_hash = SHA-256(prev_hash ‖ champs)`, chaîné par
organisation ; toute altération, suppression ou réordonnancement est détecté par
`GET /api/orgs/:id/audit/verify`. L'écriture est sérialisée par un verrou
consultatif par org.

### 13.7 Ménage périodique

`lib/housekeeping.ts` purge les défis d'auth, sessions et invitations expirés
(croissance non bornée). Ne touche pas `collab_updates` (journal CRDT). Le cache
local est passé en Argon2id (`crypto/local-vault.ts`, remplace PBKDF2-100k, compat
descendante des blobs existants).

### 13.8 Chantiers à venir

Nécessitant une décision de déploiement ou un environnement dédié : scalabilité
horizontale du relais collab (backplane Redis/NATS — l'état est aujourd'hui en
mémoire de processus), rotation de clés planifiée, anti-exfiltration/DLP, SCIM
Groups + JWKS dynamique, effacement de compte RGPD (transfert de propriété des
nœuds), interop keyfile-seul Python↔TS.

---
