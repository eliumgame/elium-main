/**
 * Floating action list shared by every menu that isn't a fixed toolbar popover:
 * right-click context menus (element / canvas / slide) today, any future
 * "⋯" menu tomorrow. Reuses the .sv-menu__pop / .sv-menu__item grammar the
 * toolbar galleries already established so a context menu reads as the same
 * component, not a bolted-on one.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";

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

/**
 * A popover anchored under a toolbar trigger button (the shape/chart/color/
 * anim/template galleries) — same accessibility contract as CtxMenu below
 * (Échap ferme, focus initial dans le panneau) but without the backdrop/
 * click-point positioning, since it's laid out via CSS relative to its
 * trigger (`.sv-menu__pop`). These used to close only on `onMouseLeave`,
 * which a keyboard or touch user has no way to trigger.
 */
export function ToolbarPopover({
  className,
  role = "menu",
  ariaLabel,
  onClose,
  triggerRef,
  children,
}: {
  className?: string;
  /** "menu" for plain action lists (shapes, charts, colors, templates); "dialog"
   *  for panels that mix in real form controls (select/input), since ARIA menus
   *  aren't meant to host arbitrary widgets. */
  role?: "menu" | "dialog";
  ariaLabel?: string;
  onClose: () => void;
  triggerRef?: RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Échap ferme le popover et rend le focus au bouton qui l'a ouvert.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onCloseRef.current();
        triggerRef?.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Un clic en dehors du popover (et de son déclencheur) le referme — seul
  // onMouseLeave gérait ça avant, invisible au clavier/tactile.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (ref.current?.contains(target)) return;
      if (triggerRef?.current?.contains(target)) return;
      onCloseRef.current();
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Le focus part sur le premier contrôle activable à l'ouverture, comme le
  // menu contextuel : le popover reste utilisable au clavier même ouvert
  // depuis un clic souris.
  useEffect(() => {
    const first = ref.current?.querySelector<HTMLElement>(
      'button:not(:disabled), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    first?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div ref={ref} className={className} role={role} aria-label={ariaLabel}>
      {children}
    </div>
  );
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
