/**
 * Tableur local — une coque fine autour du <SheetEditor> partagé. Elle fournit le
 * backend local (useLocalSheetStore : annuler/rétablir + IndexedDB) et le chrome
 * propre au local (Accueil, exports CSV/XLSX, enregistrement .elium). Toute la
 * surface d'édition est le composant partagé, si bien que le Tableur local reste
 * en phase, à l'identique, avec le Tableur collaboratif Drive.
 *
 * Chaque classeur est un élément de l'espace de travail (`session`) : il est
 * autosauvegardé sous son identifiant et apparaît dans la bibliothèque.
 */
import { useEffect, useMemo, useRef } from "react";
import { Download, Pencil, Save } from "lucide-react";
import { useLocalSheetStore } from "../sheet/useLocalSheetStore";
import SheetEditor from "../sheet/SheetEditor";
import { useDialogs } from "../ui/dialogs";
import { useI18n } from "../i18n";
import { createCalc, indexToCol } from "../sheet/formula";
import { tableDefs } from "../sheet/tables";
import { formatValue } from "../sheet/format";
import { rowVisible as filterRowVisible } from "../sheet/filter";
import { workbookToXlsx } from "../sheet/xlsx-export";
import { downloadBlob } from "../export/exporters";
import type { Workbook } from "../sheet/model";
import type { VaultSecret } from "../crypto/local-vault";
import { useRegisterCommands, type AppCommand } from "../commands/registry";
import { useItemSync, type ItemSession } from "../workspace/useItemSync";
import type { WorkspaceApi } from "../workspace/useWorkspace";

const cellRef = (c: number, r: number) => indexToCol(c) + (r + 1);

export default function SheetView({
  onHome,
  initial,
  onExportElium,
  session,
  workspace,
  vaultSecret,
}: {
  onHome: () => void;
  initial?: Workbook;
  onExportElium: (data: Workbook, title: string) => void;
  /** Élément de l'espace de travail édité (absent : classeur ouvert depuis un fichier .elium, sans autosauvegarde). */
  session?: ItemSession;
  workspace: WorkspaceApi;
  vaultSecret?: VaultSecret;
}) {
  const { t } = useI18n();
  const dialogs = useDialogs();
  const sync = useItemSync(workspace, session, "sheet");
  const store = useLocalSheetStore(
    initial,
    session ? { id: session.id, secret: vaultSecret, isNew: session.isNew, onSaved: sync.onSaved } : undefined,
  );

  // La sauvegarde locale n'a pas pu être lue : l'éditeur démarre sur un classeur
  // vierge et l'autosauvegarde est suspendue pour ne pas écraser l'existant.
  useEffect(() => {
    if (!store.loadError) return;
    void dialogs.alert({
      title: t("sheet.load_error_title"),
      message: t("sheet.load_error_body", { error: store.loadError }),
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
      `${sync.title || "classeur"}.xlsx`,
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      workbookToXlsx(store.wb),
    );
  };

  const saveElium = async () => {
    const title = await dialogs.prompt({
      title: t("sheet.save_elium_title"),
      label: t("sheet.save_elium_label"),
      defaultValue: sync.title || t("sheet.default_name"),
    });
    if (title === null) return;
    onExportElium(store.wb, title);
  };

  // Les commandes de ce module, listées par la palette globale.
  const storeRef = useRef(store);
  storeRef.current = store;
  const latest = useRef({ exportCsv, exportXlsx, saveElium });
  latest.current = { exportCsv, exportXlsx, saveElium };
  const actions = useMemo<AppCommand[]>(
    () => [
      {
        id: "sheet.undo",
        label: t("sheet.cmd.undo"),
        group: "module",
        hint: "Ctrl+Z",
        run: () => storeRef.current.undo?.(),
      },
      {
        id: "sheet.redo",
        label: t("sheet.cmd.redo"),
        group: "module",
        hint: "Ctrl+Y",
        run: () => storeRef.current.redo?.(),
      },
      {
        id: "sheet.add",
        label: t("sheet.cmd.add_sheet"),
        group: "module",
        keywords: "feuille onglet",
        run: () => storeRef.current.addSheet(),
      },
      { id: "sheet.csv", label: t("sheet.cmd.export_csv"), group: "file", run: () => latest.current.exportCsv() },
      {
        id: "sheet.xlsx",
        label: t("sheet.cmd.export_xlsx"),
        group: "file",
        keywords: "excel",
        run: () => latest.current.exportXlsx(),
      },
      {
        id: "sheet.elium",
        label: t("sheet.cmd.save_elium"),
        group: "file",
        shortcutId: "save",
        keywords: "enregistrer",
        run: () => void latest.current.saveElium(),
      },
      ...(session
        ? [
            {
              id: "sheet.rename",
              label: t("sheet.cmd.rename"),
              group: "module" as const,
              run: () => void sync.rename(),
            },
          ]
        : []),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t, session, sync.title],
  );
  useRegisterCommands("sheet", actions);

  return (
    <SheetEditor
      store={store}
      chrome={{
        title: sync.title ? `${t("kind.sheet")} — ${sync.title}` : t("kind.sheet"),
        onHome,
        variant: "page",
        headerActions: (
          <>
            {session && (
              <button className="eb eb--sm eb--ghost" onClick={() => void sync.rename()} title={t("common.rename")}>
                <Pencil size={14} /> {t("common.rename")}
              </button>
            )}
            <button className="eb eb--sm eb--outline" onClick={exportCsv} title={t("sheet.export_csv")}>
              <Download size={14} /> CSV
            </button>
            <button className="eb eb--sm eb--outline" onClick={exportXlsx} title={t("sheet.export_xlsx")}>
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
