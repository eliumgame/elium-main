import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Search } from "lucide-react";
import type { Permissions } from "../ops/security";
import {
  COMMANDS,
  COMMAND_BY_ID,
  FAMILIES,
  matchScore,
  unavailableReason,
  type CommandContext,
  type CommandDef,
} from "./commands";
import { loadPdfPrefs, savePdfPrefs } from "./prefs";

/** Entries the palette lists at most. */
const MAX_RESULTS = 60;
/** Recent commands remembered. */
const MAX_RECENT = 6;

/** Remember `id` as the most recent command run from the palette. */
export function rememberRecentCommand(id: string): void {
  const recent = (loadPdfPrefs().recentCommands ?? []).filter((x) => x !== id);
  savePdfPrefs({ recentCommands: [id, ...recent].slice(0, MAX_RECENT) });
}

const familyLabel = (def: CommandDef) => FAMILIES.find((f) => f.id === def.family)?.label ?? "";

/**
 * « Rechercher des outils » (Ctrl+Maj+P): every command by name or keyword,
 * accents ignored. A combobox driving a listbox (the ARIA pattern): the arrows
 * move the active option, Entrée runs it, Échap closes. With nothing typed,
 * the recent commands come first.
 */
export default function CommandPalette(p: {
  ctx: CommandContext;
  restrictions: Permissions | null;
  onRun: (def: CommandDef) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  // Focus goes back where it was when the palette closes.
  const returnTo = useRef<HTMLElement | null>(document.activeElement as HTMLElement | null);
  /** A command ran: it decides where the focus goes (a dialog it opened, say). */
  const ran = useRef(false);
  const recent = useMemo(() => loadPdfPrefs().recentCommands ?? [], []);

  const results = useMemo(() => {
    if (!query.trim()) {
      const first = recent.map((id) => COMMAND_BY_ID.get(id)).filter((c): c is CommandDef => !!c);
      const rest = COMMANDS.filter((c) => !first.includes(c));
      return [...first, ...rest].slice(0, MAX_RESULTS).map((def, i) => ({ def, recent: i < first.length }));
    }
    return COMMANDS.map((def, order) => ({ def, order, score: matchScore(def, query) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score || a.order - b.order)
      .slice(0, MAX_RESULTS)
      .map((r) => ({ def: r.def, recent: false }));
  }, [query, recent]);

  useEffect(() => {
    inputRef.current?.focus();
    const back = returnTo.current;
    return () => {
      if (!ran.current && back?.isConnected) back.focus();
    };
  }, []);
  useEffect(() => setActive(0), [query]);
  // The active option stays in view.
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const run = (def: CommandDef) => {
    if (unavailableReason(def, p.ctx, p.restrictions)) return;
    rememberRecentCommand(def.id);
    ran.current = true;
    p.onClose();
    p.onRun(def);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const n = results.length;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (n) setActive((i) => (i + (e.key === "ArrowDown" ? 1 : -1) + n) % n);
    } else if (e.key === "Home" && n) {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End" && n) {
      e.preventDefault();
      setActive(n - 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const r = results[active];
      if (r) run(r.def);
    } else if (e.key === "Tab") {
      // The palette keeps the focus (a modal dialog): Échap or a click outside closes it.
      e.preventDefault();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      p.onClose();
    }
  };

  const optionId = (i: number) => `pdfx-palette-opt-${i}`;
  // In the body, like the context menus (the workspace is a size container).
  return createPortal(
    <div className="pdfx-palette__scrim" onMouseDown={(e) => e.target === e.currentTarget && p.onClose()}>
      <div className="pdfx-palette" role="dialog" aria-modal="true" aria-label="Rechercher des outils">
        <div className="pdfx-palette__field">
          <Search size={16} aria-hidden />
          <input
            ref={inputRef}
            className="pdfx-palette__input"
            role="combobox"
            aria-expanded="true"
            aria-controls="pdfx-palette-list"
            aria-autocomplete="list"
            aria-activedescendant={results.length ? optionId(active) : undefined}
            aria-label="Rechercher des outils"
            placeholder="Rechercher des outils…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
        </div>
        <ul className="pdfx-palette__list" id="pdfx-palette-list" role="listbox" aria-label="Outils" ref={listRef}>
          {results.map(({ def, recent: isRecent }, i) => {
            const Icon = def.icon;
            const why = unavailableReason(def, p.ctx, p.restrictions);
            const hint = def.shortcut ?? def.key;
            return (
              <li
                key={def.id}
                id={optionId(i)}
                data-index={i}
                role="option"
                aria-selected={i === active}
                aria-disabled={why ? true : undefined}
                className={`pdfx-palette__opt ${i === active ? "is-active" : ""} ${why ? "is-disabled" : ""}`}
                title={why ?? undefined}
                onMouseDown={(e) => e.preventDefault()}
                onMouseMove={() => i !== active && setActive(i)}
                onClick={() => run(def)}
              >
                <Icon size={15} aria-hidden />
                <span className="pdfx-palette__label">{def.label}</span>
                <span className="pdfx-palette__family">{isRecent ? "Récent" : familyLabel(def)}</span>
                {hint && <kbd className="pdfx-palette__kbd">{hint}</kbd>}
              </li>
            );
          })}
          {!results.length && (
            <li className="pdfx-palette__empty" role="option" aria-selected="false" aria-disabled="true">
              Aucun outil ne correspond.
            </li>
          )}
        </ul>
      </div>
    </div>,
    document.body,
  );
}
