/**
 * Floating action list shared by every menu that isn't a fixed toolbar popover:
 * right-click context menus (element / canvas / slide) today, any future
 * "⋯" menu tomorrow. Reuses the .sv-menu__pop / .sv-menu__item grammar the
 * toolbar galleries already established so a context menu reads as the same
 * component, not a bolted-on one.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

export interface MenuAction {
  label: string;
  icon?: ReactNode;
  onClick: () => void;
  kbd?: string;
  danger?: boolean;
  disabled?: boolean;
}
export type MenuEntry = MenuAction | { sep: true };

/** Clamps a menu opened at an arbitrary point (a right-click) back onto the
 *  viewport once its real size is known — a click near an edge must not open
 *  a menu that's partly cut off. */
function useClampedPos(x: number, y: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const r = node.getBoundingClientRect();
    const pad = 8;
    const left = Math.min(x, Math.max(pad, window.innerWidth - r.width - pad));
    const top = Math.min(y, Math.max(pad, window.innerHeight - r.height - pad));
    setPos({ left, top });
  }, [x, y]);
  return [ref, pos] as const;
}

/** A menu anchored to a click point (viewport coordinates), with a full-screen
 *  backdrop so any outside click / a second right-click just dismisses it. */
export function CtxMenu({
  x,
  y,
  entries,
  onClose,
}: {
  x: number;
  y: number;
  entries: MenuEntry[];
  onClose: () => void;
}) {
  const [ref, pos] = useClampedPos(x, y);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Échap ferme le menu — un clic droit n'a sinon aucun moyen clavier de sortir.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Le focus part sur le premier item activable : le menu reste utilisable
  // au clavier même s'il a été ouvert par un clic droit (souris).
  useEffect(() => {
    const node = ref.current;
    const first = node?.querySelector<HTMLButtonElement>("button.sv-menu__item:not(:disabled)");
    first?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <div
        className="sv-ctx-backdrop"
        onMouseDown={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
        onWheel={onClose}
      />
      <div ref={ref} className="sv-menu__pop sv-ctxmenu" style={{ left: pos.left, top: pos.top }} role="menu">
        {entries.map((e, i) =>
          "sep" in e ? (
            <div key={i} className="sv-menu__sep" role="separator" />
          ) : (
            <button
              key={i}
              type="button"
              className={`sv-menu__item ${e.danger ? "sv-menu__item--danger" : ""}`}
              role="menuitem"
              disabled={e.disabled}
              onClick={() => {
                onClose();
                e.onClick();
              }}
            >
              {e.icon}
              <span>{e.label}</span>
              {e.kbd && <span className="sv-menu__kbd">{e.kbd}</span>}
            </button>
          ),
        )}
      </div>
    </>
  );
}
