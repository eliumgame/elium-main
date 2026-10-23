/** Fenêtres de l'import XLSX en flux : progression annulable, puis choix de la plage des feuilles volumineuses. */
import { useState } from "react";
import SheetModal from "./SheetModal";
import type { ImportedSheetInfo } from "./xlsx-import";
import type { SheetWindow } from "./xlsx-stream";

const fr = (n: number) => n.toLocaleString("fr-FR");
const mo = (b: number) => (b >= 1048576 ? `${Math.round(b / 1048576)} Mo` : `${Math.max(1, Math.round(b / 1024))} Ko`);

export function XlsxProgressModal({
  fileName,
  fraction,
  label,
  onCancel,
}: {
  fileName: string;
  fraction: number;
  label: string;
  onCancel: () => void;
}) {
  const pct = Math.round(fraction * 100);
  return (
    <SheetModal
      title="Import du classeur"
      onClose={onCancel}
      footer={
        <button className="elx-mini" onClick={onCancel}>
          Annuler
        </button>
      }
    >
      <p style={{ marginTop: 0 }}>
        <strong>{fileName}</strong>
      </p>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-label="Progression de l'import"
        style={{ height: 8, borderRadius: 4, background: "var(--x-border, #ddd)", overflow: "hidden" }}
      >
        <div
          style={{ width: `${pct}%`, height: "100%", background: "var(--x-accent, #2563eb)", transition: "width .15s" }}
        />
      </div>
      <p aria-live="polite" style={{ marginBottom: 0, opacity: 0.8 }}>
        {label} {pct} %
      </p>
    </SheetModal>
  );
}

interface Row {
  info: ImportedSheetInfo;
  on: boolean;
  from: string;
  to: string;
  header: boolean;
}

export function XlsxRangeModal({
  sheets,
  onApply,
  onClose,
}: {
  sheets: ImportedSheetInfo[];
  onApply: (windows: Record<string, SheetWindow>) => void;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<Row[]>(() =>
    sheets.map((info) => {
      const span = Math.max(1, info.lastRow - info.firstRow + 1);
      const from = info.skipped ? 1 : info.lastRow + 1;
      return {
        info,
        on: !info.skipped,
        from: String(from),
        to: String(info.totalRows ? Math.min(info.totalRows, from + span - 1) : from + span - 1),
        header: true,
      };
    }),
  );
  const patch = (i: number, p: Partial<Row>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...p } : r)));

  const apply = () => {
    const w: Record<string, SheetWindow> = {};
    for (const r of rows) {
      if (!r.on) {
        w[r.info.path] = { skip: true };
        continue;
      }
      const rowStart = Math.max(1, Math.floor(Number(r.from)) || 1);
      const rowEnd = Math.floor(Number(r.to)) || undefined;
      w[r.info.path] = { rowStart, rowEnd, keepHeader: r.header && rowStart > 1 };
    }
    onApply(w);
  };

  return (
    <SheetModal
      title="Classeur très volumineux"
      onClose={onClose}
      wide
      footer={
        <>
          <button className="elx-mini" onClick={onClose}>
            Garder tel quel
          </button>
          <button className="elx-mini elx-mini--primary" onClick={apply}>
            Importer cette plage
          </button>
        </>
      }
    >
      <p style={{ marginTop: 0 }}>
        Pour que le Tableur reste fluide, seules les premières lignes de chaque grande feuille ont été importées. Vous
        pouvez choisir une autre plage de lignes : le fichier est relu sans bloquer l'application.
      </p>
      {rows.map((r, i) => (
        <section key={r.info.path} className="dcx-modal__section">
          <h3 className="dcx-modal__section-title">
            {r.info.name}
            <span style={{ fontWeight: 400, opacity: 0.7 }}>
              {" "}
              — {r.info.totalRows ? `${fr(r.info.totalRows)} lignes, ` : ""}
              {mo(r.info.originalBytes)} de données
            </span>
          </h3>
          {!r.info.skipped && (
            <p style={{ margin: "0 0 8px", opacity: 0.8 }}>
              Actuellement : lignes {fr(r.info.firstRow)} à {fr(r.info.lastRow)} ({fr(r.info.cells)} cellules).
            </p>
          )}
          <label className="checkbox-row">
            <input type="checkbox" checked={r.on} onChange={(e) => patch(i, { on: e.target.checked })} />
            Importer cette feuille
          </label>
          <div className="dcx-inline" style={{ marginTop: 8, opacity: r.on ? 1 : 0.5 }}>
            <label>
              De la ligne{" "}
              <input
                className="elx-input"
                type="number"
                min={1}
                disabled={!r.on}
                value={r.from}
                onChange={(e) => patch(i, { from: e.target.value })}
                style={{ width: 110 }}
              />
            </label>
            <label>
              à la ligne{" "}
              <input
                className="elx-input"
                type="number"
                min={1}
                disabled={!r.on}
                value={r.to}
                onChange={(e) => patch(i, { to: e.target.value })}
                style={{ width: 110 }}
              />
            </label>
          </div>
          <label className="checkbox-row" style={{ marginTop: 8 }}>
            <input
              type="checkbox"
              disabled={!r.on}
              checked={r.header}
              onChange={(e) => patch(i, { header: e.target.checked })}
            />
            Garder la ligne 1 (en-têtes) en haut
          </label>
        </section>
      ))}
    </SheetModal>
  );
}
