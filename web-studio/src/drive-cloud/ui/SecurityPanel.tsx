/**
 * Security settings — two-factor authentication (TOTP) management. Enroll shows
 * a QR code (scanned by any authenticator app) plus the manual secret, then
 * confirms with a first code and reveals one-time backup codes. The TOTP secret
 * is a SECOND factor only: it never touches the zero-knowledge content keys.
 */
import { useCallback, useEffect, useState } from "react";
import {
  ShieldCheck,
  ShieldAlert,
  Smartphone,
  KeyRound,
  Copy,
  Check,
  RefreshCw,
  Fingerprint,
  Plus,
  Trash2,
  Unlock,
  LockKeyhole,
} from "lucide-react";
import { useDrive } from "../session";
import { prepareLogin, signLoginChallenge } from "../account";
import { makeQrDataUrl } from "../../sign/qr";
import type { MfaStatus } from "../types";

interface Passkey {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
}

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

  const [passkeys, setPasskeys] = useState<Passkey[]>([]);
  const [pkBusy, setPkBusy] = useState(false);
  const [unlockBusy, setUnlockBusy] = useState(false);
  const [unlockMsg, setUnlockMsg] = useState<string | null>(null);
  const [delBusy, setDelBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      setStatus(await d.api.mfaStatus());
    } catch {
      setStatus(null);
    }
    try {
      setPasskeys((await d.api.webauthnCredentials()).credentials);
    } catch {
      setPasskeys([]);
    }
  }, [d.api]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Enrôler une clé : cérémonie navigator.credentials.create pilotée par
  // @simplewebauthn/browser, puis vérification côté serveur.
  const addPasskey = async () => {
    setErr(null);
    setUnlockMsg(null);
    setPkBusy(true);
    try {
      const { startRegistration } = await import("@simplewebauthn/browser");
      const options = await d.api.webauthnRegisterOptions();
      const attestation = await startRegistration({ optionsJSON: options as never });
      const name = window.prompt("Nom de cette clé (ex. « iPhone », « YubiKey ») :", "Passkey") ?? "Passkey";
      const { ok } = await d.api.webauthnRegisterVerify(attestation, name.trim() || "Passkey");
      if (!ok) throw new Error("Enrôlement refusé.");
      await reload();
      // Propose immédiatement le déverrouillage local par cette clé (PRF), tant
      // que la clé fraîchement créée est référençable (attestation.id).
      if (
        !d.passkeyUnlockEnabled &&
        window.confirm(
          "Activer le déverrouillage de cette session par la clé d'accès ?\n\nVous pourrez déverrouiller vos données avec Touch ID / Windows Hello / votre clé, sans retaper votre mot de passe. Une vérification supplémentaire vous sera demandée maintenant.",
        )
      ) {
        try {
          const okPrf = await d.enrollPasskeyUnlock(attestation.id);
          setUnlockMsg(
            okPrf
              ? "Déverrouillage par clé d'accès activé sur cet appareil."
              : "Cette clé ne prend pas en charge le déverrouillage (extension PRF absente). La 2FA reste active.",
          );
        } catch (e2) {
          const nm = e2 instanceof Error ? e2.name : "";
          if (nm !== "NotAllowedError" && nm !== "AbortError") {
            setUnlockMsg("Activation du déverrouillage impossible.");
          }
        }
      }
    } catch (e) {
      // Cérémonie annulée par l'utilisateur, expirée, ou page sans focus : ce ne
      // sont pas de vraies erreurs. On filtre par NOM d'erreur (fiable), pas par
      // message : NotAllowedError couvre annulation/timeout/focus, AbortError
      // l'annulation programmatique.
      const name = e instanceof Error ? e.name : "";
      if (name !== "NotAllowedError" && name !== "AbortError") {
        setErr((e instanceof Error && e.message) || "Impossible d'ajouter la clé.");
      }
    } finally {
      setPkBusy(false);
    }
  };

  const removePasskey = async (id: string) => {
    setErr(null);
    setPkBusy(true);
    try {
      await d.api.webauthnRemoveCredential(id);
      await reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Suppression impossible.");
    } finally {
      setPkBusy(false);
    }
  };

  // Active le déverrouillage local. S'il n'existe encore AUCUNE clé, on en
  // enrôle une d'abord (côté serveur), puis on active le déverrouillage sur
  // elle — le tout en un seul geste. Sinon, on active sur une clé découvrable.
  const enableUnlock = async () => {
    setErr(null);
    setUnlockMsg(null);
    setUnlockBusy(true);
    try {
      let credentialId: string | null = null;
      if (passkeys.length === 0) {
        const { startRegistration } = await import("@simplewebauthn/browser");
        const options = await d.api.webauthnRegisterOptions();
        const attestation = await startRegistration({ optionsJSON: options as never });
        const { ok } = await d.api.webauthnRegisterVerify(attestation, "Cet appareil");
        if (!ok) throw new Error("Enrôlement de la clé refusé.");
        credentialId = attestation.id;
        await reload();
      }
      const ok = await d.enrollPasskeyUnlock(credentialId);
      setUnlockMsg(
        ok
          ? "Déverrouillage par clé d'accès activé sur cet appareil."
          : "Cette clé ne prend pas en charge le déverrouillage (extension PRF absente). La 2FA reste active.",
      );
    } catch (e) {
      // Annulation / timeout / page sans focus : pas une vraie erreur.
      const nm = e instanceof Error ? e.name : "";
      if (nm !== "NotAllowedError" && nm !== "AbortError") setUnlockMsg("Activation impossible.");
    } finally {
      setUnlockBusy(false);
    }
  };

  const disableUnlock = () => {
    d.disablePasskeyUnlock();
    setUnlockMsg("Déverrouillage par clé d'accès désactivé sur cet appareil.");
  };

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

  const deleteAccount = async () => {
    setErr(null);
    let pre: Awaited<ReturnType<typeof d.api.deletionPreflight>>;
    try {
      pre = await d.api.deletionPreflight();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Vérification préalable impossible.");
      return;
    }
    if (!pre.canDelete) {
      const parts: string[] = [];
      if (pre.ownedOrgsWithMembers.length)
        parts.push(`transférez d'abord la propriété de : ${pre.ownedOrgsWithMembers.map((o) => o.name).join(", ")}`);
      if (pre.soleRecoveryAdminOrgs.length)
        parts.push(
          `promouvez un autre administrateur de recouvrement pour : ${pre.soleRecoveryAdminOrgs.map((o) => o.name).join(", ")}`,
        );
      setErr(`Suppression impossible — ${parts.join(" ; ")}.`);
      return;
    }
    const email = d.user?.email ?? "";
    const pwd = window.prompt(
      `SUPPRESSION DÉFINITIVE du compte ${email}.\nVos données personnelles et vos clés seront effacées ; cette action est IRRÉVERSIBLE.\n\nSaisissez votre mot de passe pour confirmer :`,
    );
    if (!pwd) return;
    setDelBusy(true);
    try {
      const p = await d.api.prelogin(email);
      const { authSignSeedHex } = await prepareLogin(pwd, p.kdfSalt, p.kdfParams);
      const proof = await signLoginChallenge(`elium:delete-account:${email.toLowerCase()}`, authSignSeedHex);
      await d.api.deleteMyAccount(proof);
      window.alert("Votre compte a été supprimé.");
      await d.logout();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Échec de la suppression (mot de passe incorrect ?).");
    } finally {
      setDelBusy(false);
    }
  };

  return (
    <div className="dc-security">
      <div className="dc-security__status">
        {enabled ? (
          <span className="badge badge--success">
            <ShieldCheck size={15} /> 2FA activée
          </span>
        ) : (
          <span className="badge badge--neutral">
            <ShieldAlert size={15} /> 2FA désactivée
          </span>
        )}
        {enabled && status && (
          <span className="muted">{status.backupCodesRemaining} code(s) de secours restant(s)</span>
        )}
      </div>

      <p className="muted dc-security__lede">
        La vérification en deux étapes (TOTP) ajoute un second facteur au mot de passe : un code à usage unique généré
        par votre application d'authentification. Ce facteur est indépendant du chiffrement de bout en bout — il protège
        l'accès au compte.
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
            <li>
              Ou saisissez la clé manuellement : <code className="dc-security__secret">{secret}</code>
            </li>
            <li>Entrez le code à 6 chiffres affiché pour confirmer.</li>
          </ol>
          {qr && <img className="dc-security__qr" src={qr} alt="QR code d'enrôlement 2FA" width={200} height={200} />}
          <form onSubmit={confirmEnroll} className="dc-security__confirm">
            <input
              className="input"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              inputMode="numeric"
              placeholder="123456"
              autoFocus
            />
            <button className="eb eb--primary" disabled={busy || code.trim().length < 6}>
              <Check size={15} /> Confirmer
            </button>
            <button
              type="button"
              className="eb eb--ghost"
              onClick={() => {
                setStage("idle");
                setErr(null);
              }}
            >
              Annuler
            </button>
          </form>
        </div>
      )}

      {/* --- Just enabled: reveal backup codes ONCE --- */}
      {stage === "showing-codes" && (
        <div className="dc-security__codes">
          <h3 className="dc-security__codes-title">
            <KeyRound size={16} /> Vos codes de secours
          </h3>
          <p className="muted">
            Conservez-les en lieu sûr. Chacun ne sert qu'une fois et remplace le code de l'application si vous perdez
            votre téléphone. Ils ne seront plus affichés.
          </p>
          <ul className="dc-security__codelist">
            {backupCodes.map((c) => (
              <li key={c}>
                <code>{c}</code>
              </li>
            ))}
          </ul>
          <div className="dc-security__codes-actions">
            <button className="eb eb--outline eb--sm" onClick={copyCodes}>
              {copied ? (
                <>
                  <Check size={14} /> Copié
                </>
              ) : (
                <>
                  <Copy size={14} /> Copier
                </>
              )}
            </button>
            <button className="eb eb--primary eb--sm" onClick={() => setStage("idle")}>
              J'ai sauvegardé mes codes
            </button>
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
                <input
                  className="input"
                  value={disableCode}
                  onChange={(e) => setDisableCode(e.target.value)}
                  inputMode="numeric"
                  placeholder="123456 ou code de secours"
                />
                <button className="eb eb--danger eb--sm" disabled={busy || disableCode.trim().length < 4}>
                  Désactiver
                </button>
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

      {/* --- Passkeys (WebAuthn) : second facteur matériel/biométrique --- */}
      <div className="dc-security__passkeys">
        <div className="dc-security__pk-head">
          <h3 className="dc-security__pk-title">
            <Fingerprint size={16} /> Clés de sécurité (passkeys)
          </h3>
          <button className="eb eb--outline eb--sm" disabled={pkBusy} onClick={() => void addPasskey()}>
            <Plus size={14} /> Ajouter une clé
          </button>
        </div>
        <p className="muted">
          Une passkey (Touch ID / Windows Hello / clé USB) sert de second facteur, alternatif au code. Elle peut aussi,
          en option, <b>déverrouiller localement</b> vos données (ci-dessous) via l'extension PRF — un secret propre à
          l'appareil, jamais transmis au serveur.
        </p>
        {passkeys.length === 0 ? (
          <p className="muted dc-security__pk-empty">Aucune clé enregistrée.</p>
        ) : (
          <ul className="dc-security__pk-list">
            {passkeys.map((p) => (
              <li key={p.id} className="dc-security__pk-item">
                <KeyRound size={15} />
                <span className="dc-security__pk-name">{p.name || "Passkey"}</span>
                <span className="muted dc-security__pk-date">
                  {p.lastUsedAt
                    ? `utilisée le ${new Date(p.lastUsedAt).toLocaleDateString("fr")}`
                    : `ajoutée le ${new Date(p.createdAt).toLocaleDateString("fr")}`}
                </span>
                <button
                  className="icon-btn icon-btn--danger"
                  title="Supprimer"
                  disabled={pkBusy}
                  onClick={() => void removePasskey(p.id)}
                >
                  <Trash2 size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}

        {/* --- Déverrouillage par clé d'accès (PRF) : ouvre les données sans mot de passe --- */}
        <div className="dc-security__unlock">
          <div className="dc-security__unlock-main">
            <span className={`dc-security__unlock-ic${d.passkeyUnlockEnabled ? " is-on" : ""}`}>
              {d.passkeyUnlockEnabled ? <Unlock size={16} /> : <LockKeyhole size={16} />}
            </span>
            <div className="dc-security__unlock-txt">
              <span className="dc-security__unlock-title">
                Déverrouillage par clé d'accès
                {d.passkeyUnlockEnabled && (
                  <span className="badge badge--success dc-security__unlock-badge">
                    <Check size={12} /> Activé
                  </span>
                )}
              </span>
              <span className="muted">
                Ouvrez vos données chiffrées avec votre empreinte, votre visage ou votre clé — sans retaper votre mot de
                passe. Le secret ne quitte jamais cet appareil ; le serveur n'en voit rien.
              </span>
            </div>
          </div>
          <div className="dc-security__unlock-actions">
            {d.passkeyUnlockEnabled ? (
              <button className="eb eb--ghost eb--sm" onClick={disableUnlock}>
                Désactiver
              </button>
            ) : (
              <button className="eb eb--primary eb--sm" disabled={unlockBusy} onClick={() => void enableUnlock()}>
                <Unlock size={14} /> {passkeys.length === 0 ? "Configurer" : "Activer"}
              </button>
            )}
          </div>
        </div>
        {unlockMsg && <p className="dc-security__unlock-msg muted">{unlockMsg}</p>}
      </div>

      {/* --- Zone de danger : suppression du compte (RGPD) --- */}
      <div className="dc-security__danger">
        <h3 className="dc-security__pk-title">
          <ShieldAlert size={16} /> Zone de danger
        </h3>
        <p className="muted">
          Supprimer définitivement votre compte efface vos données personnelles et vos clés (droit à l'effacement,
          RGPD). Les fichiers dont vous êtes propriétaire dans une organisation sont transférés à son propriétaire ; une
          organisation dont vous êtes le seul membre est supprimée. Cette action est irréversible.
        </p>
        <button className="eb eb--danger eb--sm" disabled={delBusy} onClick={() => void deleteAccount()}>
          <Trash2 size={14} /> Supprimer mon compte
        </button>
      </div>
    </div>
  );
}
