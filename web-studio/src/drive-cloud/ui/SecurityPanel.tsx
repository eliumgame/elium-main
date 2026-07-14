/**
 * Security settings — two-factor authentication (TOTP) management. Enroll shows
 * a QR code (scanned by any authenticator app) plus the manual secret, then
 * confirms with a first code and reveals one-time backup codes. The TOTP secret
 * is a SECOND factor only: it never touches the zero-knowledge content keys.
 */
import { useCallback, useEffect, useState } from "react";
import { ShieldCheck, ShieldAlert, Smartphone, KeyRound, Copy, Check, RefreshCw } from "lucide-react";
import { useDrive } from "../session";
import { makeQrDataUrl } from "../../sign/qr";
import type { MfaStatus } from "../types";

type Stage = "idle" | "enrolling" | "showing-codes";

export default function SecurityPanel() {
  const d = useDrive();
  const [status, setStatus] = useState<MfaStatus | null>(null);
  const [stage, setStage] = useState<Stage>("idle");
  const [secret, setSecret] = useState("");
  const [qr, setQr] = useState("");
  const [code, setCode] = useState("");
  const [disableCode, setDisableCode] = useState("");
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const reload = useCallback(async () => {
    try {
      setStatus(await d.api.mfaStatus());
    } catch {
      setStatus(null);
    }
  }, [d.api]);

  useEffect(() => { void reload(); }, [reload]);

  const startEnroll = async () => {
    setErr(null);
    setBusy(true);
    try {
      const { secret: s, otpauthUri } = await d.api.mfaSetup();
      setSecret(s);
      setQr(await makeQrDataUrl(otpauthUri));
      setStage("enrolling");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Impossible de démarrer la configuration.");
    } finally {
      setBusy(false);
    }
  };

  const confirmEnroll = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const { backupCodes: codes } = await d.api.mfaEnable(code.trim());
      setBackupCodes(codes);
      setStage("showing-codes");
      setCode("");
      await reload();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Code invalide.");
    } finally {
      setBusy(false);
    }
  };

  const disable = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      await d.api.mfaDisable(disableCode.trim());
      setDisableCode("");
      setStage("idle");
      await reload();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Code invalide.");
    } finally {
      setBusy(false);
    }
  };

  const copyCodes = () => {
    void navigator.clipboard?.writeText(backupCodes.join("\n"));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const enabled = status?.enabled ?? false;

  return (
    <div className="dc-security">
      <div className="dc-security__status">
        {enabled ? (
          <span className="badge badge--success"><ShieldCheck size={15} /> 2FA activée</span>
        ) : (
          <span className="badge badge--neutral"><ShieldAlert size={15} /> 2FA désactivée</span>
        )}
        {enabled && status && (
          <span className="muted">{status.backupCodesRemaining} code(s) de secours restant(s)</span>
        )}
      </div>

      <p className="muted dc-security__lede">
        La vérification en deux étapes (TOTP) ajoute un second facteur au mot de passe :
        un code à usage unique généré par votre application d'authentification. Ce facteur
        est indépendant du chiffrement de bout en bout — il protège l'accès au compte.
      </p>

      {err && <p className="dc-error">{err}</p>}

      {/* --- Not enabled: enroll --- */}
      {!enabled && stage === "idle" && (
        <button className="eb eb--primary" disabled={busy} onClick={() => void startEnroll()}>
          <Smartphone size={16} /> Activer la 2FA
        </button>
      )}

      {!enabled && stage === "enrolling" && (
        <div className="dc-security__enroll">
          <ol className="dc-security__steps">
            <li>Scannez ce QR code avec Google Authenticator, Aegis, 1Password…</li>
            <li>Ou saisissez la clé manuellement : <code className="dc-security__secret">{secret}</code></li>
            <li>Entrez le code à 6 chiffres affiché pour confirmer.</li>
          </ol>
          {qr && <img className="dc-security__qr" src={qr} alt="QR code d'enrôlement 2FA" width={200} height={200} />}
          <form onSubmit={confirmEnroll} className="dc-security__confirm">
            <input className="input" value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" placeholder="123456" autoFocus />
            <button className="eb eb--primary" disabled={busy || code.trim().length < 6}><Check size={15} /> Confirmer</button>
            <button type="button" className="eb eb--ghost" onClick={() => { setStage("idle"); setErr(null); }}>Annuler</button>
          </form>
        </div>
      )}

      {/* --- Just enabled: reveal backup codes ONCE --- */}
      {stage === "showing-codes" && (
        <div className="dc-security__codes">
          <h3 className="dc-security__codes-title"><KeyRound size={16} /> Vos codes de secours</h3>
          <p className="muted">Conservez-les en lieu sûr. Chacun ne sert qu'une fois et remplace le code de l'application si vous perdez votre téléphone. Ils ne seront plus affichés.</p>
          <ul className="dc-security__codelist">
            {backupCodes.map((c) => <li key={c}><code>{c}</code></li>)}
          </ul>
          <div className="dc-security__codes-actions">
            <button className="eb eb--outline eb--sm" onClick={copyCodes}>{copied ? <><Check size={14} /> Copié</> : <><Copy size={14} /> Copier</>}</button>
            <button className="eb eb--primary eb--sm" onClick={() => setStage("idle")}>J'ai sauvegardé mes codes</button>
          </div>
        </div>
      )}

      {/* --- Enabled: disable / regenerate --- */}
      {enabled && stage === "idle" && (
        <div className="dc-security__manage">
          <form onSubmit={disable} className="dc-security__disable">
            <label className="field">
              <span className="field__label">Désactiver la 2FA (code de vérification requis)</span>
              <div className="dc-security__disable-row">
                <input className="input" value={disableCode} onChange={(e) => setDisableCode(e.target.value)} inputMode="numeric" placeholder="123456 ou code de secours" />
                <button className="eb eb--danger eb--sm" disabled={busy || disableCode.trim().length < 4}>Désactiver</button>
              </div>
            </label>
          </form>
          <button
            className="eb eb--ghost eb--sm"
            disabled={busy}
            onClick={async () => {
              const c = window.prompt("Entrez un code de vérification pour régénérer vos codes de secours :");
              if (!c) return;
              setBusy(true);
              try {
                const { backupCodes: codes } = await d.api.mfaRegenerateBackupCodes(c.trim());
                setBackupCodes(codes);
                setStage("showing-codes");
                await reload();
              } catch (e2) {
                setErr(e2 instanceof Error ? e2.message : "Code invalide.");
              } finally {
                setBusy(false);
              }
            }}
          >
            <RefreshCw size={14} /> Régénérer les codes de secours
          </button>
        </div>
      )}
    </div>
  );
}
