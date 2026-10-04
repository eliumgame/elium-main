/**
 * Tableur local — une coque fine autour du <SheetEditor> partagé. Elle fournit le
 * backend local (useLocalSheetStore : annuler/rétablir + IndexedDB) et le chrome
 * propre au local (Accueil, exports CSV/XLSX, enregistrement .elium). Toute la
 * surface d'édition est le composant partagé, si bien que le Tableur local reste
 * en phase, à l'identique, avec le Tableur collaboratif Drive.
 */
import { useEffect } from "react";
import { Download, Save } from "lucide-react";
import { useLocalSheetStore } from "../sheet/useLocalSheetStore";
import SheetEditor from "../sheet/SheetEditor";
import { useDialogs } from "../ui/dialogs";
import { createCalc, indexToCol } from "../sheet/formula";
import { tableDefs } from "../sheet/tables";
import { formatValue } from "../sheet/format";
import { rowVisible as filterRowVisible } from "../sheet/filter";
import { workbookToXlsx } from "../sheet/xlsx-export";
import { downloadBlob } from "../export/exporters";
import type { Workbook } from "../sheet/model";

const cellRef = (c: number, r: number) => indexToCol(c) + (r + 1);

export default function SheetView({
  onHome,
  initial,
  onExportElium,
}: {
  onHome: () => void;
  initial?: Workbook;
  onExportElium: (data: Workbook, title: string) => void;
}) {
  const dialogs = useDialogs();
  const store = useLocalSheetStore(initial);

  // La sauvegarde locale n'a pas pu être lue : l'éditeur démarre sur un classeur
  // vierge et l'autosauvegarde est suspendue pour ne pas écraser l'existant.
  useEffect(() => {
    if (!store.loadError) return;
    void dialogs.alert({
      title: "Classeur autosauvegardé illisible",
      message: `${store.loadError}

L'éditeur démarre sur un classeur vierge. La sauvegarde automatique existante n'a PAS été effacée et l'autosauvegarde est suspendue pour cette session : exportez votre travail, puis rechargez Elium.`,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.loadError]);

  const exportCsv = () => {
    const wb = store.wb;
    const sheet = wb.sheets[store.active];
    if (!sheet) return;
    const crossSheets = {
      getSheetRaw: (name: string, ref: string) => wb.sheets.find((s) => s.name === name)?.cells[ref],
      hasSheet: (name: string) => wb.sheets.some((s) => s.name === name),
    };
    const nameMap = new Map((wb.names ?? []).map((n) => [n.name.toUpperCase(), n.ref]));
    const c = createCalc(
      (ref) => sheet.cells[ref],
      crossSheets,
      nameMap.size ? (name: string) => nameMap.get(name) : undefined,
      (ctx) => Object.keys((ctx === null ? sheet : wb.sheets.find((s) => s.name === ctx))?.cells ?? {}),
      { tables: tableDefs(wb.sheets), sheet: sheet.name },
    );
    const cellDisplay = (ref: string) =>
      sheet.cells[ref] != null || c.spillAnchor(ref) !== null ?formatValue(c.valueOf(ref), sheet.styles?.[ref]?.fmt, c.display(ref)) : "";
    const rowVis = (r: number) => filterRowVisible(sheet.filter, (col, rr) => cellDisplay(cellRef(col, rr)), r);
    const lines: string[] = [];
    for (let r = 0; r < sheet.rows; r++) {
      if (!rowVis(r)) continue; // exporte seulement les lignes que le filtre affiche
      const row: string[] = [];
      for (let col = 0; col < sheet.cols; col++) {
        const disp = cellDisplay(cellRef(col, r));
        row.push(/[",\n]/.test(disp) ? `"${disp.replace(/"/g, '""')}"` : disp);
      }
      lines.push(row.join(","));
    }
    downloadBlob(
      `${sheet.name || "feuille"}.csv`,
      "text/csv;charset=utf-8",
      new TextEncoder().encode(lines.join("\r\n")),
    );
  };

  const exportXlsx = () => {
    downloadBlob(
      "classeur.xlsx",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      workbookToXlsx(store.wb),
    );
  };

  const saveElium = async () => {
    const title = await dialogs.prompt({
      title: "Enregistrer en .elium",
      label: "Nom du classeur",
      defaultValue: "Classeur",
    });
    if (title === null) return;
    onExportElium(store.wb, title);
  };

  return (
    <SheetEditor
      store={store}
      chrome={{
        title: "Tableur",
        onHome,
        variant: "page",
        headerActions: (
          <>
            <button className="eb eb--sm eb--outline" onClick={exportCsv} title="Exporter en CSV">
              <Download size={14} /> CSV
            </button>
            <button className="eb eb--sm eb--outline" onClick={exportXlsx} title="Exporter en XLSX">
              <Download size={14} /> XLSX
            </button>
            <button className="eb eb--sm eb--primary" onClick={saveElium}>
              <Save size={14} /> .elium
            </button>
          </>
        ),
      }}
    />
  );
}
