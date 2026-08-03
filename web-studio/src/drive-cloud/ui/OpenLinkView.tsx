/**
 * Public share-link opener. Anonymous, no account: it resolves the link, and
 * decrypts the file using the secret carried in the URL fragment (`#k=priv.pub`)
 * — which the server never receives. Zero-knowledge sharing to the outside.
 */
import { useCallback, useEffect, useState } from "react";
import { Cloud, Download, FileLock2, AlertTriangle, Loader, Lock } from "lucide-react";
import "../drive-cloud.css";
import { DriveApi } from "../api";
import { openSharedLink, triggerDownload } from "../ops";

type State =
  | { phase: "loading" }
  | { phase: "password"; pub: string; blob: string } // lien protégé : mot de passe requis
  | { phase: "error"; message: string }
  | { phase: "ready"; name: string; kind: "folder" | "file"; hasContent: boolean; download: () => Promise<{ bytes: Uint8Array; name: string }> };

export default function OpenLinkView({ token, onHome }: { token: string; onHome: () => void }) {
  const [state, setState] = useState<State>({ phase: "loading" });
  const [downloading, setDownloading] = useState(false);
  const [pwd, setPwd] = useState("");
  const [pwdErr, setPwdErr] = useState<string | null>(null);
  const [unlocking, setUnlocking] = useState(false);

  // Résout le lien à partir du scalaire privé (déjà en clair, ou déchiffré du
  // mot de passe) + la clé publique.
  const resolve = useCallback(async (priv: string, pub: string) => {
    const api = new DriveApi();
    const res = await openSharedLink(api, token, priv, pub);
    setState({ phase: "ready", name: res.name, kind: res.kind, hasContent: res.hasContent, download: res.download });
  }, [token]);

  useEffect(() => {
    (async () => {
      try {
        const params = new URLSearchParams(location.hash.replace(/^#/, ""));
        const enc = params.get("e");
        if (enc) {
          // Lien protégé par mot de passe : `e=<pub>.<salt>.<iv>.<ct>`.
          const [pub, ...rest] = enc.split(".");
          if (!pub || rest.length < 3) throw new Error("Lien incomplet.");
          setState({ phase: "password", pub, blob: rest.join(".") });
          return;
        }
        const [priv, pub] = (params.get("k") ?? "").split(".");
        if (!priv || !pub) throw new Error("Lien incomplet : secret de déchiffrement manquant.");
        await resolve(priv, pub);
      } catch (e) {
        setState({ phase: "error", message: e instanceof Error ? e.message : "Lien introuvable, révoqué ou expiré." });
      }
    })();
  }, [token, resolve]);

  const submitPassword = async () => {
    if (state.phase !== "password" || !pwd) return;
    setUnlocking(true);
    setPwdErr(null);
    try {
      const { unprotectLinkSecret } = await import("../link-password");
      const priv = await unprotectLinkSecret(pwd, state.blob);
      await resolve(priv, state.pub);
    } catch {
      // AES-GCM rejette → mot de passe faux (ou lien révoqué/expiré côté serveur).
      setPwdErr("Mot de passe incorrect.");
    } finally {
      setUnlocking(false);
    }
  };

  const doDownload = async () => {
    if (state.phase !== "ready") return;
    setDownloading(true);
    try {
      const { bytes, name } = await state.download();
      triggerDownload(bytes, name);
    } catch {
      setState({ phase: "error", message: "Téléchargement impossible." });
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="dc-link-open">
      <div className="dc-link-card">
        <div className="dc-auth__brand-row"><Cloud size={26} /> <span>Elium Drive</span></div>
        {state.phase === "loading" && <p className="muted"><Loader size={16} className="dc-spin" /> Ouverture du lien chiffré…</p>}
        {state.phase === "password" && (
          <>
            <div className="dc-link-icon"><Lock size={30} /></div>
            <h1>Lien protégé</h1>
            <p className="muted">Ce lien est protégé par un mot de passe. Saisissez-le pour déchiffrer le fichier (le mot de passe ne quitte jamais votre navigateur).</p>
            <form onSubmit={(e) => { e.preventDefault(); void submitPassword(); }} className="dc-auth__form">
              <input className="input" type="password" value={pwd} onChange={(e) => setPwd(e.target.value)} placeholder="Mot de passe" autoFocus />
              {pwdErr && <p className="dc-error">{pwdErr}</p>}
              <button className="eb eb--primary eb--block" disabled={unlocking || !pwd}>{unlocking ? "Déverrouillage…" : "Déverrouiller"}</button>
            </form>
          </>
        )}
        {state.phase === "error" && (
          <>
            <div className="dc-link-icon dc-link-icon--err"><AlertTriangle size={30} /></div>
            <h1>Lien indisponible</h1>
            <p className="muted">{state.message}</p>
          </>
        )}
        {state.phase === "ready" && (
          <>
            <div className="dc-link-icon"><FileLock2 size={30} /></div>
            <h1>{state.name}</h1>
            <p className="muted">Fichier partagé, chiffré de bout en bout. Le secret de déchiffrement n'a jamais quitté votre navigateur.</p>
            {state.kind === "file" && state.hasContent ? (
              <button className="eb eb--primary eb--block" disabled={downloading} onClick={() => void doDownload()}>
                <Download size={16} /> {downloading ? "Déchiffrement…" : "Télécharger"}
              </button>
            ) : (
              <p className="muted">Ce lien pointe vers un dossier.</p>
            )}
          </>
        )}
        <button className="dc-auth__switch" onClick={onHome}>Ouvrir Elium</button>
      </div>
    </div>
  );
}
