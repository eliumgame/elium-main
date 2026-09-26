/**
 * Empty signature fields drawn over the page: a click opens the signing
 * dialog for that field (Acrobat: « Cliquez pour signer »).
 */
import { FileSignature } from "lucide-react";
import { rectToView, type Rotation, type Size } from "../core/coords";

export default function SigFieldTargets({
  fields,
  size,
  rotation,
  scale,
  onSign,
}: {
  fields: { name: string; box: { x: number; y: number; w: number; h: number } }[];
  size: Size;
  rotation: Rotation;
  scale: number;
  onSign: (name: string) => void;
}) {
  if (!fields.length) return null;
  return (
    <>
      {fields.map((f) => {
        const r = rectToView(f.box, size, rotation);
        return (
          <button
            key={f.name}
            className="pdfx-sigtarget"
            style={{ left: r.x * scale, top: r.y * scale, width: r.w * scale, height: r.h * scale }}
            title={`Signer le champ « ${f.name} »`}
            aria-label={`Signer le champ ${f.name}`}
            onClick={() => onSign(f.name)}
          >
            <FileSignature size={Math.max(12, Math.min(24, (Math.min(r.w, r.h) * scale) / 2))} />
            <span>Cliquer pour signer</span>
          </button>
        );
      })}
    </>
  );
}
