/**
 * Signature à distance — vue DESTINATAIRE (Approche A). Anonyme, sans compte :
 * elle résout le lien, déchiffre le `.elium` avec le secret du fragment d'URL
 * (`#k=priv.pub`, jamais envoyé au serveur), le fait signer avec une identité
 * Ed25519 générée à la volée, re-chiffre l'artefact signé sous la MÊME clé de
 * nœud et le renvoie par la route publique scellée par token. Zero-knowledge.
 */
import { useEffect, useState } from "react";
import { Cloud, PenLine, ShieldCheck, AlertTriangle, Loader, CheckCircle2 } from "lucide-react";
import "../drive-cloud.css";
import { DriveApi } from "../api";
import { openSignLink, submitSignedElium } from "../ops";
import { readEliumPackage, writeEliumPackage, EliumPasswordRequired } from "../../format/elium-package";
import { addSignature, extractText } from "../../format/document";
import { createProof } from "../../sign/proof";
import { generateIdentity, fingerprintOf } from "../../sign/keys";
import { randomId } from "../../format/canonical";
import { fingerprintWords } from "../../sign/safety-words";
import type { EliumFile, EliumSignature } from "../../format/types";

type State =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; title: string; preview: string; file: EliumFile; nodeKey: Uint8Array }
  | { phase: "signing" }
  | { phase: "done"; title: string; words: string };

export default function SignLinkView({ token, onHome }: { token: string; onHome: () => void }) {
  const [state, setState] = useState<State>({ phase: "loading" });
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const params = new URLSearchParams(location.hash.replace(/^#/, ""));
        const [priv, pub] = (params.get("k") ?? "").split(".");
        if (!priv || !pub) throw new Error("Lien incomplet : secret de déchiffrement manquant.");
        const api = new DriveApi();
        const opened = await openSignLink(api, token, priv, pub);
        if (opened.kind !== "file" || !opened.hasContent) throw new Error("Ce lien ne pointe pas vers un document signable.");
        let file: EliumFile;
        try {
          ({ file } = await readEliumPackage(opened.bytes, {}));
        } catch (e) {
          if (e instanceof EliumPasswordRequired) {
            throw new Error("Ce document est protégé par un mot de passe : la signature en ligne ne le prend pas encore en charge.");
          }
          throw new Error("Document illisible (format .elium attendu).");
        }
        const preview = extractText(file.document.doc).trim().slice(0, 600);
        setState({ phase: "ready", title: file.manifest.title || opened.name || "Document", preview, file, nodeKey: opened.nodeKey });
      } catch (e) {
        setState({ phase: "error", message: e instanceof Error ? e.message : "Lien introuvable, révoqué ou expiré." });
      }
    })();
  }, [token]);

  const sign = async () => {
    if (state.phase !== "ready") return;
    if (!name.trim()) { setErr("Indiquez votre nom."); return; }
    setErr(null);
    const { file, nodeKey, title } = state;
    setState({ phase: "signing" });
    try {
      // Identité Ed25519 générée à la volée — aucune inscription requise.
      const id = await generateIdentity();
      const sigId = randomId("sig");
      const signer = { name: name.trim(), role: role.trim() || undefined };
      const placement: EliumSignature["placement"] = {
        page: 1, xPct: 0.34, yPct: 0.78, wPct: 0.3, hPct: 0.12, rotation: 0, z: file.signatures.length, anchorType: "page",
      };
      const visual = { text: name.trim(), subText: role.trim() || undefined };
      // Preuve Ed25519 liant le corps + le placement + le visuel (comme signAsParty).
      const proof = await createProof({ signatureId: sigId, model: file.document, signer, privateKeyHex: id.privateKeyHex!, placement, visual });
      const sig: EliumSignature = { id: sigId, kind: "typed", visual, placement, signer, proof, level: "advanced", createdAt: new Date().toISOString() };
      const nf = await addSignature(file, sig);
      // Re-scellé avec l'identité du signataire (le sceau couvre la nouvelle signature).
      const signedBytes = await writeEliumPackage(nf, { sealPrivateKeyHex: id.privateKeyHex! });
      const fpr = await fingerprintOf(id.publicKeyHex);
      const api = new DriveApi();
      await submitSignedElium(api, token, nodeKey, signedBytes, fpr);
      setState({ phase: "done", title, words: fingerprintWords(fpr) });
    } catch (e) {
      setState({ phase: "ready", title, preview: state.preview, file, nodeKey });
      setErr(e instanceof Error ? e.message : "Échec de l'envoi de la signature.");
    }
  };

  return (
    <div className="dc-link-open">
      <div className="dc-link-card">
        <div className="dc-auth__brand-row"><Cloud size={26} /> <span>Elium — Signature</span></div>

        {state.phase === "loading" && (
          <p className="muted"><Loader size={16} className="dc-spin" /> Ouverture du document à signer…</p>
        )}

        {state.phase === "error" && (
          <>
            <div className="dc-link-icon dc-link-icon--err"><AlertTriangle size={30} /></div>
            <h1>Demande indisponible</h1>
            <p className="muted">{state.message}</p>
          </>
        )}

        {(state.phase === "ready" || state.phase === "signing") && (
          <>
            <div className="dc-link-icon"><PenLine size={30} /></div>
            <h1>{state.phase === "ready" ? state.title : "Signature en cours…"}</h1>
            <p className="muted">On vous demande de signer ce document. Il est déchiffré uniquement dans votre navigateur ; aucun compte n'est requis.</p>
            {state.phase === "ready" && state.preview && (
              <pre className="dc-sign-preview">{state.preview}{state.preview.length >= 600 ? "…" : ""}</pre>
            )}
            <form onSubmit={(e) => { e.preventDefault(); void sign(); }} className="dc-auth__form">
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Votre nom" autoFocus disabled={state.phase === "signing"} />
              <input className="input" value={role} onChange={(e) => setRole(e.target.value)} placeholder="Fonction (optionnel)" disabled={state.phase === "signing"} />
              {err && <p className="dc-error">{err}</p>}
              <button className="eb eb--primary eb--block" disabled={state.phase === "signing" || !name.trim()}>
                {state.phase === "signing" ? "Signature…" : (<><ShieldCheck size={16} /> Signer et renvoyer</>)}
              </button>
            </form>
            <p className="muted" style={{ fontSize: 12 }}>Votre signature est une preuve cryptographique (Ed25519) intégrée au document ; l'émetteur pourra la vérifier.</p>
          </>
        )}

        {state.phase === "done" && (
          <>
            <div className="dc-link-icon"><CheckCircle2 size={30} /></div>
            <h1>Document signé</h1>
            <p className="muted">« {state.title} » a été signé et renvoyé à l'émetteur. Vous pouvez fermer cette page.</p>
            <p className="muted" style={{ fontSize: 12 }}>Mots de vérification de votre clé : <strong>{state.words}</strong> — communiquez-les à l'émetteur par un canal de confiance s'il souhaite attribuer votre signature.</p>
          </>
        )}

        <button className="dc-auth__switch" onClick={onHome}>Ouvrir Elium</button>
      </div>
    </div>
  );
}
