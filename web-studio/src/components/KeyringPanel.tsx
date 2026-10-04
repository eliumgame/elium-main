import { useRef, useState } from "react";
import {
  KeyRound,
  Lock,
  Unlock,
  Download,
  Upload,
  RefreshCw,
  Trash2,
  Copy,
  CheckCircle2,
  Circle,
  Fingerprint,
  ShieldAlert,
  LifeBuoy,
  FileKey,
} from "lucide-react";
import { Button, Badge, Alert, Field } from "../ui/components";
import { useDialogs } from "../ui/dialogs";
import { useKeyringController } from "../crypto/use-keyring";
import { keyRowModel, checklistItems, checklistSummary } from "../crypto/keyring-view-model";
import { IDLE_CHOICES } from "../crypto/keyring-session";
import { copyText } from "../sign/identity-store";
import { fingerprintWords } from "../sign/safety-words";
import { revokeTrustedKey } from "../sign/trust-book";
import { RecoveryPhraseModal, SharesModal, RestoreModal } from "./KeyringModals";
import { reportError } from "../ui/crash-log";
import "./keyring.css";

/** Panneau « Mes clés » (composant isolé : réutilisé par SecurityPanel et SettingsModal) : une seule vue pour toutes les clés, leur état, leur sauvegarde. */
export default function KeyringPanel({ compact = false }: { compact?: boolean }) {
  const k = useKeyringController();
  const { prompt, confirm, alert } = useDialogs();
  const [modal, setModal] = useState<"phrase" | "shares" | "restore" | null>(null);
  const [passkeyLabel, setPasskeyLabel] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const own = k.entries.filter((e) => e.type !== "contact");
  const summary = checklistSummary(k.checklist);
  const hasIdentity = own.some((e) => e.type === "identity-ed25519" && e.status !== "revoked");
  const hasRecipient = own.some((e) => e.type === "recipient-p256" && e.status !== "revoked");

  const onImportFile = async (f: File | undefined) => {
    if (!f) return;
    try {
      await k.importBackupText(await f.text());
    } catch (e) {
      reportError("keyring.importFile", e);
    }
  };

  const copyPublic = async (hex: string) => {
    if (!(await copyText(hex))) reportError("keyring.copy", new Error("Presse-papier indisponible"));
  };

  const askExpiry = async (id: string, current?: string) => {
    const v = await prompt({
      title: "Date d'expiration",
      label: "Expire le (AAAA-MM-JJ) — laisser vide pour aucune",
      defaultValue: current ? current.slice(0, 10) : "",
      placeholder: "2028-12-31",
      confirmLabel: "Enregistrer",
    });
    if (v === null) return;
    const t = v.trim();
    if (!t) return k.setExpiry(id, null);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(t) || Number.isNaN(Date.parse(t))) {
      await alert({ title: "Date invalide", message: "Format attendu : AAAA-MM-JJ" });
      return;
    }
    await k.setExpiry(id, new Date(`${t}T23:59:59Z`).toISOString());
  };

  const doRevoke = async (id: string, label: string, pub: string, type: string) => {
    const ok = await confirm({
      title: `Révoquer « ${label} » ?`,
      message:
        "Une clé révoquée est considérée comme COMPROMISE : elle n'est plus proposée pour signer ou recevoir, et ses signatures s'affichent avec une alerte. Cette action est irréversible. Pour un simple remplacement, utilisez « Faire tourner ».",
      confirmLabel: "Révoquer",
      danger: true,
    });
    if (!ok) return;
    await k.revoke(id);
    if (type === "identity-ed25519") revokeTrustedKey(pub, "compromised", "Révoquée depuis Mes clés");
  };

  return (
    <div className={`keyring ${compact ? "keyring--compact" : ""}`}>
      <div className="keyring__bar">
        <Badge accent={k.unlocked ? "warning" : "success"}>
          {k.unlocked ? <Unlock size={12} /> : <Lock size={12} />} {k.unlocked ? "Déverrouillé" : "Verrouillé"}
        </Badge>
        {k.unlocked ? (
          <Button variant="outline" size="sm" onClick={k.lock}>
            <Lock size={14} /> Verrouiller maintenant
          </Button>
        ) : (
          own.length > 0 && (
            <Button variant="outline" size="sm" onClick={() => void k.unlock()}>
              <Unlock size={14} /> Déverrouiller
            </Button>
          )
        )}
        <label className="keyring__idle">
          Verrouillage auto
          <select
            className="settings__select"
            aria-label="Verrouillage automatique après inactivité"
            value={k.idleMinutes}
            onChange={(e) => k.setIdleMinutes(Number(e.target.value))}
          >
            {IDLE_CHOICES.map((m) => (
              <option key={m} value={m}>
                {m === 0 ? "Jamais" : m === 60 ? "1 h" : `${m} min`}
              </option>
            ))}
          </select>
        </label>
      </div>

      {!k.loaded ? (
        <p className="muted">Chargement du trousseau…</p>
      ) : own.length === 0 ? (
        <p className="muted">
          Aucune clé. Générez une identité pour signer et sceller, et une clé de réception pour recevoir des documents
          chiffrés — ou importez une sauvegarde.
        </p>
      ) : (
        <ul className="keyring__list" aria-label="Mes clés">
          {own.map((e) => {
            const m = keyRowModel(e);
            return (
              <li key={e.id} className={`keyring__item keyring__item--${m.status}`}>
                <div className="keyring__head">
                  <FileKey size={15} aria-hidden />
                  <strong className="keyring__label">{e.label}</strong>
                  <Badge accent="info">{m.typeLabel}</Badge>
                  <Badge accent={m.statusTone}>{m.statusLabel}</Badge>
                </div>
                <div className="keyring__meta">
                  <span>
                    Empreinte <code>{e.fingerprint.slice(0, 16)}…</code>
                  </span>
                  <span className="keyring__words">{fingerprintWords(e.fingerprint)}</span>
                  <span>Créée le {new Date(e.createdAt).toLocaleDateString("fr-FR")}</span>
                  {m.expiryLabel && <Badge accent={m.expiryTone}>{m.expiryLabel}</Badge>}
                  <Badge accent={m.backupTone}>{m.backupLabel}</Badge>
                  <span className="muted">{m.protectionLabel}</span>
                </div>
                {m.successionLabel && (
                  <p className="muted keyring__succ">{m.successionLabel} — certificat vérifiable</p>
                )}
                <div className="keyring__actions">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!m.can.export}
                    onClick={() => void k.exportBackup([e.id])}
                  >
                    <Download size={13} /> Exporter
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Copier la clé publique de ${e.label}`}
                    onClick={() => void copyPublic(e.publicHex)}
                  >
                    <Copy size={13} /> Clé publique
                  </Button>
                  {m.can.rotate && (
                    <Button variant="ghost" size="sm" onClick={() => void k.rotate(e.id)}>
                      <RefreshCw size={13} /> Faire tourner
                    </Button>
                  )}
                  <Button variant="ghost" size="sm" onClick={() => void askExpiry(e.id, e.expiresAt)}>
                    Expiration…
                  </Button>
                  {m.can.retire && (
                    <Button variant="ghost" size="sm" onClick={() => void k.retire(e.id)}>
                      Retirer
                    </Button>
                  )}
                  {m.can.reactivate && (
                    <Button variant="ghost" size="sm" onClick={() => void k.reactivate(e.id)}>
                      Réactiver
                    </Button>
                  )}
                  {m.can.revoke && (
                    <Button variant="ghost" size="sm" onClick={() => void doRevoke(e.id, e.label, e.publicHex, e.type)}>
                      <ShieldAlert size={13} /> Révoquer
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Supprimer ${e.label}`}
                    onClick={() => void k.removeKey(e.id)}
                  >
                    <Trash2 size={13} /> Supprimer
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <div className="settings__row" style={{ marginTop: 8 }}>
        {!hasIdentity && (
          <Button variant="outline" size="sm" onClick={() => void k.createIdentity()}>
            <KeyRound size={14} /> Générer une identité de signature
          </Button>
        )}
        {!hasRecipient && (
          <Button variant="outline" size="sm" onClick={() => void k.createRecipientKey()}>
            <KeyRound size={14} /> Générer une clé de réception
          </Button>
        )}
        {own.length > 0 && (
          <Button variant="outline" size="sm" onClick={() => void k.exportBackup()}>
            <Download size={14} /> Sauvegarder tout (.eliumkey)
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
          <Upload size={14} /> Importer une sauvegarde
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept=".eliumkey,application/json"
          hidden
          onChange={(e) => {
            void onImportFile(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
        {own.length > 0 && (
          <Button variant="ghost" size="sm" onClick={() => void k.changePassword()}>
            Changer le mot de passe
          </Button>
        )}
      </div>

      {k.osProtectionAvailable && (
        <label className="secure-toggle">
          <input type="checkbox" checked={k.osProtected} onChange={(e) => void k.setOsProtection(e.target.checked)} />
          <span>
            <strong>Protéger avec Windows</strong>
            <span className="muted">
              {" "}
              — ajoute une couche liée à votre compte Windows sur cet ordinateur, EN PLUS du mot de passe. Illisible sur
              une autre machine : gardez votre phrase de récupération.
            </span>
          </span>
        </label>
      )}

      <section className="keyring__recovery" aria-labelledby="keyring-recovery-title">
        <h4 id="keyring-recovery-title" className="settings__title">
          <LifeBuoy size={15} /> Préparation à la récupération
        </h4>
        <Alert tone={summary.tone} title={summary.text} />
        <ul className="keyring__checklist">
          {checklistItems(k.checklist).map((it) => (
            <li key={it.id} className={it.done ? "is-done" : ""}>
              {it.done ? <CheckCircle2 size={16} aria-label="Fait" /> : <Circle size={16} aria-label="À faire" />}
              <span>
                <strong>{it.label}</strong>
                <span className="muted"> — {it.hint}</span>
              </span>
            </li>
          ))}
        </ul>
        <div className="settings__row">
          <Button variant="outline" size="sm" onClick={() => setModal("phrase")}>
            Phrase de récupération (24 mots)
          </Button>
          <Button variant="outline" size="sm" onClick={() => setModal("shares")}>
            Parts de récupération (Shamir)
          </Button>
          <Button variant="outline" size="sm" onClick={() => setModal("restore")}>
            Restaurer le trousseau…
          </Button>
        </div>

        <h5 className="keyring__sub">
          <Fingerprint size={14} /> Clés d'accès (passkeys)
        </h5>
        {!k.passkeySupported && (
          <p className="muted">
            Clés d'accès non disponibles sur ce navigateur — le mot de passe reste le moyen de déverrouillage.
          </p>
        )}
        {k.master?.passkeys.length ? (
          <ul className="keyring__passkeys">
            {k.master.passkeys.map((p) => (
              <li key={p.credentialId}>
                <span>
                  <strong>{p.label}</strong>{" "}
                  <Badge>
                    {p.kind === "platform"
                      ? "Appareil"
                      : p.kind === "cross-platform"
                        ? "Clé de sécurité"
                        : "Clé d'accès"}
                  </Badge>{" "}
                  <span className="muted">enrôlée le {new Date(p.createdAt).toLocaleDateString("fr-FR")}</span>
                </span>
                <Button variant="ghost" size="sm" onClick={() => void k.removePasskey(p.credentialId)}>
                  Révoquer
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          k.passkeySupported && (
            <p className="muted">
              Aucune clé d'accès enrôlée. Vous pouvez en ajouter plusieurs (appareil + clé de sécurité).
            </p>
          )
        )}
        {k.passkeySupported && (
          <div className="keyring__enroll">
            <Field label="Nom de la clé d'accès">
              <input
                className="settings__input"
                value={passkeyLabel}
                onChange={(e) => setPasskeyLabel(e.target.value)}
                placeholder="ex. Windows Hello, YubiKey"
              />
            </Field>
            <Button
              variant="outline"
              size="sm"
              disabled={own.length === 0}
              onClick={async () => {
                if (await k.enrollPasskey(passkeyLabel || "Clé d'accès")) setPasskeyLabel("");
              }}
            >
              <Fingerprint size={14} /> Enrôler une clé d'accès
            </Button>
          </div>
        )}
      </section>

      {modal === "phrase" && <RecoveryPhraseModal onClose={() => setModal(null)} />}
      {modal === "shares" && <SharesModal onClose={() => setModal(null)} />}
      {modal === "restore" && <RestoreModal onClose={() => setModal(null)} />}
    </div>
  );
}
