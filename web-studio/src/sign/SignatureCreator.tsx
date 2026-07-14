import { useState } from "react";
import { Modal, Tabs, Field, Button, Alert } from "../ui/components";
import SignaturePad from "./SignaturePad";
import SignatureView from "./SignatureView";
import { makeQrDataUrl } from "./qr";
import type { EliumSignature, SignatureKind, SignatureVisual, SignerInfo, StampStyle } from "../format/types";
import { useDialogs } from "../ui/dialogs";

export interface SignatureDraft {
  kind: SignatureKind;
  visual: SignatureVisual;
  signer: SignerInfo;
  wantsProof: boolean;
}

const SCRIPT_FONTS = [
  { label: "Manuscrite", value: "'Segoe Script', 'Brush Script MT', cursive" },
  { label: "Élégante", value: "'Snell Roundhand', 'Brush Script MT', cursive" },
  { label: "Standard", value: "Inter, system-ui, sans-serif" },
];

const STAMPS: { value: StampStyle; label: string }[] = [
  { value: "approved", label: "Approuvé" },
  { value: "validated", label: "Validé" },
  { value: "confidential", label: "Confidentiel" },
  { value: "paid", label: "Payé" },
  { value: "received", label: "Reçu" },
  { value: "custom", label: "Personnalisé" },
];

const TABS = [
  { id: "drawn", label: "Dessin" },
  { id: "typed", label: "Texte" },
  { id: "image", label: "Image" },
  { id: "stamp", label: "Tampon" },
  { id: "initials", label: "Initiales" },
  { id: "qr", label: "QR code" },
];

