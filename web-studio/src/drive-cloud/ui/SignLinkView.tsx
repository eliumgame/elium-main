/**
 * Signature à distance — vue DESTINATAIRE (Approche A). Anonyme, sans compte :
 * résout le lien, déchiffre le document avec le secret du fragment d'URL
 * (`#k=priv.pub`, jamais envoyé au serveur), le fait signer, re-chiffre l'artefact
 * signé sous la MÊME clé de nœud et le renvoie par la route publique scellée par
 * token. Prend en charge les `.elium` (preuve Ed25519) ET les PDF (PAdES,
 * certificat auto-signé). Le signataire peut aussi refuser.
 */
import { useEffect, useMemo, useState } from "react";
import { Cloud, PenLine, ShieldCheck, AlertTriangle, Loader, CheckCircle2, FileText, XCircle } from "lucide-react";
import "../drive-cloud.css";
import { DriveApi } from "../api";
import { openSignLink, submitSignedElium } from "../ops";
import { readEliumPackage, writeEliumPackage, EliumPasswordRequired } from "../../format/elium-package";
import { addSignature, extractText } from "../../format/document";
import { createProof } from "../../sign/proof";
import { generateIdentity, fingerprintOf } from "../../sign/keys";
import { randomId, toHex } from "../../format/canonical";
import { fingerprintWords } from "../../sign/safety-words";
import type { EliumFile, EliumSignature } from "../../format/types";
// Import PURS depuis le module PDF existant (aucun fichier sous src/pdf/ n'est
// modifié) : même rendu de « signature tapée » que l'outil Signature de
// l'espace de travail local (pdf/ops/sign.ts), et le même type de rectangle en
// espace page (pdf/core/coords.ts) que celui attendu par `visible` de PAdES.
import { typedSignatureToPng, SIGNATURE_FONTS } from "../../pdf/ops/sign";
import type { Rect } from "../../pdf/core/coords";
import type { PadesSignOptions } from "../../pdf/ops/pades";
import { SignPlacementPreview } from "./SignPlacementPreview";

/** Couleur d'encre par défaut de l'outil Signature local (pdf/ui/dialogs.tsx). */
const SIGNATURE_COLOUR = "#0f172a";

/** data:image/png;base64,... → octets bruts (même décodage que PdfWorkspace.visibleSigTarget). */
function pngDataUrlToBytes(dataUrl: string): Uint8Array | undefined {
  const m = /^data:image\/png;base64,(.+)$/.exec(dataUrl);
  if (!m) return undefined;
  return Uint8Array.from(atob(m[1]!), (c) => c.charCodeAt(0));
}

type Ready =
  | { docType: "elium"; title: string; preview: string; file: EliumFile; nodeKey: Uint8Array }
  | { docType: "pdf"; title: string; bytes: Uint8Array; nodeKey: Uint8Array };

type State =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; doc: Ready }
  | { phase: "busy"; label: string }
  | { phase: "done"; title: string; words?: string }
  | { phase: "declined"; title: string };

function isPdf(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46; // %PDF
}

