/**
 * Boîtes de dialogue du portail du propriétaire : imposer la 2FA (avec
 * ré-authentification), réinitialiser le mot de passe d'un utilisateur et rétablir
 * ses accès par la clé d'organisation.
 */
import { useState } from "react";
import { Copy, Check, ShieldAlert, KeyRound, LifeBuoy, X } from "lucide-react";
import type { SiteUser } from "../api";

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="dc-modal-overlay" role="dialog" aria-modal="true" aria-label={title}>
      <div className="dc-modal">
        <div className="dc-modal__head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Fermer">
            <X size={16} />
          </button>
        </div>
        <div className="dc-modal__body dc-portal__dialog">{children}</div>
      </div>
    </div>
  );
}

/** Imposer la 2FA : rappel des risques, confirmation explicite et code valide (ré-authentification). */
export function EnforceMfaDialog({
  ownerHasTotp,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  ownerHasTotp: boolean;
  busy: boolean;
  error: string | null;
  onConfirm: (proof: string | undefined) => void;
  onCancel: () => void;
}) {
  const [ack, setAck] = useState(false);
  const [code, setCode] = useState("");
  const ready = ack && (!ownerHasTotp || code.trim().length >= 6);
  return (
    <Modal title="Imposer la vérification en deux étapes ?" onClose={onCancel}>
      <p>
        <ShieldAlert size={16} /> Tous les comptes, <b>le vôtre compris</b>, devront fournir un code à chaque connexion.
        Si vous perdez votre application d'authentification <b>et</b> vos codes de secours, vous ne pourrez plus vous
        connecter (une procédure de secours existe, mais elle exige un accès au serveur).
      </p>
      <label className="dc-portal__toggle">
        <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} data-testid="mfa-ack" />
        <span>
          J'ai mon application d'authentification <b>et</b> mes codes de secours en lieu sûr.
        </span>
      </label>
      {ownerHasTotp ? (
        <label className="field">
          <span className="field__label">Code de votre application (ou code de secours), saisi maintenant</span>
          <input
            className="input"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            autoComplete="one-time-code"
            placeholder="123456"
            data-testid="mfa-proof"
          />
        </label>
      ) : (
        <p className="muted">
          Votre compte utilise une clé d'accès (pas de code à saisir) : vérifiez que cette clé est bien disponible sur
          cet appareil.
        </p>
      )}
      {error && <p className="dc-error">{error}</p>}
      <div className="dc-portal__links">
        <button
          className="eb eb--primary"
          disabled={!ready || busy}
          onClick={() => onConfirm(ownerHasTotp ? code.trim() : undefined)}
          data-testid="mfa-confirm"
        >
          Imposer la 2FA
        </button>
        <button className="eb eb--ghost" onClick={onCancel}>
          Annuler
        </button>
      </div>
    </Modal>
  );
}

/** Réinitialisation de mot de passe : explications, confirmation, puis lien à transmettre. */
export function PasswordResetDialog({
  user,
  busy,
  link,
  error,
  onConfirm,
  onClose,
}: {
  user: SiteUser;
  busy: boolean;
  link: string | null;
  error: string | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <Modal title={`Réinitialiser le mot de passe de ${user.displayName || user.email}`} onClose={onClose}>
      {!link ? (
        <>
          <p>
            <KeyRound size={16} /> Vous obtenez un <b>lien à usage unique, valable 24 h</b> : la personne y choisit un
            nouveau mot de passe.
          </p>
          <p>
            <b>Ce qui est conservé :</b> son compte, son rôle, son quota, sa 2FA et les éléments dont elle est
            propriétaire — après que vous les avez rétablis (bouton « Rétablir ses accès »).
          </p>
          <p>
            <b>Ce qui change :</b> le chiffrement de bout en bout lie ses clés à son mot de passe. Un nouveau jeu de
            clés est créé : <b>ses anciens fichiers privés ne sont pas lisibles</b> tant que vous ne les avez pas
            rétablis avec la clé d'organisation (recouvrement). Les éléments partagés par d'autres, ses équipes et ses
            anciennes signatures ne sont pas rétablis automatiquement. Toutes ses sessions s'arrêtent à la validation du
            lien.
          </p>
          {error && <p className="dc-error">{error}</p>}
          <div className="dc-portal__links">
            <button className="eb eb--primary" disabled={busy} onClick={onConfirm} data-testid="reset-confirm">
              Générer le lien
            </button>
            <button className="eb eb--ghost" onClick={onClose}>
              Annuler
            </button>
          </div>
        </>
      ) : (
        <>
          <p>Transmettez ce lien à {user.email} par un canal sûr. Il ne sera plus affiché.</p>
          <input
            className="input"
            readOnly
            value={link}
            onFocus={(e) => e.currentTarget.select()}
            data-testid="reset-link"
          />
          <div className="dc-portal__links">
            <button
              className="eb eb--primary"
              onClick={() => {
                void navigator.clipboard?.writeText(link).then(() => setCopied(true));
              }}
            >
              {copied ? <Check size={14} /> : <Copy size={14} />} Copier le lien
            </button>
            <button className="eb eb--ghost" onClick={onClose}>
              Fermer
            </button>
          </div>
          <p className="muted">
            Quand la personne a choisi son mot de passe, revenez ici et cliquez sur « Rétablir ses accès » pour lui
            rendre ses fichiers.
          </p>
        </>
      )}
    </Modal>
  );
}

/** Rétablir les accès d'un utilisateur (éléments dont il est propriétaire) via la clé d'organisation. */
export function RestoreAccessDialog({
  user,
  busy,
  result,
  error,
  onConfirm,
  onClose,
}: {
  user: SiteUser;
  busy: boolean;
  result: number | null;
  error: string | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal title={`Rétablir les accès de ${user.displayName || user.email}`} onClose={onClose}>
      {result == null ? (
        <>
          <p>
            <LifeBuoy size={16} /> Avec la clé d'organisation, les fichiers et dossiers dont {user.email} est
            propriétaire sont ré-enveloppés pour ses clés actuelles (à faire après une réinitialisation de mot de
            passe).
          </p>
          <p className="muted">
            Les éléments qui lui ont été partagés par d'autres se rétablissent un par un dans « Recouvrement ».
          </p>
          {error && <p className="dc-error">{error}</p>}
          <div className="dc-portal__links">
            <button className="eb eb--primary" disabled={busy} onClick={onConfirm} data-testid="restore-confirm">
              Rétablir ses accès
            </button>
            <button className="eb eb--ghost" onClick={onClose}>
              Annuler
            </button>
          </div>
        </>
      ) : (
        <>
          <p data-testid="restore-result">
            <Check size={16} /> {result} élément{result > 1 ? "s" : ""} rétabli{result > 1 ? "s" : ""} pour {user.email}
            .
          </p>
          <button className="eb eb--primary" onClick={onClose}>
            Fermer
          </button>
        </>
      )}
    </Modal>
  );
}
