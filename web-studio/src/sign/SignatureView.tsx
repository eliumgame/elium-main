import { useState } from "react";
import type { EliumSignature, SignatureVerdict } from "../format/types";
import { ShieldCheck, ShieldAlert, ShieldQuestion, Shield } from "lucide-react";

/** Image de signature avec repli LIBELLÉ : si le data URL est cassé/vide, on
 *  affiche une étiquette au lieu du glyphe « image cassée » (cf. StampImg PDF). */
function SigImg({ src, label }: { src: string; label: string }) {
  const [broken, setBroken] = useState(false);
  if (!src || broken) return <div className="sig-view__img-fallback">{label}</div>;
  return <img className="sig-view__img" src={src} alt="signature" draggable={false} onError={() => setBroken(true)} />;
}

const STAMP_LABELS: Record<string, string> = {
  approved: "APPROUVÉ",
  validated: "VALIDÉ",
  confidential: "CONFIDENTIEL",
  paid: "PAYÉ",
  received: "REÇU",
  custom: "",
};

const STAMP_COLORS: Record<string, string> = {
  approved: "#16a34a",
  validated: "#2563eb",
  confidential: "#dc2626",
  paid: "#0891b2",
  received: "#7c3aed",
  custom: "#475569",
};

function VerdictBadge({ verdict }: { verdict?: SignatureVerdict }) {
  if (!verdict) return null;
  const map = {
    valid: { icon: <ShieldCheck size={12} />, cls: "ok", label: "valide" },
    modified: { icon: <ShieldAlert size={12} />, cls: "warn", label: "modifié" },
    invalid: { icon: <ShieldAlert size={12} />, cls: "bad", label: "invalide" },
    unknown_key: { icon: <ShieldQuestion size={12} />, cls: "warn", label: "clé inconnue" },
    visual_only: { icon: <Shield size={12} />, cls: "neutral", label: "visuel" },
  }[verdict];
  return (
    <span className={`sig-verdict sig-verdict--${map.cls}`}>
      {map.icon}
      {map.label}
    </span>
  );
}

/** Renders the visual content of a signature, scaled to fill its container. */
export default function SignatureView({
  signature,
  verdict,
}: {
  signature: EliumSignature;
  verdict?: SignatureVerdict;
}) {
  const { visual, signer, kind } = signature;

  return (
    <div className="sig-view" style={{ color: visual.color, background: visual.background }}>
      {visual.image && <SigImg src={visual.image} label={signer.name || visual.text || "signature"} />}

      {kind === "stamp" && !visual.image && (
        <div
          className="sig-view__stamp"
          style={{
            borderColor: STAMP_COLORS[visual.stampStyle ?? "custom"],
            color: STAMP_COLORS[visual.stampStyle ?? "custom"],
          }}
        >
          {visual.text || STAMP_LABELS[visual.stampStyle ?? "custom"]}
        </div>
      )}

      {(kind === "typed" || kind === "mixed" || kind === "initials") && visual.text && !visual.image && (
        <div className="sig-view__text" style={{ fontFamily: visual.fontFamily }}>
          <span className="sig-view__name">{visual.text}</span>
          {visual.subText && <span className="sig-view__sub">{visual.subText}</span>}
        </div>
      )}

      {(signer.name || signer.role || signer.date) && kind !== "stamp" && (
        <div className="sig-view__meta">
          {signer.name && <span>{signer.name}</span>}
          {signer.role && <span className="sig-view__role">{signer.role}</span>}
          {signer.date && <span className="sig-view__date">{signer.date}</span>}
        </div>
      )}

      {(verdict || signature.proof) && (
        <div className="sig-view__footer">
          <VerdictBadge verdict={verdict ?? (signature.proof ? undefined : "visual_only")} />
        </div>
      )}
    </div>
  );
}
