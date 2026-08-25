/**
 * The accept/reject popover for ONE tracked change — a click on an insertion,
 * a deletion, or a pending paragraph-break marker (see TrackChanges.ts) opens
 * this instead of only offering the toolbar's "accept/reject all". Mirrors
 * ProofPopover's positioning and click-outside/Escape dismissal.
 */
import { useEffect, useRef } from "react";
import type { Editor } from "@tiptap/react";
import { Check, X } from "lucide-react";
import type { TrackChangeRequest } from "./TrackChanges";

const KIND_LABEL: Record<TrackChangeRequest["kind"], string> = {
  insertion: "Insertion",
  deletion: "Suppression",
  split: "Saut de paragraphe ajouté",
  merge: "Fusion de paragraphes proposée",
};

export default function TrackChangePopover({
  editor,
  request,
  onClose,
}: {
  editor: Editor;
  request: TrackChangeRequest;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);

  const isBreak = request.kind === "split" || request.kind === "merge";
  const accept = () => {
    editor.chain().focus()[isBreak ? "acceptBreak" : "acceptChange"](request.pos).run();
    onClose();
  };
  const reject = () => {
    editor.chain().focus()[isBreak ? "rejectBreak" : "rejectChange"](request.pos).run();
    onClose();
  };

  const style: React.CSSProperties = {
    left: Math.min(request.x, Math.max(8, window.innerWidth - 260)),
    top: Math.min(request.y, Math.max(8, window.innerHeight - 150)),
  };

  return (
    <div className="trackpop" ref={ref} style={style} role="menu">
      <div className="trackpop__head">
        <span className="trackpop__kind">{KIND_LABEL[request.kind]}</span>
        {request.author && <span className="trackpop__author">{request.author}</span>}
      </div>
      <div className="trackpop__actions">
        <button
          type="button"
          className="trackpop__item trackpop__item--accept"
          onMouseDown={(e) => e.preventDefault()}
          onClick={accept}
        >
          <Check size={13} /> Accepter
        </button>
        <button
          type="button"
          className="trackpop__item trackpop__item--reject"
          onMouseDown={(e) => e.preventDefault()}
          onClick={reject}
        >
          <X size={13} /> Refuser
        </button>
      </div>
    </div>
  );
}
