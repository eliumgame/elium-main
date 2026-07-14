/**
 * Collaborative spreadsheet (cell-level CRDT). Each sheet's cells + styles live
 * in Y.Maps keyed by A1 ("A1","B2"…), so concurrent edits to different cells
 * merge cleanly. Reuses the pure formula engine (createCalc) + number formatter.
 * Peers' selected cells are shown live via awareness. End-to-end encrypted: the
 * relay only ever sees encrypted Yjs updates.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import * as Y from "yjs";
import { X, Wifi, WifiOff, Loader, Plus, Bold, Italic, AlignLeft, AlignCenter, AlignRight } from "lucide-react";
import { EncryptedYjsProvider, type CollabStatus, type CollabUser } from "../collab-provider";
import type { DriveApi } from "../api";
import { createCalc } from "../../sheet/formula";
import { formatValue, NUM_FORMATS } from "../../sheet/format";
import type { CellStyle, NumFmt } from "../../sheet/model";

const PALETTE = ["#2563eb", "#16a34a", "#db2777", "#ca8a04", "#7c3aed", "#0ea5e9", "#dc2626", "#0d9488"];
const colorFor = (id: string) => { let h = 0; for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0; return PALETTE[h % PALETTE.length]!; };
const initials = (s: string) => { const p = s.split(/[@\s.]+/).filter(Boolean); return ((p[0]?.[0] ?? "") + (p[1]?.[0] ?? "")).toUpperCase() || "?"; };

function colLetter(c: number): string {
  let s = "";
  let n = c + 1;
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}
const a1 = (r: number, c: number) => `${colLetter(c)}${r + 1}`;

interface SheetSnap { name: string; rows: number; cols: number; cells: Record<string, string>; styles: Record<string, CellStyle>; }
type YSheet = Y.Map<unknown>;

export default function CollabSheetEditor({
  api, nodeId, nodeKey, title, user, onClose, refetchKey,
}: {
  api: DriveApi; nodeId: string; nodeKey: Uint8Array; title: string; user: { id: string; name: string }; onClose: () => void;
  refetchKey?: () => Promise<Uint8Array | null>;
}) {
  const [status, setStatus] = useState<CollabStatus>("connecting");
  const [canWrite, setCanWrite] = useState(false);
  // Revoked access closes the sheet for good — never writable, even if the
  // last known `canWrite` (from before the revocation) was true.
  const writable = canWrite && status !== "revoked";
  const [sheets, setSheets] = useState<SheetSnap[]>([]);
  const [active, setActive] = useState(0);
  const [sel, setSel] = useState({ r: 0, c: 0 });
  const [editing, setEditing] = useState<{ ref: string; draft: string } | null>(null);
  const [peerCells, setPeerCells] = useState<{ color: string; name: string; s: number; ref: string }[]>([]);

  const me: CollabUser = useMemo(() => ({ name: user.name, color: colorFor(user.id) }), [user.id, user.name]);
  const [ydoc] = useState(() => new Y.Doc());
  const [provider] = useState(() => new EncryptedYjsProvider(api, nodeId, nodeKey, ydoc, me, { onStatus: setStatus, onReady: setCanWrite, ...(refetchKey ? { refetchKey } : {}) }));
  const ySheets = useMemo(() => ydoc.getArray<YSheet>("sheets"), [ydoc]);
  const inputRef = useRef<HTMLInputElement>(null);

  const snapshot = (): SheetSnap[] =>
    ySheets.toArray().map((ys) => ({
      name: String(ys.get("name") ?? "Feuille"),
      rows: Number(ys.get("rows") ?? 20),
      cols: Number(ys.get("cols") ?? 8),
      cells: Object.fromEntries((ys.get("cells") as Y.Map<string>)?.entries?.() ?? []) as Record<string, string>,
      styles: Object.fromEntries((ys.get("styles") as Y.Map<CellStyle>)?.entries?.() ?? []) as Record<string, CellStyle>,
    }));

  useEffect(() => {
    let alive = true;
    const obs = () => { if (alive) setSheets(snapshot()); };
    ySheets.observeDeep(obs);
    provider.connect().then(() => {
      if (!alive) return;
      if (ySheets.length === 0) {
        ydoc.transact(() => {
          const s = new Y.Map() as YSheet;
          s.set("name", "Feuille 1"); s.set("rows", 20); s.set("cols", 8);
          s.set("cells", new Y.Map()); s.set("styles", new Y.Map());
          ySheets.push([s]);
        });
      }
      setSheets(snapshot());
    });
    return () => { alive = false; ySheets.unobserveDeep(obs); provider.destroy(); };
  }, [provider, ySheets, ydoc]);

  // Broadcast our selected cell; collect peers' selections.
  useEffect(() => {
    provider.awareness.setLocalStateField("cell", { s: active, ref: a1(sel.r, sel.c) });
  }, [provider, active, sel]);
  useEffect(() => {
    const refresh = () => {
      const self = provider.awareness.clientID;
      const list: { color: string; name: string; s: number; ref: string }[] = [];
      provider.awareness.getStates().forEach((st, id) => {
        if (id === self) return;
        const u = (st as { user?: CollabUser }).user;
        const cell = (st as { cell?: { s: number; ref: string } }).cell;
        if (u && cell) list.push({ color: u.color, name: u.name, s: cell.s, ref: cell.ref });
      });
      setPeerCells(list);
    };
    provider.awareness.on("change", refresh);
    refresh();
    return () => provider.awareness.off("change", refresh);
  }, [provider]);

  const sheet = sheets[active];
  const yActive = (): YSheet | undefined => ySheets.get(active);

  const calc = useMemo(() => {
    const byName: Record<string, SheetSnap> = {};
    for (const s of sheets) byName[s.name] = s;
    const cur = sheets[active];
    return createCalc(
      (ref) => cur?.cells[ref],
      { getSheetRaw: (name, ref) => byName[name]?.cells[ref], hasSheet: (name) => name in byName },
    );
  }, [sheets, active]);

  const setCell = (ref: string, raw: string) => {
    const ys = yActive(); if (!ys) return;
    ydoc.transact(() => {
      const cells = ys.get("cells") as Y.Map<string>;
      if (raw.trim() === "") cells.delete(ref); else cells.set(ref, raw);
    });
  };
  const patchStyle = (patch: Partial<CellStyle>) => {
    const ys = yActive(); if (!ys) return;
    const ref = a1(sel.r, sel.c);
    ydoc.transact(() => {
      const styles = ys.get("styles") as Y.Map<CellStyle>;
      styles.set(ref, { ...(styles.get(ref) ?? {}), ...patch });
    });
  };
  const growth = (key: "rows" | "cols", by: number) => {
    const ys = yActive(); if (!ys) return;
    ydoc.transact(() => ys.set(key, Number(ys.get(key) ?? 0) + by));
  };
  const addSheet = () => {
    ydoc.transact(() => {
      const s = new Y.Map() as YSheet;
      s.set("name", `Feuille ${ySheets.length + 1}`); s.set("rows", 20); s.set("cols", 8);
      s.set("cells", new Y.Map()); s.set("styles", new Y.Map());
      ySheets.push([s]);
    });
    setActive(ySheets.length - 1);
  };

  const commitEdit = (move: boolean) => {
    if (editing) { setCell(editing.ref, editing.draft); setEditing(null); }
    if (move && sheet) setSel((s) => ({ r: Math.min(s.r + 1, sheet.rows - 1), c: s.c }));
  };
  const beginEdit = (r: number, c: number, initial?: string) => {
    const ref = a1(r, c);
    setSel({ r, c });
    setEditing({ ref, draft: initial ?? sheet?.cells[ref] ?? "" });
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const onGridKey = (e: React.KeyboardEvent) => {
    if (editing) return;
    if (!sheet) return;
    if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => ({ ...s, r: Math.max(0, s.r - 1) })); }
    else if (e.key === "ArrowDown" || e.key === "Enter") { e.preventDefault(); setSel((s) => ({ ...s, r: Math.min(sheet.rows - 1, s.r + 1) })); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); setSel((s) => ({ ...s, c: Math.max(0, s.c - 1) })); }
    else if (e.key === "ArrowRight" || e.key === "Tab") { e.preventDefault(); setSel((s) => ({ ...s, c: Math.min(sheet.cols - 1, s.c + 1) })); }
    else if (e.key === "Backspace" || e.key === "Delete") { e.preventDefault(); setCell(a1(sel.r, sel.c), ""); }
    else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && writable) { beginEdit(sel.r, sel.c, e.key); }
  };

  const selRef = a1(sel.r, sel.c);
  const selStyle = sheet?.styles[selRef];
  const statusLabel =
    status === "open" ? "Connecté" :
    status === "connecting" ? "Connexion…" :
    status === "revoked" ? "Accès révoqué — document fermé" :
    "Hors ligne";

  return (
    <div className="dc-modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dc-doc dc-sheet">
        <header className="dc-doc__head">
          <span className="dc-doc__title" title={title}>{title}</span>
          <span className={`dc-doc__status dc-doc__status--${status}`}>
            {status === "open" ? <Wifi size={13} /> : status === "connecting" ? <Loader size={13} className="dc-spin" /> : <WifiOff size={13} />} {statusLabel}
          </span>
          <div className="dc-doc__peers">
            <span className="dc-doc-av" style={{ background: me.color }} title={`${me.name} (vous)`}>{initials(me.name)}</span>
            {[...new Map(peerCells.map((p) => [p.name + p.color, p])).values()].map((p, i) => (
              <span key={i} className="dc-doc-av" style={{ background: p.color }} title={p.name}>{initials(p.name)}</span>
            ))}
          </div>
          <div className="dc-doc__spacer" />
          {!canWrite && status === "open" && <span className="badge badge--neutral">Lecture seule</span>}
          <button className="icon-btn" onClick={onClose} aria-label="Fermer"><X size={18} /></button>
        </header>

        {writable && (
          <div className="dc-doc__toolbar">
            <button className={`icon-btn ${selStyle?.bold ? "is-active" : ""}`} title="Gras" onMouseDown={(e) => { e.preventDefault(); patchStyle({ bold: !selStyle?.bold }); }}><Bold size={16} /></button>
            <button className={`icon-btn ${selStyle?.italic ? "is-active" : ""}`} title="Italique" onMouseDown={(e) => { e.preventDefault(); patchStyle({ italic: !selStyle?.italic }); }}><Italic size={16} /></button>
            <span className="dc-doc__tbsep" />
            <button className={`icon-btn ${selStyle?.align === "left" ? "is-active" : ""}`} title="Gauche" onMouseDown={(e) => { e.preventDefault(); patchStyle({ align: "left" }); }}><AlignLeft size={16} /></button>
            <button className={`icon-btn ${selStyle?.align === "center" ? "is-active" : ""}`} title="Centrer" onMouseDown={(e) => { e.preventDefault(); patchStyle({ align: "center" }); }}><AlignCenter size={16} /></button>
            <button className={`icon-btn ${selStyle?.align === "right" ? "is-active" : ""}`} title="Droite" onMouseDown={(e) => { e.preventDefault(); patchStyle({ align: "right" }); }}><AlignRight size={16} /></button>
            <span className="dc-doc__tbsep" />
            <select className="tool-select" value={selStyle?.fmt ?? "general"} onChange={(e) => patchStyle({ fmt: e.target.value as NumFmt })} title="Format des nombres">
              {NUM_FORMATS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
            </select>
            <span className="dc-doc__tbsep" />
            <button className="eb eb--sm eb--ghost" onClick={() => growth("rows", 10)}><Plus size={13} /> Lignes</button>
            <button className="eb eb--sm eb--ghost" onClick={() => growth("cols", 4)}><Plus size={13} /> Colonnes</button>
          </div>
        )}

        {/* Formula bar */}
        <div className="dc-sheet__fx">
          <span className="dc-sheet__fxref">{selRef}</span>
          <input
            ref={inputRef}
            className="dc-sheet__fxinput"
            value={editing ? editing.draft : (sheet?.cells[selRef] ?? "")}
            readOnly={!writable}
            onFocus={() => { if (writable && !editing) setEditing({ ref: selRef, draft: sheet?.cells[selRef] ?? "" }); }}
            onChange={(e) => setEditing({ ref: selRef, draft: e.target.value })}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commitEdit(true); } else if (e.key === "Escape") setEditing(null); }}
            onBlur={() => commitEdit(false)}
            placeholder="Valeur ou =formule"
          />
        </div>

        <div className="dc-doc__body dc-sheet__body" tabIndex={0} onKeyDown={onGridKey}>
          {sheet && (
            <table className="dc-sheet__grid">
              <thead>
                <tr>
                  <th className="dc-sheet__corner" />
                  {Array.from({ length: sheet.cols }, (_, c) => <th key={c} className="dc-sheet__colh">{colLetter(c)}</th>)}
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: sheet.rows }, (_, r) => (
                  <tr key={r}>
                    <th className="dc-sheet__rowh">{r + 1}</th>
                    {Array.from({ length: sheet.cols }, (_, c) => {
                      const ref = a1(r, c);
                      const st = sheet.styles[ref];
                      const isSel = sel.r === r && sel.c === c;
                      const isEditing = editing?.ref === ref;
                      const peer = peerCells.find((p) => p.s === active && p.ref === ref);
                      const disp = formatValue(calc.valueOf(ref), st?.fmt, calc.display(ref));
                      const style: React.CSSProperties = {
                        fontWeight: st?.bold ? 700 : undefined,
                        fontStyle: st?.italic ? "italic" : undefined,
                        textAlign: st?.align,
                        color: st?.color,
                        background: st?.fill,
                        boxShadow: peer ? `inset 0 0 0 2px ${peer.color}` : undefined,
                      };
                      return (
                        <td
                          key={c}
                          className={`dc-sheet__cell ${isSel ? "is-sel" : ""}`}
                          style={style}
                          onMouseDown={() => { if (!isEditing) { commitEdit(false); setSel({ r, c }); } }}
                          onDoubleClick={() => writable && beginEdit(r, c)}
                          title={peer ? `${peer.name} est ici` : undefined}
                        >
                          {isEditing ? (
                            <input
                              autoFocus
                              className="dc-sheet__celledit"
                              value={editing.draft}
                              onChange={(e) => setEditing({ ref, draft: e.target.value })}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") { e.preventDefault(); commitEdit(true); }
                                else if (e.key === "Escape") { e.preventDefault(); setEditing(null); }
                                else if (e.key === "Tab") { e.preventDefault(); commitEdit(false); setSel((s) => ({ ...s, c: Math.min(sheet.cols - 1, s.c + 1) })); }
                              }}
                              onBlur={() => commitEdit(false)}
                            />
                          ) : (
                            disp
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="dc-sheet__tabs">
          {sheets.map((s, i) => (
            <button key={i} className={`dc-sheet__tab ${i === active ? "is-active" : ""}`} onClick={() => { commitEdit(false); setActive(i); setSel({ r: 0, c: 0 }); }}>{s.name}</button>
          ))}
          {writable && <button className="icon-btn" title="Ajouter une feuille" onClick={addSheet}><Plus size={15} /></button>}
        </div>
      </div>
    </div>
  );
}