export default function SignatureCreator({
  hasIdentity,
  identityFingerprint,
  onClose,
  onCreate,
}: {
  hasIdentity: boolean;
  identityFingerprint?: string;
  onClose: () => void;
  onCreate: (draft: SignatureDraft) => void;
}) {
  const { alert } = useDialogs();
  const [tab, setTab] = useState<SignatureKind>("drawn");
  const [drawn, setDrawn] = useState("");
  const [imageData, setImageData] = useState("");
  const [typedText, setTypedText] = useState("");
  const [typedFont, setTypedFont] = useState(SCRIPT_FONTS[0].value);
  const [stampStyle, setStampStyle] = useState<StampStyle>("approved");
  const [stampText, setStampText] = useState("");
  const [initials, setInitials] = useState("");
  const [qrText, setQrText] = useState("");

  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [org, setOrg] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [wantsProof, setWantsProof] = useState(false);
  const [building, setBuilding] = useState(false);

  const onUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setImageData(reader.result as string);
    reader.readAsDataURL(file);
  };

  const buildVisual = async (): Promise<{ visual: SignatureVisual; kind: SignatureKind } | null> => {
    switch (tab) {
      case "drawn":
        return drawn ? { kind: "drawn", visual: { image: drawn } } : null;
      case "image":
        return imageData ? { kind: "image", visual: { image: imageData } } : null;
      case "typed":
        return typedText
          ? { kind: name || role ? "mixed" : "typed", visual: { text: typedText, fontFamily: typedFont } }
          : null;
      case "stamp":
        return { kind: "stamp", visual: { stampStyle, text: stampText } };
      case "initials":
        return initials ? { kind: "initials", visual: { text: initials, fontFamily: typedFont } } : null;
      case "qr": {
        const content = qrText || `elium:verify?fp=${identityFingerprint ?? "anon"}`;
        return { kind: "qr", visual: { image: await makeQrDataUrl(content) } };
      }
      default:
        return null;
    }
  };

  const submit = async () => {
    setBuilding(true);
    const built = await buildVisual();
    setBuilding(false);
    if (!built) {
      await alert({ title: "Signature incomplète", message: "Veuillez d'abord créer le visuel de la signature." });
      return;
    }
    onCreate({
      kind: built.kind,
      visual: built.visual,
      signer: { name: name || undefined, role: role || undefined, org: org || undefined, date },
      wantsProof: wantsProof && hasIdentity,
    });
  };

  // Live preview signature object
  const previewSig = {
    id: "preview",
    kind: tab,
    visual:
      tab === "drawn" ? { image: drawn }
      : tab === "image" ? { image: imageData }
      : tab === "typed" ? { text: typedText, fontFamily: typedFont }
      : tab === "stamp" ? { stampStyle, text: stampText }
      : tab === "initials" ? { text: initials, fontFamily: typedFont }
      : { },
    placement: { page: 1, xPct: 0, yPct: 0, wPct: 1, hPct: 1, rotation: 0, z: 0, anchorType: "page" as const },
    signer: { name, role, date },
    proof: null,
    level: "visual" as const,
    createdAt: "",
  } satisfies EliumSignature;

  return (
    <Modal
      title="Créer une signature"
      onClose={onClose}
      wide
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Annuler</Button>
          <Button variant="primary" onClick={submit} disabled={building}>
            {building ? "…" : "Ajouter au document"}
          </Button>
        </>
      }
    >
      <Tabs tabs={TABS} active={tab} onChange={(id) => setTab(id as SignatureKind)} />

      <div className="sig-creator">
        <div className="sig-creator__editor">
          {tab === "drawn" && <SignaturePad onChange={setDrawn} />}

          {tab === "image" && (
            <div className="sig-upload">
              <input type="file" accept="image/*" onChange={onUpload} />
              <p className="muted">Importez une image de signature, un logo ou un cachet (PNG/JPG/SVG).</p>
            </div>
          )}

          {(tab === "typed") && (
            <>
              <Field label="Texte de la signature">
                <input className="input" value={typedText} onChange={(e) => setTypedText(e.target.value)} placeholder="Ex. Jean Dupont" />
              </Field>
              <Field label="Style">
                <select className="input" value={typedFont} onChange={(e) => setTypedFont(e.target.value)}>
                  {SCRIPT_FONTS.map((f) => <option key={f.label} value={f.value}>{f.label}</option>)}
                </select>
              </Field>
            </>
          )}

          {tab === "stamp" && (
            <>
              <Field label="Type de tampon">
                <select className="input" value={stampStyle} onChange={(e) => setStampStyle(e.target.value as StampStyle)}>
                  {STAMPS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                </select>
              </Field>
              <Field label="Texte (optionnel)" hint="Laisser vide pour utiliser le libellé par défaut.">
                <input className="input" value={stampText} onChange={(e) => setStampText(e.target.value)} placeholder="CONFIDENTIEL" />
              </Field>
            </>
          )}

          {tab === "initials" && (
            <Field label="Initiales">
              <input className="input" value={initials} maxLength={6} onChange={(e) => setInitials(e.target.value.toUpperCase())} placeholder="JD" />
            </Field>
          )}

          {tab === "qr" && (
            <Field label="Contenu du QR code" hint="Identifiant ou lien de vérification. Par défaut : empreinte de votre clé.">
              <input className="input" value={qrText} onChange={(e) => setQrText(e.target.value)} placeholder={`elium:verify?fp=${(identityFingerprint ?? "anon").slice(0, 12)}…`} />
            </Field>
          )}
        </div>

        <div className="sig-creator__preview">
          <div className="sig-creator__preview-label">Aperçu</div>
          <div className="sig-creator__preview-box">
            <SignatureView signature={previewSig} />
          </div>
        </div>
      </div>

      <div className="sig-creator__meta">
        <Field label="Nom"><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Fonction"><input className="input" value={role} onChange={(e) => setRole(e.target.value)} /></Field>
        <Field label="Société"><input className="input" value={org} onChange={(e) => setOrg(e.target.value)} /></Field>
        <Field label="Date"><input type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
      </div>

      <label className="checkbox-row">
        <input type="checkbox" checked={wantsProof} disabled={!hasIdentity} onChange={(e) => setWantsProof(e.target.checked)} />
        <span>
          Ajouter une <b>preuve cryptographique</b> (signature Ed25519 + empreinte du document)
          {!hasIdentity && <span className="muted"> — générez d'abord une identité dans le panneau Signatures.</span>}
        </span>
      </label>

      <Alert tone="info">
        Une signature visuelle n'est pas une signature électronique qualifiée. La preuve cryptographique
        atteste l'auteur et détecte les modifications, mais ne remplace pas un prestataire qualifié.
      </Alert>
    </Modal>
  );
}
