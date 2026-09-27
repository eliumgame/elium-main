import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { ZOOM_PRESETS, type ZoomMode } from "./state";

type FitMode = Exclude<ZoomMode, "custom">;

/** The zoom box's list: the fits, then the preset levels. */
const OPTIONS: { value: FitMode | number; label: string }[] = [
  { value: "fitWidth", label: "Largeur" },
  { value: "fitPage", label: "Page entière" },
  { value: "fitVisible", label: "Zone de texte" },
  ...ZOOM_PRESETS.map((z) => ({ value: z, label: `${Math.round(z * 100)} %` })),
];

/** A typed zoom (« 150 », « 150 % », « 150,5 »), in percent, or null. */
export function parseZoomPercent(text: string): number | null {
  const m = /^\s*(\d+(?:[.,]\d+)?)\s*%?\s*$/.exec(text);
  if (!m) return null;
  const v = Number(m[1].replace(",", "."));
  return Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * Acrobat's zoom box: an editable combobox. Type a percentage and press
 * Entrée, or open the list (Alt+↓, or the arrow button) for the fits and the
 * preset levels.
 */
export default function ZoomBox(p: {
  percent: number;
  onPercent: (percent: number) => void;
  onFit: (mode: FitMode) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const off = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", off, true);
    return () => window.removeEventListener("pointerdown", off, true);
  }, [open]);

  const choose = (value: FitMode | number) => {
    setOpen(false);
    setDraft(null);
    if (typeof value === "number") p.onPercent(value * 100);
    else p.onFit(value);
  };
  const commit = () => {
    const v = draft == null ? null : parseZoomPercent(draft);
    setDraft(null);
    if (v != null) p.onPercent(v);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        setActive(0);
        return;
      }
      const n = OPTIONS.length;
      setActive((i) => (i < 0 ? 0 : (i + (e.key === "ArrowDown" ? 1 : -1) + n) % n));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (open && active >= 0) choose(OPTIONS[active].value);
      else commit();
      e.currentTarget.select();
    } else if (e.key === "Escape") {
      if (open || draft != null) {
        e.preventDefault();
        e.stopPropagation();
      }
      setOpen(false);
      setDraft(null);
    }
  };

  return (
    <div className="pdfx-zoombox" ref={box}>
      <input
        ref={input}
        className="pdfx-zoombox__input"
        role="combobox"
        aria-label="Niveau de zoom"
        aria-expanded={open}
        aria-controls="pdfx-zoombox-list"
        aria-autocomplete="none"
        aria-activedescendant={open && active >= 0 ? `pdfx-zoombox-opt-${active}` : undefined}
        title="Niveau de zoom : tapez un pourcentage puis Entrée"
        value={draft ?? `${p.percent} %`}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => {
          setDraft(e.target.value);
          setActive(-1);
        }}
        onBlur={(e) => {
          if (!box.current?.contains(e.relatedTarget as Node)) {
            commit();
            setOpen(false);
          }
        }}
        onKeyDown={onKeyDown}
      />
      <button
        type="button"
        className="pdfx-zoombox__toggle"
        tabIndex={-1}
        aria-label="Choix du zoom"
        title="Choix du zoom"
        aria-expanded={open}
        aria-controls="pdfx-zoombox-list"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          setOpen((v) => !v);
          input.current?.focus();
        }}
      >
        <ChevronDown size={13} />
      </button>
      {open && (
        <ul className="pdfx-menu pdfx-zoombox__list" id="pdfx-zoombox-list" role="listbox" aria-label="Niveaux de zoom">
          {OPTIONS.map((o, i) => (
            <li
              key={String(o.value)}
              id={`pdfx-zoombox-opt-${i}`}
              role="option"
              aria-selected={i === active}
              className={`pdfx-menu__item ${i === active ? "is-active" : ""}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(o.value)}
            >
              {o.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
