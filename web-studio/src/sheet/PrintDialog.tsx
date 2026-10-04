/** Mise en page et impression : papier, marges, échelle, zone, titres répétés, sauts, en-tête/pied, PDF. */
import { useMemo, useState } from "react";
import SheetModal from "./SheetModal";
import {
  PAPER_MM,
  normalizePrint,
  paginate,
  toggleColBreak,
  toggleRowBreak,
  type PaperName,
  type PrintSetup,
} from "./print";
import { indexToCol } from "./formula";
import type { SheetStore } from "./store";
import { useDialogs } from "../ui/dialogs";
import { reportError } from "../ui/crash-log";
import { downloadBlob } from "../export/exporters";
import "./datatools.css";

export default function PrintDialog({
  store,
  active,
  sel,
  rect,
  hidden,
  onClose,
}: {
  store: SheetStore;
  active: number;
  /** Cellule active (pour insérer un saut). */
  sel: { c: number; r: number };
  /** Sélection courante (pour définir zone / titres). */
  rect: { c0: number; r0: number; c1: number; r1: number };
  hidden?: (r: number) => boolean;
  onClose: () => void;
}) {
  const dialogs = useDialogs();
  const sheet = store.wb.sheets[active]!;
  const [s, setS] = useState<PrintSetup>(() => normalizePrint(sheet.print));
  const [busy, setBusy] = useState("");
  const set = (patch: Partial<PrintSetup>) => setS((x) => normalizePrint({ ...x, ...patch }));
  const plan = useMemo(() => paginate(sheet, s, { hidden }), [sheet, s, hidden]);
  const margin = (k: keyof PrintSetup["margins"], v: string) => set({ margins: { ...s.margins, [k]: Number(v) } });
  const clear = (k: "area" | "repeatRows" | "repeatCols") => setS((x) => normalizePrint({ ...x, [k]: undefined }));

  const apply = () => store.transformSheet(active, (sh) => ({ ...sh, print: s }));

  const savePdf = async () => {
    setBusy("Mise en page…");
    try {
      const { sheetToPdf } = await import("./print-pdf");
      const wbNow = { ...store.wb, sheets: store.wb.sheets.map((x, i) => (i === active ? { ...x, print: s } : x)) };
      const { bytes } = await sheetToPdf(wbNow, active, s, (d, t) => setBusy(`Mise en page… ${d}/${t}`));
      downloadBlob(`${sheet.name || "feuille"}.pdf`, "application/pdf", bytes);
      apply();
    } catch (e) {
      reportError("sheet-print", e);
      await dialogs.alert({
        title: "Impression impossible",
        message: e instanceof Error ? e.message : "Le PDF n'a pas pu être généré.",
      });
    } finally {
      setBusy("");
    }
  };

  return (
    <SheetModal
      title="Mise en page et impression"
      onClose={onClose}
      wide
      footer={
        <>
          <button className="elx-mini" onClick={onClose}>
            Annuler
          </button>
          <button
            className="elx-mini"
            onClick={() => {
              apply();
              onClose();
            }}
            disabled={!store.canWrite}
          >
            Enregistrer la mise en page
          </button>
          <button className="elx-mini elx-mini--primary" onClick={savePdf} disabled={!!busy}>
            {busy || "Exporter en PDF"}
          </button>
        </>
      }
    >
      <p role="status" className="elx-empty">
        {plan.pages.length} page{plan.pages.length > 1 ? "s" : ""} · échelle {Math.round(plan.scale * 100)} %
      </p>
      <section className="dcx-modal__section">
        <div className="dtools__opts">
          <label className="dcx-field">
            <span>Papier</span>
            <select value={s.paper} onChange={(e) => set({ paper: e.target.value as PaperName })}>
              {(Object.keys(PAPER_MM) as PaperName[]).map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
          </label>
          <label className="dcx-field">
            <span>Orientation</span>
            <select
              value={s.orientation}
              onChange={(e) => set({ orientation: e.target.value as PrintSetup["orientation"] })}
            >
              <option value="portrait">Portrait</option>
              <option value="landscape">Paysage</option>
            </select>
          </label>
          <label>
            <input type="checkbox" checked={s.fitWidth} onChange={(e) => set({ fitWidth: e.target.checked })} /> Ajuster
            à la largeur d'une page
          </label>
          {!s.fitWidth && (
            <label className="dcx-field">
              <span>Échelle (%)</span>
              <input
                type="number"
                min={10}
                max={400}
                value={s.scale}
                onChange={(e) => set({ scale: Number(e.target.value) })}
              />
            </label>
          )}
          <fieldset className="dtools__cols">
            <legend>Marges (mm)</legend>
            {(["top", "right", "bottom", "left"] as const).map((k) => (
              <label key={k}>
                {{ top: "Haut", right: "Droite", bottom: "Bas", left: "Gauche" }[k]}{" "}
                <input
                  type="number"
                  min={0}
                  max={60}
                  value={s.margins[k]}
                  onChange={(e) => margin(k, e.target.value)}
                  style={{ width: 64 }}
                />
              </label>
            ))}
          </fieldset>
          <label className="dcx-field">
            <span>
              En-tête ({"{feuille}"}, {"{date}"})
            </span>
            <input value={s.header ?? ""} onChange={(e) => set({ header: e.target.value })} />
          </label>
          <label className="dcx-field">
            <span>
              Pied de page ({"{page}"}, {"{pages}"})
            </span>
            <input value={s.footer ?? ""} onChange={(e) => set({ footer: e.target.value })} />
          </label>
          <label>
            <input type="checkbox" checked={s.gridlines} onChange={(e) => set({ gridlines: e.target.checked })} />{" "}
            Imprimer le quadrillage
          </label>
          <label>
            <input type="checkbox" checked={s.headings} onChange={(e) => set({ headings: e.target.checked })} />{" "}
            Imprimer les numéros de ligne et lettres de colonne
          </label>
          <label>
            <input
              type="checkbox"
              checked={s.order === "over"}
              onChange={(e) => set({ order: e.target.checked ? "over" : "down" })}
            />{" "}
            Pages de gauche à droite avant de descendre
          </label>
        </div>
      </section>
      <section className="dcx-modal__section">
        <div className="dtools__actions">
          <button className="elx-mini" onClick={() => set({ area: rect })}>
            Zone d'impression = sélection ({indexToCol(rect.c0)}
            {rect.r0 + 1}:{indexToCol(rect.c1)}
            {rect.r1 + 1})
          </button>
          <button className="elx-mini" onClick={() => clear("area")} disabled={!s.area}>
            Effacer la zone
          </button>
        </div>
        <div className="dtools__actions">
          <button className="elx-mini" onClick={() => set({ repeatRows: { r0: rect.r0, r1: rect.r1 } })}>
            Lignes à répéter = {rect.r0 + 1}–{rect.r1 + 1}
          </button>
          <button className="elx-mini" onClick={() => clear("repeatRows")} disabled={!s.repeatRows}>
            Effacer
          </button>
          <button className="elx-mini" onClick={() => set({ repeatCols: { c0: rect.c0, c1: rect.c1 } })}>
            Colonnes à répéter = {indexToCol(rect.c0)}–{indexToCol(rect.c1)}
          </button>
          <button className="elx-mini" onClick={() => clear("repeatCols")} disabled={!s.repeatCols}>
            Effacer
          </button>
        </div>
        <div className="dtools__actions">
          <button className="elx-mini" onClick={() => setS(toggleRowBreak(s, sel.r))}>
            {s.rowBreaks?.includes(sel.r) ? "Retirer" : "Insérer"} un saut de page après la ligne {sel.r + 1}
          </button>
          <button className="elx-mini" onClick={() => setS(toggleColBreak(s, sel.c))}>
            {s.colBreaks?.includes(sel.c) ? "Retirer" : "Insérer"} un saut de page après la colonne {indexToCol(sel.c)}
          </button>
          <button
            className="elx-mini"
            onClick={() => set({ rowBreaks: undefined, colBreaks: undefined })}
            disabled={!s.rowBreaks?.length && !s.colBreaks?.length}
          >
            Supprimer tous les sauts
          </button>
        </div>
      </section>
    </SheetModal>
  );
}
