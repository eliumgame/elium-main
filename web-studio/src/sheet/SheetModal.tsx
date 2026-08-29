/**
 * Modal shell for the Tableur's own dialogs (conditional formatting, data
 * validation, named ranges, pivot table) — dressed in the shared `.dcx-*`
 * dialog language (see `drive-cloud/ui/ShareDialog.tsx`, its freshest user)
 * instead of the generic `.modal-overlay`/`.modal-card` from `ui/components`.
 *
 * Keeps the same focus-trap/Escape/return-focus behaviour as `Modal` — only
 * the visual language changes, not the accessibility contract.
 */
import { useEffect, useId, useRef } from "react";
import { X } from "lucide-react";

export default function SheetModal({
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  title: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  wide?: boolean;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const titleId = useId();

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const card = cardRef.current;
    const focusables = () =>
      card
        ? Array.from(
            card.querySelectorAll<HTMLElement>(
              'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
            ),
          ).filter((el) => el.offsetParent !== null)
        : [];
    (focusables()[0] ?? card)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const f = focusables();
      if (f.length === 0) {
        e.preventDefault();
        return;
      }
      const first = f[0],
        last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      prev?.focus?.();
    };
  }, []);

  return (
    <div
      className="dcx-modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={cardRef}
        className={`dcx-modal ${wide ? "dcx-modal--wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <header className="dcx-modal__head">
          <h2 id={titleId}>{title}</h2>
          <button className="elx-icon" onClick={onClose} aria-label="Fermer">
            <X size={18} />
          </button>
        </header>
        {children}
        {footer && <div className="dcx-modal__foot">{footer}</div>}
      </div>
    </div>
  );
}
