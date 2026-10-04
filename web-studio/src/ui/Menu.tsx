/**
 * Menu déroulant accessible (bouton + liste d'actions) : flèches, Échap, clic
 * extérieur. Sert aux actions d'un élément de la bibliothèque, aux tris, etc.
 */
import { useEffect, useId, useRef, useState } from "react";

export interface MenuItem {
  id: string;
  label: string;
  icon?: React.ReactNode;
  danger?: boolean;
  disabled?: boolean;
  /** Indication de raccourci affichée à droite. */
  hint?: string;
  /** Séparateur AVANT cet élément. */
  separator?: boolean;
  onSelect: () => void;
}

export default function Menu({
  label,
  trigger,
  items,
  align = "right",
  className = "",
}: {
  /** Nom accessible du bouton. */
  label: string;
  trigger: React.ReactNode;
  items: MenuItem[];
  align?: "left" | "right";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [idx, setIdx] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  useEffect(() => {
    if (open) {
      setIdx(
        Math.max(
          0,
          items.findIndex((i) => !i.disabled),
        ),
      );
      requestAnimationFrame(() => listRef.current?.focus());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const move = (dir: 1 | -1) => {
    let i = idx;
    for (let n = 0; n < items.length; n++) {
      i = (i + dir + items.length) % items.length;
      if (!items[i]!.disabled) {
        setIdx(i);
        return;
      }
    }
  };

  const choose = (item: MenuItem) => {
    if (item.disabled) return;
    setOpen(false);
    btnRef.current?.focus();
    item.onSelect();
  };

  return (
    <div className={`el-menu ${className}`} ref={rootRef} onClick={(e) => e.stopPropagation()}>
      <button
        ref={btnRef}
        type="button"
        className="el-menu__btn icon-btn"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((v) => !v)}
      >
        {trigger}
      </button>
      {open && (
        <ul
          id={id}
          ref={listRef}
          role="menu"
          tabIndex={-1}
          aria-label={label}
          className={`el-menu__list el-menu__list--${align}`}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              move(1);
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              move(-1);
            } else if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              const it = items[idx];
              if (it) choose(it);
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              setOpen(false);
              btnRef.current?.focus();
            } else if (e.key === "Tab") {
              setOpen(false);
            }
          }}
        >
          {items.map((it, i) => (
            <li key={it.id} role="none" className={it.separator ? "el-menu__sep" : undefined}>
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                disabled={it.disabled}
                className={`el-menu__item ${i === idx ? "is-active" : ""} ${it.danger ? "el-menu__item--danger" : ""}`}
                onMouseEnter={() => setIdx(i)}
                onClick={() => choose(it)}
              >
                {it.icon}
                <span>{it.label}</span>
                {it.hint && <kbd className="cmdk__kbd">{it.hint}</kbd>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
