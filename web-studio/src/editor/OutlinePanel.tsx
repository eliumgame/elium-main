import { useEffect, useMemo, useState } from "react";
import type { Editor } from "@tiptap/react";
import { ChevronDown, ChevronRight, Hash, ListTree } from "lucide-react";

/**
 * Navigation pane — Word's document map.
 *
 * Rebuilt from the heading nodes on every transaction, so it always matches
 * what is on the page. Clicking an entry scrolls to it and puts the caret
 * there; the entry containing the caret stays highlighted while you type.
 */

export interface OutlineEntry {
  id: string;
  level: number;
  text: string;
  /** ProseMirror document position of the heading node. */
  pos: number;
}

export function readOutline(editor: Editor | null): OutlineEntry[] {
  if (!editor) return [];
  const out: OutlineEntry[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name !== "heading") return;
    const text = node.textContent.trim();
    out.push({
      id: `h-${pos}`,
      level: Number(node.attrs.level) || 1,
      text: text || "(titre vide)",
      pos,
    });
  });
  return out;
}

/** Index of the last heading at or before the caret. */
export function activeIndex(entries: readonly OutlineEntry[], caret: number): number {
  let best = -1;
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].pos <= caret) best = i;
    else break;
  }
  return best;
}

/** Headings that should be hidden because an ancestor is collapsed. */
export function hiddenByCollapse(entries: readonly OutlineEntry[], collapsed: ReadonlySet<string>): Set<string> {
  const hidden = new Set<string>();
  for (let i = 0; i < entries.length; i++) {
    if (!collapsed.has(entries[i].id)) continue;
    const level = entries[i].level;
    for (let j = i + 1; j < entries.length && entries[j].level > level; j++) {
      hidden.add(entries[j].id);
    }
  }
  return hidden;
}

export default function OutlinePanel({ editor }: { editor: Editor | null }) {
  const [tick, setTick] = useState(0);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!editor) return;
    const bump = () => setTick((t) => t + 1);
    editor.on("transaction", bump);
    editor.on("selectionUpdate", bump);
    return () => {
      editor.off("transaction", bump);
      editor.off("selectionUpdate", bump);
    };
  }, [editor]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const entries = useMemo(() => readOutline(editor), [editor, tick]);
  const caret = editor?.state.selection.from ?? 0;
  const active = activeIndex(entries, caret);
  const hidden = hiddenByCollapse(entries, collapsed);

  const hasChildren = (i: number) =>
    i + 1 < entries.length && entries[i + 1].level > entries[i].level;

  const goTo = (entry: OutlineEntry) => {
    if (!editor) return;
    editor.chain().focus().setTextSelection(entry.pos + 1).run();
    const dom = editor.view.domAtPos(entry.pos + 1).node as HTMLElement | Text;
    const el = dom instanceof HTMLElement ? dom : dom.parentElement;
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  return (
    <div className="elx-panel">
      <div className="elx-panel__head">
        <span className="elx-panel__title">Plan du document</span>
        <span className="elx-panel__count">{entries.length}</span>
      </div>
      <div className="elx-panel__body">
        {!entries.length && (
          <p className="elx-empty">
            Aucun titre dans ce document.<br />
            Appliquez un style Titre 1 à 3 pour construire le plan.
          </p>
        )}
        {entries.map((entry, i) =>
          hidden.has(entry.id) ? null : (
            <div
              key={entry.id}
              className={`doc-outline__row ${i === active ? "is-active" : ""}`}
              style={{ paddingLeft: 6 + (entry.level - 1) * 14 }}
            >
              {hasChildren(i) ? (
                <button
                  className="doc-outline__twist"
                  title={collapsed.has(entry.id) ? "Déplier" : "Replier"}
                  onClick={() =>
                    setCollapsed((prev) => {
                      const next = new Set(prev);
                      if (next.has(entry.id)) next.delete(entry.id);
                      else next.add(entry.id);
                      return next;
                    })
                  }
                >
                  {collapsed.has(entry.id) ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                </button>
              ) : (
                <span className="doc-outline__twist"><Hash size={11} /></span>
              )}
              <button
                className="doc-outline__title"
                data-level={entry.level}
                onClick={() => goTo(entry)}
                title={entry.text}
              >
                {entry.text}
              </button>
            </div>
          ),
        )}
      </div>
      <div className="elx-panel__foot">
        <span className="doc-outline__hint"><ListTree size={12} /> Cliquez un titre pour y aller</span>
      </div>
    </div>
  );
}
