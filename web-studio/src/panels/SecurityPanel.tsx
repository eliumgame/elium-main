import { Alert, Field, Button } from "../ui/components";
import { Lock, Check, CalendarClock, Users, Copy } from "lucide-react";
import { PROFILE_ORDER, PROFILES } from "../format/profiles";
import { copyText } from "../sign/identity-store";
import type { Studio } from "../studio/types";

const HEX_KEY = /^[0-9a-fA-F]{130}$/; // P-256 uncompressed point = 65 bytes = 130 hex

export default function SecurityPanel({ studio }: { studio: Studio }) {
  const current = studio.file.manifest.profile;
  const expiresAt = studio.file.manifest.accessExpiresAt;
  const expiryDate = expiresAt ? expiresAt.slice(0, 10) : "";
  const expired = !!expiresAt && Date.now() > Date.parse(expiresAt);
  const recipientText = studio.recipients.join("\n");
  const invalidRecipients = studio.recipients.filter((r) => !HEX_KEY.test(r));

  return (
    <div className="panel">
      <section className="panel-section">
        <h3 className="panel-title"><Lock size={15} /> Profil de protection</h3>
        <p className="muted">La protection est optionnelle. Choisissez un niveau simple ou avancé.</p>

        <div className="profile-grid">
          {PROFILE_ORDER.map((id) => {
            const p = PROFILES[id];
            const active = current === id;
            return (
              <button
                key={id}
                className={`profile-card ${active ? "is-active" : ""}`}
                disabled={!studio.editable}
                onClick={() => studio.changeProfile(id)}
              >
                <div className="profile-card__head">
                  <span className={`badge badge--${p.accent}`}>{p.badge}</span>
                  {active && <Check size={15} className="profile-card__check" />}
                </div>
                <div className="profile-card__label">{p.label}</div>
                <div className="profile-card__desc">{p.description}</div>
                <div className="profile-card__caps">
                  {p.encrypted && <span>🔒 chiffré</span>}
                  {p.passwordRequired && <span>🔑 mot de passe</span>}
                  {p.locked && <span>📌 verrouillé</span>}
                  {p.tracking && <span>🧾 suivi</span>}
                  {p.signaturesExpected && <span>✍ signature</span>}
                </div>
              </button>
            );
          })}
        </div>
      </section>

      <section className="panel-section">
        <h3 className="panel-title"><CalendarClock size={15} /> Expiration d'accès</h3>
        <p className="muted">
          Date au-delà de laquelle le document est marqué comme expiré. Lorsqu'un sceau est apposé,
          cette date est authentifiée (inviolable).
        </p>
        <Field label="Expire le (optionnel)">
          <input
            className="settings__input"
            type="date"
            disabled={!studio.editable}
            value={expiryDate}
            onChange={(e) =>
              studio.setAccessExpiry(e.target.value ? new Date(`${e.target.value}T23:59:59Z`).toISOString() : null)
            }
          />
        </Field>
        {expiresAt && (
          <Alert tone={expired ? "danger" : "info"} title={expired ? "Accès expiré" : "Expiration programmée"}>
            {expired
              ? `L'accès à ce document a expiré le ${new Date(expiresAt).toLocaleDateString()}.`
              : `Expire le ${new Date(expiresAt).toLocaleDateString()}. Réenregistrez (avec sceau) pour authentifier la date.`}
          </Alert>
        )}
      </section>

      {PROFILES[current].encrypted && (
        <>
          <Alert tone="warning" title="Chiffrement actif">
            Un mot de passe vous sera demandé à l'enregistrement. Le contenu est chiffré (Argon2id + AES-256-GCM).
            Sans le mot de passe, le document est irrécupérable.
          </Alert>
          <section className="panel-section">
            <label className="secure-toggle">
              <input
                type="checkbox"
                disabled={!studio.editable}
                checked={!!studio.file.manifest.protection.metadataEncrypted}
                onChange={(e) => studio.setEncryptMetadata(e.target.checked)}
              />
              <span>
                <strong>Chiffrer aussi les métadonnées</strong>
                <span className="muted"> — titre, signataires et journal masqués sur le fichier ouvert sans mot de passe (au lieu d'être lisibles en clair).</span>
              </span>
            </label>
          </section>

          <section className="panel-section">
            <h3 className="panel-title"><Users size={15} /> Destinataires (sans mot de passe)</h3>
            <p className="muted">
              Chiffrez pour des destinataires : chacun ouvre avec SA clé de réception, sans mot de passe partagé.
              Collez leurs clés publiques (une par ligne). Si renseigné, le mot de passe n'est pas demandé.
            </p>
            <Field label="Clés publiques de réception (P-256, hex)">
              <textarea
                className="settings__input"
                rows={3}
                disabled={!studio.editable}
                value={recipientText}
                placeholder="04a1b2…"
                spellCheck={false}
                onChange={(e) =>
                  studio.setRecipients(e.target.value.split(/\s+/).map((s) => s.trim()).filter(Boolean))
                }
              />
            </Field>
            {invalidRecipients.length > 0 && (
              <p className="muted">⚠ {invalidRecipients.length} clé(s) au format invalide (130 caractères hexadécimaux attendus).</p>
            )}
          </section>
        </>
      )}

      <section className="panel-section">
        <h3 className="panel-title"><Users size={15} /> Votre clé de réception</h3>
        {studio.recipientPublic ? (
          <>
            <p className="muted">Partagez cette clé publique pour recevoir des documents chiffrés à votre intention.</p>
            <div className="keyline">
              <span className="keyline__label">Empreinte</span>
              <code className="keyline__value">{studio.recipientPublic.fingerprint}</code>
            </div>
            <div className="settings__row" style={{ marginTop: 6 }}>
              <Button variant="outline" size="sm"
                onClick={() => void copyText(studio.recipientPublic!.publicHex)}>
                <Copy size={14} /> Copier ma clé publique
              </Button>
              <Button variant="ghost" size="sm" onClick={() => studio.forgetRecipientKey()}>Oublier</Button>
            </div>
          </>
        ) : (
          <>
            <p className="muted">Aucune clé de réception. Générez-en une pour qu'on puisse vous envoyer des documents chiffrés.</p>
            <Button variant="outline" size="sm" onClick={() => void studio.generateRecipientKey()}>
              <Users size={14} /> Générer ma clé de réception
            </Button>
          </>
        )}
      </section>
      <Alert tone="info">
        Un <b>.elium</b> non chiffré n'est pas confidentiel. Voir <code>SECURITY.md</code> pour les limites.
      </Alert>
    </div>
  );
}