export default function SignLinkView({ token, onHome }: { token: string; onHome: () => void }) {
  const [state, setState] = useState<State>({ phase: "loading" });
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [err, setErr] = useState<string | null>(null);
  // Placement VISIBLE de la signature (PDF uniquement) — optionnel : sans choix,
  // on retombe sur la signature invisible historique (voir `sign()` ci-dessous).
  const [wantsPlacement, setWantsPlacement] = useState(false);
  const [placement, setPlacement] = useState<Rect | null>(null);
  // Aperçu de la marque manuscrite (texte tapé → PNG), même rendu que l'outil
  // Signature local ; un nom de repli tient l'aperçu à jour avant même que le
  // signataire ait rempli son nom.
  const mark = useMemo(
    () => typedSignatureToPng(name.trim() || "Votre signature", SIGNATURE_FONTS[0].css, SIGNATURE_COLOUR),
    [name],
  );

  useEffect(() => {
    (async () => {
      try {
        const params = new URLSearchParams(location.hash.replace(/^#/, ""));
        const [priv, pub] = (params.get("k") ?? "").split(".");
        if (!priv || !pub) throw new Error("Lien incomplet : secret de déchiffrement manquant.");
        const api = new DriveApi();
        const opened = await openSignLink(api, token, priv, pub);
        if (opened.kind !== "file" || !opened.hasContent)
          throw new Error("Ce lien ne pointe pas vers un document signable.");
        if (isPdf(opened.bytes)) {
          setState({
            phase: "ready",
            doc: { docType: "pdf", title: opened.name || "Document PDF", bytes: opened.bytes, nodeKey: opened.nodeKey },
          });
          return;
        }
        let file: EliumFile;
        try {
          ({ file } = await readEliumPackage(opened.bytes, {}));
        } catch (e) {
          if (e instanceof EliumPasswordRequired) {
            throw new Error(
              "Ce document est protégé par un mot de passe : la signature en ligne ne le prend pas encore en charge.",
            );
          }
          throw new Error("Document illisible (format .elium ou PDF attendu).");
        }
        const preview = extractText(file.document.doc).trim().slice(0, 600);
        setState({
          phase: "ready",
          doc: {
            docType: "elium",
            title: file.manifest.title || opened.name || "Document",
            preview,
            file,
            nodeKey: opened.nodeKey,
          },
        });
      } catch (e) {
        setState({ phase: "error", message: e instanceof Error ? e.message : "Lien introuvable, révoqué ou expiré." });
      }
    })();
  }, [token]);

  const sign = async () => {
    if (state.phase !== "ready") return;
    if (!name.trim()) {
      setErr("Indiquez votre nom.");
      return;
    }
    setErr(null);
    const doc = state.doc;
    setState({ phase: "busy", label: "Signature…" });
    try {
      const api = new DriveApi();
      if (doc.docType === "elium") {
        // Identité Ed25519 à la volée — aucune inscription requise.
        const id = await generateIdentity();
        const sigId = randomId("sig");
        const signer = { name: name.trim(), role: role.trim() || undefined };
        const placement: EliumSignature["placement"] = {
          page: 1,
          xPct: 0.34,
          yPct: 0.78,
          wPct: 0.3,
          hPct: 0.12,
          rotation: 0,
          z: doc.file.signatures.length,
          anchorType: "page",
        };
        const visual = { text: name.trim(), subText: role.trim() || undefined };
        const proof = await createProof({
          signatureId: sigId,
          model: doc.file.document,
          signer,
          privateKeyHex: id.privateKeyHex!,
          placement,
          visual,
        });
        const sig: EliumSignature = {
          id: sigId,
          kind: "typed",
          visual,
          placement,
          signer,
          proof,
          level: "advanced",
          createdAt: new Date().toISOString(),
        };
        const nf = await addSignature(doc.file, sig);
        const signedBytes = await writeEliumPackage(nf, { sealPrivateKeyHex: id.privateKeyHex! });
        const fpr = await fingerprintOf(id.publicKeyHex);
        await submitSignedElium(api, token, doc.nodeKey, signedBytes, fpr);
        setState({ phase: "done", title: doc.title, words: fingerprintWords(fpr) });
      } else {
        // PDF → PAdES avec un certificat auto-signé généré à la volée (RSA-2048,
        // ~1–3 s, synchrone). Par défaut la signature reste invisible mais valide
        // (Adobe : « identité non vérifiée » car auto-signé) ; si le signataire a
        // choisi un emplacement sur l'aperçu de la page 1, elle devient VISIBLE à
        // cet endroit avec son nom tapé comme apparence (même mécanisme que
        // l'espace de travail local, `PdfWorkspace.signSelfSigned`).
        const { generateSelfSignedP12 } = await import("../../pdf/ops/self-cert");
        const { signPdfBytes } = await import("../../pdf/ops/pades");
        const pw = toHex(crypto.getRandomValues(new Uint8Array(16)));
        const p12 = generateSelfSignedP12(name.trim(), pw);
        let visible: PadesSignOptions["visible"];
        if (wantsPlacement && placement) {
          const finalMark = typedSignatureToPng(name.trim() || "Signature", SIGNATURE_FONTS[0].css, SIGNATURE_COLOUR);
          const imagePng = finalMark ? pngDataUrlToBytes(finalMark.src) : undefined;
          visible = { page: 0, rect: placement, imagePng };
        }
        const signed = await signPdfBytes(doc.bytes, p12, pw, {
          signerName: name.trim(),
          reason: role.trim() ? `Signé — ${role.trim()}` : "Signé via Elium",
          visible,
        });
        await submitSignedElium(api, token, doc.nodeKey, signed);
        setState({ phase: "done", title: doc.title });
      }
    } catch (e) {
      setState({ phase: "ready", doc });
      setErr(e instanceof Error ? e.message : "Échec de l'envoi de la signature.");
    }
  };

  const decline = async () => {
    if (state.phase !== "ready") return;
    const doc = state.doc;
    setErr(null);
    setState({ phase: "busy", label: "Refus…" });
    try {
      const api = new DriveApi();
      await api.declineSignature(token);
      setState({ phase: "declined", title: doc.title });
    } catch (e) {
      setState({ phase: "ready", doc });
      setErr(e instanceof Error ? e.message : "Refus impossible.");
    }
  };

  const busy = state.phase === "busy";

  return (
    <div className="dc-link-open">
      <div className="dc-link-card">
        <div className="dc-auth__brand-row">
          <Cloud size={26} /> <span>Elium — Signature</span>
        </div>

        {state.phase === "loading" && (
          <p className="muted">
            <Loader size={16} className="dc-spin" /> Ouverture du document à signer…
          </p>
        )}

        {state.phase === "error" && (
          <>
            <div className="dc-link-icon dc-link-icon--err">
              <AlertTriangle size={30} />
            </div>
            <h1>Demande indisponible</h1>
            <p className="muted">{state.message}</p>
          </>
        )}

        {(state.phase === "ready" || busy) && (
          <>
            <div className="dc-link-icon">
              {state.phase === "ready" && state.doc.docType === "pdf" ? <FileText size={30} /> : <PenLine size={30} />}
            </div>
            <h1>{state.phase === "ready" ? state.doc.title : state.label}</h1>
            <p className="muted">
              On vous demande de signer ce document
              {state.phase === "ready" && state.doc.docType === "pdf" ? " PDF" : ""}. Il est déchiffré uniquement dans
              votre navigateur ; aucun compte n'est requis.
            </p>
            {state.phase === "ready" && state.doc.docType === "elium" && state.doc.preview && (
              <pre className="dc-sign-preview">
                {state.doc.preview}
                {state.doc.preview.length >= 600 ? "…" : ""}
              </pre>
            )}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void sign();
              }}
              className="dc-auth__form"
            >
              <input
                className="input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Votre nom"
                autoFocus
                disabled={busy}
              />
              <input
                className="input"
                value={role}
                onChange={(e) => setRole(e.target.value)}
                placeholder="Fonction (optionnel)"
                disabled={busy}
              />
              {state.phase === "ready" && state.doc.docType === "pdf" && (
                <div style={{ margin: "2px 0 10px", textAlign: "left" }}>
                  <label
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      fontSize: 13,
                      cursor: busy ? "default" : "pointer",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={wantsPlacement}
                      disabled={busy}
                      onChange={(e) => {
                        setWantsPlacement(e.target.checked);
                        if (!e.target.checked) setPlacement(null);
                      }}
                    />
                    Placer ma signature sur le document (optionnel)
                  </label>
                  {wantsPlacement && mark && (
                    <SignPlacementPreview
                      bytes={state.doc.bytes}
                      markSrc={mark.src}
                      markRatio={mark.ratio}
                      value={placement}
                      onChange={setPlacement}
                      disabled={busy}
                    />
                  )}
                </div>
              )}
              {err && <p className="dc-error">{err}</p>}
              <button className="eb eb--primary eb--block" disabled={busy || !name.trim()}>
                {busy ? (
                  state.label
                ) : (
                  <>
                    <ShieldCheck size={16} /> Signer et renvoyer
                  </>
                )}
              </button>
              <button type="button" className="eb eb--block eb--outline" disabled={busy} onClick={() => void decline()}>
                <XCircle size={16} /> Refuser de signer
              </button>
            </form>
            <p className="muted" style={{ fontSize: 12 }}>
              {state.phase === "ready" && state.doc.docType === "pdf"
                ? wantsPlacement && placement
                  ? "Signature PAdES (certificat auto-signé) VISIBLE à l'emplacement choisi ; « identité non vérifiée » dans Adobe faute d'autorité de certification."
                  : "Signature PAdES (certificat auto-signé) intégrée au PDF ; « identité non vérifiée » dans Adobe faute d'autorité de certification."
                : "Signature = preuve cryptographique (Ed25519) intégrée au document ; l'émetteur pourra la vérifier."}
            </p>
          </>
        )}

        {state.phase === "done" && (
          <>
            <div className="dc-link-icon">
              <CheckCircle2 size={30} />
            </div>
            <h1>Document signé</h1>
            <p className="muted">
              « {state.title} » a été signé et renvoyé à l'émetteur. Vous pouvez fermer cette page.
            </p>
            {state.words && (
              <p className="muted" style={{ fontSize: 12 }}>
                Mots de vérification de votre clé : <strong>{state.words}</strong> — communiquez-les à l'émetteur par un
                canal de confiance s'il souhaite attribuer votre signature.
              </p>
            )}
          </>
        )}

        {state.phase === "declined" && (
          <>
            <div className="dc-link-icon dc-link-icon--err">
              <XCircle size={30} />
            </div>
            <h1>Signature refusée</h1>
            <p className="muted">Vous avez refusé de signer « {state.title} ». L'émetteur en est informé.</p>
          </>
        )}

        <button className="dc-auth__switch" onClick={onHome}>
          Ouvrir Elium
        </button>
      </div>
    </div>
  );
}
