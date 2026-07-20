/**
 * Authentication screen — split hero (brand + value props) alongside the form.
 * Handles register / login / unlock, and, when opened from an invite link,
 * shows an invitation banner and defaults to account creation. Zero-knowledge:
 * the password is only used client-side to derive keys; it is never sent.
 */
import { useState } from "react";
import { Home, Cloud, Lock, LogIn, UserPlus, ShieldCheck, KeyRound, AlertTriangle, Users, Share2, MailCheck, Smartphone, Server } from "lucide-react";
import { useDrive } from "../session";
import { getConfiguredApiBase, setConfiguredApiBase } from "../api";

type Mode = "login" | "register";

export default function AuthPanel({ onHome }: { onHome: () => void }) {
  const d = useDrive();
  const [mode, setMode] = useState<Mode>(d.pendingInvite ? "register" : "login");
  const [serverOpen, setServerOpen] = useState(false);
  const [serverUrl, setServerUrl] = useState(getConfiguredApiBase());
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [mfaCode, setMfaCode] = useState("");

  const locked = d.status === "locked";
  const mfa = d.status === "mfa";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    d.clearError();
    try {
      if (mfa) await d.completeMfa(mfaCode);
      else if (locked) await d.unlock(password);
      else if (mode === "login") await d.login(email, password);
      else {
        if (password !== confirm) return;
        await d.register(email, password, displayName);
      }
    } catch {
      /* surfaced via d.error */
    }
  };

  return (
    <div className="dc-auth">
      <aside className="dc-auth__hero">
        <div className="dc-auth__hero-top">
          <span className="dc-auth__logo"><Cloud size={22} /> Elium Drive</span>
          <span className="dc-chip dc-chip--light">Entreprise</span>
        </div>
        <h1 className="dc-auth__headline">Le Drive chiffré <br />de votre entreprise.</h1>
        <p className="dc-auth__lede">Stockez, partagez et collaborez à plusieurs — chiffré de bout en bout, sur votre propre serveur.</p>
        <ul className="dc-auth__features">
          <li><ShieldCheck size={18} /> <span><b>Zéro-connaissance</b> — le serveur ne voit que du chiffré.</span></li>
          <li><Users size={18} /> <span><b>Rôles & permissions</b> détaillés et modifiables.</span></li>
          <li><Share2 size={18} /> <span><b>Partage granulaire</b> — par membre, groupe ou lien.</span></li>
        </ul>
        <div className="dc-auth__hero-foot">Argon2id · AES-256-GCM · ECDH-ES P-256 · Ed25519</div>
      </aside>

      <main className="dc-auth__panel">
        <div className="dc-auth__panel-top">
          <button className="eb eb--sm eb--ghost" onClick={onHome}><Home size={16} /> Accueil</button>
          <button className="eb eb--sm eb--ghost" onClick={() => setServerOpen((o) => !o)} title="Configurer le serveur Drive">
            <Server size={15} /> Serveur
          </button>
        </div>

        {serverOpen && (
          <div className="dc-auth__server">
            <p className="muted">
              Le Drive entreprise nécessite un serveur déployé (voir <code>deploy/</code>). Indiquez l'URL de l'API de
              votre serveur — l'application de bureau n'en embarque aucun.
            </p>
            <div className="dc-auth__server-row">
              <input
                className="input" value={serverUrl} onChange={(e) => setServerUrl(e.target.value)}
                placeholder="https://drive.mon-entreprise.fr/api" spellCheck={false}
              />
              <button
                className="eb eb--sm eb--primary"
                onClick={() => { setConfiguredApiBase(serverUrl); location.reload(); }}
              >
                Enregistrer
              </button>
            </div>
            <p className="muted dc-auth__server-cur">Actuel : <code>{getConfiguredApiBase()}</code></p>
          </div>
        )}

        <div className="dc-auth__card">
          {d.pendingInvite && !locked && (
            <div className="dc-auth__invite"><MailCheck size={18} /> <div><b>Vous êtes invité·e à rejoindre une équipe.</b><br />Créez votre compte ou connectez-vous pour la rejoindre.</div></div>
          )}

          {mfa ? (
            <>
              <h2 className="dc-auth__title"><Smartphone size={20} /> Vérification en deux étapes</h2>
              <p className="muted">Entrez le code à 6 chiffres de votre application d'authentification (ou un code de secours).</p>
              <form onSubmit={submit} className="dc-auth__form">
                <label className="field">
                  <span className="field__label">Code de vérification</span>
                  <input
                    className="input" value={mfaCode}
                    onChange={(e) => setMfaCode(e.target.value)}
                    inputMode="numeric" autoComplete="one-time-code" autoFocus required
                    placeholder="123456"
                  />
                </label>
                {d.error && <p className="dc-error">{d.error}</p>}
                <button className="eb eb--primary eb--block" disabled={d.busy || mfaCode.trim().length < 6}><ShieldCheck size={16} /> Vérifier</button>
                <button type="button" className="dc-auth__switch" onClick={() => { setMfaCode(""); d.cancelMfa(); }}>Annuler</button>
              </form>
            </>
          ) : locked ? (
            <>
              <h2 className="dc-auth__title"><Lock size={20} /> Session verrouillée</h2>
              <p className="muted">Entrez votre mot de passe pour déverrouiller vos clés localement.</p>
              <form onSubmit={submit} className="dc-auth__form">
                <label className="field"><span className="field__label">Compte</span><input className="input" value={d.lockedEmail ?? ""} readOnly /></label>
                <label className="field"><span className="field__label">Mot de passe</span><input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus required /></label>
                {d.error && <p className="dc-error">{d.error}</p>}
                <button className="eb eb--primary eb--block" disabled={d.busy}><KeyRound size={16} /> Déverrouiller</button>
                <button type="button" className="dc-auth__switch" onClick={() => void d.logout()}>Se connecter avec un autre compte</button>
              </form>
            </>
          ) : (
            <>
              <div className="dc-seg">
                <button className={mode === "login" ? "is-active" : ""} onClick={() => { setMode("login"); d.clearError(); }}><LogIn size={15} /> Connexion</button>
                <button className={mode === "register" ? "is-active" : ""} onClick={() => { setMode("register"); d.clearError(); }}><UserPlus size={15} /> Créer un compte</button>
              </div>
              <form onSubmit={submit} className="dc-auth__form">
                {mode === "register" && (
                  <label className="field"><span className="field__label">Nom affiché</span><input className="input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Prénom Nom" /></label>
                )}
                <label className="field"><span className="field__label">E-mail</span><input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="username" /></label>
                <label className="field"><span className="field__label">Mot de passe</span><input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} autoComplete={mode === "login" ? "current-password" : "new-password"} /></label>
                {mode === "register" && (
                  <>
                    <label className="field"><span className="field__label">Confirmer le mot de passe</span><input className="input" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required /></label>
                    {confirm && password !== confirm && <p className="dc-error">Les mots de passe ne correspondent pas.</p>}
                    <p className="dc-auth__warn"><AlertTriangle size={15} /> Chiffrement de bout en bout : votre mot de passe n'est jamais envoyé. Hors recouvrement d'organisation, un mot de passe perdu = données irrécupérables.</p>
                  </>
                )}
                {d.error && <p className="dc-error">{d.error}</p>}
                <button className="eb eb--primary eb--block" disabled={d.busy || (mode === "register" && password !== confirm)}>
                  {mode === "login" ? <><LogIn size={16} /> Se connecter</> : <><UserPlus size={16} /> Créer le compte</>}
                </button>
              </form>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
