import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { LucideIcon } from "lucide-react";

export interface MenuItem {
  id: string;
  label: string;
  icon?: LucideIcon;
  shortcut?: string;
  disabled?: boolean;
  danger?: boolean;
  run: () => void;
}
/** An item, or a separator. */
export type MenuEntry = MenuItem | "sep";

/** Room kept between the menu and the window's edges. */
const EDGE = 6;

/**
 * A context menu (role=menu) at a point of the window: the arrows move
 * between the items, Entrée runs one, Échap or a click elsewhere closes it and
 * gives the focus back to where it was.
 */
export default function ContextMenu(p: {
  x: number;
  y: number;
  label: string;
  entries: MenuEntry[];
  onClose: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState({ left: p.x, top: p.y });
  const returnTo = useRef<HTMLElement | null>(document.activeElement as HTMLElement | null);
  /** Closed from the keyboard: the focus goes back (a command run may have moved it on purpose). */
  const restore = useRef(false);
  const close = useRef(p.onClose);
  close.current = p.onClose;

  // Kept inside the window (flipped above or left of the point when it would overflow).
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const left = p.x + width + EDGE > window.innerWidth ? Math.max(EDGE, p.x - width) : p.x;
    const top = p.y + height + EDGE > window.innerHeight ? Math.max(EDGE, p.y - height) : p.y;
    setAt({ left, top });
  }, [p.x, p.y]);

  useEffect(() => {
    box.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus({ preventScroll: true });
    const back = returnTo.current;
    const off = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) close.current();
    };
    const gone = () => close.current();
    window.addEventListener("pointerdown", off, true);
    window.addEventListener("resize", gone);
    window.addEventListener("blur", gone);
    return () => {
      window.removeEventListener("pointerdown", off, true);
      window.removeEventListener("resize", gone);
      window.removeEventListener("blur", gone);
      if (restore.current && back?.isConnected) back.focus({ preventScroll: true });
    };
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const items = [...(box.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])];
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    const move = (to: number) => items[(to + items.length) % items.length]?.focus();
    // Keys never reach the workspace's shortcuts while the menu is open.
    e.stopPropagation();
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        move(i + 1);
        break;
      case "ArrowUp":
        e.preventDefault();
        move(i < 0 ? -1 : i - 1);
        break;
      case "Home":
        e.preventDefault();
        move(0);
        break;
      case "End":
        e.preventDefault();
        move(-1);
        break;
      case "Escape":
      case "Tab":
        e.preventDefault();
        restore.current = true;
        p.onClose();
        break;
      default:
        break;
    }
  };

  // In the body: the workspace is a size container, which would anchor a fixed menu to itself.
  return createPortal(
    <div
      ref={box}
      className="pdfx-menu pdfx-ctxmenu"
      role="menu"
      aria-label={p.label}
      style={{ left: at.left, top: at.top }}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
    >
      {p.entries.map((entry, k) => {
        if (entry === "sep") return <div key={`sep${k}`} className="pdfx-menu__sep" role="separator" />;
        const Icon = entry.icon;
        return (
          <button
            key={entry.id}
            type="button"
            role="menuitem"
            tabIndex={-1}
            className={`pdfx-menu__item ${entry.danger ? "is-danger" : ""}`}
            disabled={entry.disabled}
            // A text selection survives the click.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              p.onClose();
              entry.run();
            }}
          >
            {Icon ? <Icon size={14} aria-hidden /> : <span className="pdfx-ctxmenu__noicon" />}
            <span className="pdfx-ctxmenu__label">{entry.label}</span>
            {entry.shortcut && <kbd className="pdfx-ctxmenu__kbd">{entry.shortcut}</kbd>}
          </button>
        );
      })}
    </div>,
    document.body,
  );
}
