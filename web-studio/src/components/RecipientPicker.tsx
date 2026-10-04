import { useEffect, useState } from "react";
import { UserPlus, QrCode } from "lucide-react";
import { Button, Badge, Field, Modal } from "../ui/components";
import type { Studio } from "../studio/types";
import { recipientCandidates, sanitizeSelection, toggleSelection } from "../sign/recipient-picker-model";
import { isRecipientKeyHex, loadRevocations, normalizeKeyHex } from "../sign/trust-book";
import { fingerprintWords } from "../sign/safety-words";
import { recipientFingerprint } from "../crypto/recipients";
import { makeQrDataUrl } from "../sign/qr";
import { reportError } from "../ui/crash-log";
import "./keyring.css";

/**
 * Choix des destinataires depuis le carnet de confiance (au lieu de coller du
 * hexadécimal). Une clé nouvelle se vérifie par MOTS DE SÉCURITÉ (et QR) avant
 * d'être ajoutée au carnet comme « vérifiée par mots de sécurité ».
 */
export default function RecipientPicker({ studio }: { studio: Studio }) {
  const [adding, setAdding] = useState(false);
  const candidates = recipientCandidates(studio.trustBook, loadRevocations());

  // Une clé du carnet devenue révoquée/expirée est retirée de la sélection.
  useEffect(() => {
    const clean = sanitizeSelection(studio.recipients, candidates);
    if (clean.length !== studio.recipients.length) studio.setRecipients(clean);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [studio.trustBook]);

  return (
    <div className="rpicker">
      {candidates.length === 0 ? (
        <p className="muted">Aucun destinataire dans votre carnet. Ajoutez la clé de réception d'un correspondant.</p>
      ) : (
        <ul className="rpicker__list" aria-label="Destinataires">
          {candidates.map((c) => (
            <li key={c.publicKeyHex} className="rpicker__item">
              <label>
                <input
                  type="checkbox"
                  disabled={!studio.editable || !!c.blockedReason}
                  checked={studio.recipients.includes(c.publicKeyHex)}
                  onChange={() => studio.setRecipients(toggleSelection(studio.recipients, c.publicKeyHex))}
                />
                <span>
                  <strong>{c.name}</strong> <span className="rpicker__words">{c.words}</span>
                </span>
              </label>
              <Badge accent={c.level === "verified" || c.level === "org-attested" ? "success" : "neutral"}>
                {c.levelLabel}
              </Badge>
              {c.blockedReason && <Badge accent="danger">{c.blockedReason}</Badge>}
              {!c.blockedReason && c.warning && <Badge accent="warning">{c.warning}</Badge>}
            </li>
          ))}
        </ul>
      )}
      <div>
        <Button variant="outline" size="sm" disabled={!studio.editable} onClick={() => setAdding(true)}>
          <UserPlus size={14} /> Ajouter un destinataire…
        </Button>
      </div>
      {adding && <AddRecipientModal studio={studio} onClose={() => setAdding(false)} />}
    </div>
  );
}

function AddRecipientModal({ studio, onClose }: { studio: Studio; onClose: () => void }) {
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [words, setWords] = useState("");
  const [qr, setQr] = useState<string | null>(null);
  const k = normalizeKeyHex(key);
  const valid = isRecipientKeyHex(k);

  useEffect(() => {
    let alive = true;
    if (!valid) {
      setWords("");
      setQr(null);
      return;
    }
    (async () => {
      try {
        const fpr = await recipientFingerprint(k);
        if (!alive) return;
        setWords(fingerprintWords(fpr));
        setQr(await makeQrDataUrl(k));
      } catch (e) {
        reportError("recipient-picker.verify", e);
      }
    })();
    return () => {
      alive = false;
    };
  }, [k, valid]);

  const add = async (verified: boolean) => {
    await studio.trustContact(name.trim() || "Sans nom", k, {
      kind: "recipient",
      level: verified ? "verified" : "unverified",
    });
    studio.setRecipients([...studio.recipients.filter((r) => r !== k), k]);
    onClose();
  };

  return (
    <Modal
      title="Ajouter un destinataire"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Annuler
          </Button>
          <Button variant="outline" disabled={!valid} onClick={() => void add(false)}>
            Ajouter sans vérifier
          </Button>
          <Button disabled={!valid} onClick={() => void add(true)}>
            Les mots correspondent — ajouter
          </Button>
        </>
      }
    >
      <div className="settings">
        <Field label="Nom">
          <input
            className="settings__input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="ex. Alice Martin"
          />
        </Field>
        <Field label="Clé publique de réception (P-256, 130 hex)" hint="Collée ou scannée depuis le correspondant">
          <input
            className="settings__input"
            value={key}
            onChange={(e) => setKey(e.target.value.trim())}
            spellCheck={false}
            placeholder="04a1b2…"
          />
        </Field>
        {key && !valid && <p className="muted">⚠ Format invalide (130 caractères hexadécimaux commençant par 04).</p>}
        {valid && (
          <>
            <p>
              <QrCode size={14} /> Mots de sécurité : <code>{words}</code>
            </p>
            <p className="muted">
              Comparez ces mots avec votre correspondant par un autre canal (appel, en personne). S'ils sont identiques,
              la clé est « vérifiée par mots de sécurité » ; sinon n'ajoutez pas la clé.
            </p>
            {qr && <img className="rpicker__qr" src={qr} alt="QR code de la clé publique à comparer" />}
          </>
        )}
      </div>
    </Modal>
  );
}
