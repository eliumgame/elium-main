/**
 * Page ouverte depuis le lien de réinitialisation envoyé par le propriétaire
 * (`?reset=…`). L'utilisateur choisit un nouveau mot de passe ; ses clés sont
 * régénérées dans le navigateur (le serveur ne voit jamais le mot de passe).
 */
import { useEffect, useState } from "react";
import { Cloud, KeyRound, AlertTriangle, CheckCircle2 } from "lucide-react";
import "../drive-cloud.css";
import { useDrive } from "../session";
import { buildRegistration } from "../account";

export function resetTokenFromSearch(search: string): string | null {
  try {
    return new URLSearchParams(search).get("reset");
  } catch {
    return null;
  }
}

export default function ResetPasswordPage({ token }: { token: string }) {
  const d = useDrive();
  const minLen = d.policy?.passwordMinLength ?? 8;
  const [info, setInfo] = useState<{ email: string; displayName: string } | null>(null);
  const [invalid, setInvalid] = useState<string | null>(null);
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    d.api
      .resetInfo(token)
      .then(setInfo)
      .catch((e) => setInvalid(e instanceof Error ? e.message : "Lien invalide."));
  }, [d.api, token]);

  const toLogin = () => {
    window.location.assign(window.location.pathname);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!info) return;
    if (pw.length < minLen) return setErr(`Le mot de passe doit comporter au moins ${minLen} caractères.`);
    if (pw !== confirm) return setErr("Les mots de passe ne correspondent pas.");
    setBusy(true);
    setErr(null);
    try {
      const { payload } = await buildRegistration(info.email, pw, info.displayName);
      await d.api.resetComplete(token, payload);
      // Une session verrouillée de CE compte (anciennes clés) n'a plus de sens : on l'oublie.
      if ((d.lockedEmail ?? d.user?.email ?? "").toLowerCase() === info.email.toLowerCase()) await d.logout();
      setDone(true);
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Réinitialisation impossible.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dc-gate" data-testid="reset-page">
      <div className="dc-gate__card">
        <h1 className="dc-gate__title">
          <Cloud size={22} /> {d.policy?.siteName || "Elium Drive"} — nouveau mot de passe
        </h1>
        {invalid ? (
          <>
            <p className="dc-error" data-testid="reset-invalid">
              <AlertTriangle size={15} /> {invalid}
            </p>
            <p className="muted">Demandez un nouveau lien au propriétaire du Drive.</p>
            <button className="eb eb--primary" onClick={toLogin}>
              Retour à la connexion
            </button>
          </>
        ) : done ? (
          <>
            <p data-testid="reset-done">
              <CheckCircle2 size={16} /> Mot de passe changé. Connectez-vous avec votre nouveau mot de passe.
            </p>
            <p className="muted">
              Vos anciens fichiers privés redeviennent lisibles quand le propriétaire du Drive a rétabli vos accès.
            </p>
            <button className="eb eb--primary" onClick={toLogin}>
              Se connecter
            </button>
          </>
        ) : !info ? (
          <p className="muted">Vérification du lien…</p>
        ) : (
          <form className="dc-auth__form" onSubmit={submit}>
            <p>
              Compte : <b>{info.email}</b>
            </p>
            <p className="dc-auth__warn">
              <AlertTriangle size={15} /> Chiffrement de bout en bout : un nouveau jeu de clés est créé. Vos anciens
              fichiers privés ne seront lisibles qu'après rétablissement de vos accès par le propriétaire du Drive.
            </p>
            <label className="field">
              <span className="field__label">Nouveau mot de passe</span>
              <input
                className="input"
                type="password"
                value={pw}
                onChange={(e) => setPw(e.target.value)}
                autoComplete="new-password"
                required
                minLength={minLen}
                data-testid="reset-pw"
              />
            </label>
            <label className="field">
              <span className="field__label">Confirmer</span>
              <input
                className="input"
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
                required
                data-testid="reset-pw2"
              />
            </label>
            {err && <p className="dc-error">{err}</p>}
            <button className="eb eb--primary eb--block" disabled={busy} data-testid="reset-submit">
              <KeyRound size={16} /> {busy ? "Création des clés…" : "Changer le mot de passe"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
