import { useState } from "react";
import { KeyRound, Check } from "lucide-react";
import { useDrive } from "../session";
import { reportError } from "../../ui/crash-log";

/** Valide le formulaire (pur, testé) ; renvoie un message d'erreur FR ou null. */
export function validatePasswordChange(current: string, next: string, confirm: string): string | null {
  if (!current) return "Saisissez votre mot de passe actuel.";
  if (next.length < 8) return "Le nouveau mot de passe doit comporter au moins 8 caractères.";
  if (next === current) return "Le nouveau mot de passe doit différer de l'actuel.";
  if (next !== confirm) return "La confirmation ne correspond pas.";
  return null;
}

/**
 * Changer le mot de passe du compte (= la passphrase qui protège vos clés). Pour
 * un utilisateur SSO, c'est aussi ici qu'on définit la passphrase de ses clés,
 * indépendante de la connexion SSO. Les clés ne changent pas : seul leur
 * enveloppement l'est ; les autres sessions sont déconnectées.
 */
export default function ChangePasswordSection() {
  const d = useDrive();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const problem = validatePasswordChange(current, next, confirm);
    setDone(false);
    if (problem) return setErr(problem);
    setBusy(true);
    setErr(null);
    try {
      await d.changePassword(current, next);
      setCurrent("");
      setNext("");
      setConfirm("");
      setDone(true);
    } catch (e) {
      reportError("drive.changePassword", e);
      setErr(e instanceof Error ? e.message : "Changement impossible.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dc-security__pk" aria-labelledby="dc-chpw-title">
      <h3 id="dc-chpw-title" className="dc-security__pk-title">
        <KeyRound size={16} /> Mot de passe et clés
      </h3>
      <p className="muted">
        Changer le mot de passe ré-enveloppe vos clés privées sous la nouvelle passphrase (le serveur n'en voit rien).
        Vos autres sessions seront déconnectées ; le déverrouillage par clé d'accès devra être réactivé. En connexion
        SSO, c'est ici que vous définissez la passphrase de vos clés.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="dc-chpw"
      >
        <input
          type="password"
          autoComplete="current-password"
          placeholder="Mot de passe actuel"
          aria-label="Mot de passe actuel"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
        />
        <input
          type="password"
          autoComplete="new-password"
          placeholder="Nouveau mot de passe (8 caractères min.)"
          aria-label="Nouveau mot de passe"
          value={next}
          onChange={(e) => setNext(e.target.value)}
        />
        <input
          type="password"
          autoComplete="new-password"
          placeholder="Confirmer le nouveau mot de passe"
          aria-label="Confirmer le nouveau mot de passe"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
        <button type="submit" className="elx-mini elx-mini--primary" disabled={busy}>
          {busy ? "Changement…" : "Changer le mot de passe"}
        </button>
      </form>
      {err && (
        <p role="alert" className="dc-security__unlock-msg">
          {err}
        </p>
      )}
      {done && (
        <p role="status" className="dc-security__unlock-msg muted">
          <Check size={13} /> Mot de passe changé : vos clés sont ré-enveloppées.
        </p>
      )}
    </div>
  );
}
