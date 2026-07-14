import { useRef } from "react";
import SignatureView from "./SignatureView";
import { X, RotateCw } from "lucide-react";
import type { EliumSignature, SignatureVerdict } from "../format/types";

interface Props {
  pageRef: React.RefObject<HTMLDivElement | null>;
  signatures: EliumSignature[];
  editable: boolean;
  selectedId: string | null;
  verdicts?: Record<string, SignatureVerdict>;
  onSelect: (id: string | null) => void;
  onChange: (sig: EliumSignature) => void;
  onRemove: (id: string) => void;
}

type Mode = "drag" | "resize" | "rotate";

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export default function SignatureLayer({
  pageRef,
  signatures,
  editable,
  selectedId,
  verdicts,
  onSelect,
  onChange,
  onRemove,
}: Props) {
  const drag = useRef<{
    mode: Mode;
    sig: EliumSignature;
    startX: number;
    startY: number;
  } | null>(null);

  const begin = (e: React.PointerEvent, sig: EliumSignature, mode: Mode) => {
    if (!editable) return;
    e.preventDefault();
    e.stopPropagation();
    onSelect(sig.id);
    drag.current = { mode, sig, startX: e.clientX, startY: e.clientY };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  };

  const onPointerMove = (e: PointerEvent) => {
    const d = drag.current;
    const page = pageRef.current;
    if (!d || !page) return;
    const rect = page.getBoundingClientRect();
    const dxPct = (e.clientX - d.startX) / rect.width;
    const dyPct = (e.clientY - d.startY) / rect.height;
    const p = d.sig.placement;

    if (d.mode === "drag") {
      onChange({
        ...d.sig,
        placement: {
          ...p,
          xPct: clamp(p.xPct + dxPct, 0, 1 - p.wPct),
          yPct: clamp(p.yPct + dyPct, 0, 1 - p.hPct),
        },
      });
    } else if (d.mode === "resize") {
      onChange({
        ...d.sig,
        placement: {
          ...p,
          wPct: clamp(p.wPct + dxPct, 0.05, 1 - p.xPct),
          hPct: clamp(p.hPct + dyPct, 0.03, 1 - p.yPct),
        },
      });
    } else if (d.mode === "rotate") {
      const cx = rect.left + (p.xPct + p.wPct / 2) * rect.width;
      const cy = rect.top + (p.yPct + p.hPct / 2) * rect.height;
      const angle = (Math.atan2(e.clientY - cy, e.clientX - cx) * 180) / Math.PI + 90;
      onChange({ ...d.sig, placement: { ...p, rotation: Math.round(angle) } });
    }
  };

  const onPointerUp = () => {
    drag.current = null;
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
  };

  return (
    <div className={`sig-layer ${editable ? "sig-layer--editable" : ""}`}>
      {signatures.map((sig) => {
        const p = sig.placement;
        const selected = editable && selectedId === sig.id;
        return (
          <div
            key={sig.id}
            className={`sig-item ${selected ? "is-selected" : ""}`}
            style={{
              left: `${p.xPct * 100}%`,
              top: `${p.yPct * 100}%`,
              width: `${p.wPct * 100}%`,
              height: `${p.hPct * 100}%`,
              transform: `rotate(${p.rotation}deg)`,
              zIndex: 10 + p.z,
            }}
            onPointerDown={(e) => begin(e, sig, "drag")}
            onClick={(e) => { e.stopPropagation(); onSelect(sig.id); }}
          >
            <SignatureView signature={sig} verdict={verdicts?.[sig.id]} />

            {selected && (
              <>
                <button
                  type="button"
                  className="sig-handle sig-handle--delete"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => { e.stopPropagation(); onRemove(sig.id); }}
                  title="Supprimer"
                >
                  <X size={12} />
                </button>
                <div
                  className="sig-handle sig-handle--rotate"
                  onPointerDown={(e) => begin(e, sig, "rotate")}
                  title="Pivoter"
                >
                  <RotateCw size={12} />
                </div>
                <div
                  className="sig-handle sig-handle--resize"
                  onPointerDown={(e) => begin(e, sig, "resize")}
                  title="Redimensionner"
                />
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
