/**
 * Public share-link opener. Anonymous, no account: it resolves the link, and
 * decrypts the file using the secret carried in the URL fragment (`#k=priv.pub`)
 * — which the server never receives. Zero-knowledge sharing to the outside.
 */
import { useEffect, useState } from "react";
import { Cloud, Download, FileLock2, AlertTriangle, Loader } from "lucide-react";
import "../drive-cloud.css";
import { DriveApi } from "../api";
import { openSharedLink, triggerDownload } from "../ops";

type State =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; name: string; kind: "folder" | "file"; hasContent: boolean; download: () => Promise<{ bytes: Uint8Array; name: string }> };

export default function OpenLinkView({ token, onHome }: { token: string; onHome: () => void }) {
  const [state, setState] = useState<State>({ phase: "loading" });
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const params = new URLSearchParams(location.hash.replace(/^#/, ""));
        const [priv, pub] = (params.get("k") ?? "").split(".");
        if (!priv || !pub) throw new Error("Lien incomplet : secret de déchiffrement manquant.");
        const api = new DriveApi();
        const res = await openSharedLink(api, token, priv, pub);
        setState({ phase: "ready", name: res.name, kind: res.kind, hasContent: res.hasContent, download: res.download });
      } catch (e) {
        setState({ phase: "error", message: e instanceof Error ? e.message : "Lien introuvable, révoqué ou expiré." });
      }
    })();
  }, [token]);

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
