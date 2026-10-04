/**
 * Palette de commandes GLOBALE (Ctrl/⌘+K, ou Ctrl/⌘+Maj+P) : toutes les actions
 * du module actif (déclarées dans le registre), la navigation, l'espace de
 * travail, les éléments récents/ouvrables et la recherche dans tout l'espace.
 * Recherche floue (lettres dans l'ordre, accents et casse ignorés), raccourcis
 * affichés, commandes récentes remontées en tête.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { FileSpreadsheet, FileText, FileType, Presentation, Search } from "lucide-react";
import { useI18n, type MessageKey } from "../i18n";
import { fuzzyMatch, pushRecent, rankCommands } from "../commands/fuzzy";
import { useCommands, type AppCommand, type CommandGroup } from "../commands/registry";
import { formatBinding, isMac, useBindings } from "../settings/shortcuts";
import type { ItemKind, WorkItem } from "../workspace/types";

const RECENT_KEY = "elium_recent_commands";

function loadRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 8) : [];
  } catch {
    return [];
  }
}
function saveRecent(ids: string[]): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(ids));
  } catch {
    /* les récents sont un confort */
  }
}

const GROUP_ORDER: CommandGroup[] = ["module", "file", "workspace", "nav", "settings", "item"];
const GROUP_LABEL: Record<CommandGroup, MessageKey> = {
  module: "palette.group.module",
  file: "palette.group.file",
  workspace: "palette.group.workspace",
  nav: "palette.group.nav",
  settings: "palette.group.settings",
  item: "palette.group.item",
};
const KIND_ICON: Record<ItemKind, React.ReactNode> = {
  doc: <FileText size={14} />,
  sheet: <FileSpreadsheet size={14} />,
  slides: <Presentation size={14} />,
  pdf: <FileType size={14} />,
};

function Marked({ text, indices }: { text: string; indices: number[] }) {
  if (indices.length === 0) return <>{text}</>;
  const set = new Set(indices);
  return (
    <>
      {[...text].map((ch, i) =>
        set.has(i) ? (
          <mark key={i} className="ws-mark">
            {ch}
          </mark>
        ) : (
          <span key={i}>{ch}</span>
        ),
      )}
    </>
  );
}

export default function CommandPalette({
  items,
  onOpenItem,
  onSearchWorkspace,
  onClose,
}: {
  items: WorkItem[];
  onOpenItem: (item: WorkItem) => void;
  onSearchWorkspace: (query: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const registered = useCommands();
  const bindings = useBindings();
  const mac = isMac();
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const [recent, setRecent] = useState<string[]>(loadRecent);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const entries = useMemo(() => {
    type Entry = AppCommand & { indices: number[] };
    const base = registered.filter((c) => !c.disabled);
    const ranked = rankCommands(base, q, recent).map((r) => ({ ...r.item, indices: r.indices }) as Entry);
    const out: Entry[] = [...ranked];
    if (q.trim().length >= 2) {
      const hits = items
        .filter((i) => !i.trashedAt && !i.locked)
        .map((i) => ({ i, m: fuzzyMatch(q, i.title) }))
        .filter((x): x is { i: WorkItem; m: NonNullable<typeof x.m> } => !!x.m)
        .sort((a, b) => b.m.score - a.m.score)
        .slice(0, 6);
      for (const { i, m } of hits) {
        out.push({
          id: `item:${i.id}`,
          label: i.title,
          group: "item",
          run: () => onOpenItem(i),
          indices: m.indices,
          keywords: i.kind,
        } as Entry);
      }
      out.push({
        id: "ws-search",
        label: t("palette.search_workspace", { query: q.trim() }),
        group: "workspace",
        run: () => onSearchWorkspace(q.trim()),
        indices: [],
      });
    }
    return out;
  }, [registered, q, recent, items, onOpenItem, onSearchWorkspace, t]);

  // Sans requête, les commandes sont groupées ; avec requête, le classement par pertinence prime.
  const display = useMemo(() => {
    if (q.trim()) return entries;
    const recentIds = new Set(recent);
    const top = entries.filter((e) => recentIds.has(e.id));
    const rest = entries.filter((e) => !recentIds.has(e.id));
    rest.sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group));
    return [...top, ...rest];
  }, [entries, q, recent]);

  useEffect(() => inputRef.current?.focus(), []);
  useEffect(() => setIdx(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(".is-active")?.scrollIntoView({ block: "nearest" });
  }, [idx]);

  const run = (c: AppCommand) => {
    if (!c.id.startsWith("item:") && c.id !== "ws-search") {
      const next = pushRecent(recent, c.id);
      setRecent(next);
      saveRecent(next);
    }
    onClose();
    c.run();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setIdx((i) => Math.min(i + 1, display.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const c = display[idx];
      if (c) run(c);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };

  const hintOf = (c: AppCommand): string | undefined => {
    const b = c.shortcutId ? bindings[c.shortcutId] : "";
    return b ? formatBinding(b, mac) : c.hint;
  };

  let lastGroup: CommandGroup | "recent" | null = null;
  const recentIds = new Set(recent);

  return (
    <div className="cmdk-overlay" onClick={onClose}>
      <div
        className="cmdk"
        role="dialog"
        aria-modal="true"
        aria-label={t("palette.title")}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="cmdk__search">
          <Search size={16} />
          <input
            ref={inputRef}
            className="cmdk__input"
            placeholder={t("palette.placeholder")}
            aria-label={t("palette.placeholder")}
            role="combobox"
            aria-expanded
            aria-controls="cmdk-list"
            aria-activedescendant={display[idx] ? `cmdk-${idx}` : undefined}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <ul className="cmdk__list" id="cmdk-list" role="listbox" ref={listRef}>
          {display.length === 0 && <li className="cmdk__empty">{t("palette.none")}</li>}
          {display.map((c, i) => {
            const g: CommandGroup | "recent" = !q.trim() && recentIds.has(c.id) ? "recent" : c.group;
            const header =
              !q.trim() && g !== lastGroup ? (g === "recent" ? t("palette.group.recent") : t(GROUP_LABEL[g])) : null;
            lastGroup = g;
            const hint = hintOf(c);
            const item = c.id.startsWith("item:") ? items.find((x) => `item:${x.id}` === c.id) : undefined;
            return (
              <li key={c.id} role="none">
                {header && <div className="cmdk__group">{header}</div>}
                <div
                  id={`cmdk-${i}`}
                  role="option"
                  aria-selected={i === idx}
                  className={`cmdk__item ${i === idx ? "is-active" : ""}`}
                  onMouseEnter={() => setIdx(i)}
                  onClick={() => run(c)}
                >
                  <span className="cmdk__label">
                    {item && KIND_ICON[item.kind]}{" "}
                    <Marked text={c.label} indices={(c as AppCommand & { indices?: number[] }).indices ?? []} />
                  </span>
                  {hint && <kbd className="cmdk__kbd">{hint}</kbd>}
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
