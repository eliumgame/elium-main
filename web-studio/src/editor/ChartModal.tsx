import "./chart-doc.css";
/**
 * Insérer / modifier un graphique : petite grille de données éditable, collage
 * depuis le Tableur (TSV du presse-papiers), type et options (mêmes réglages que
 * le Tableur), aperçu en direct. Même boîte pour l'insertion et l'édition.
 */
import { useMemo, useState } from "react";
import type { Editor } from "@tiptap/react";
import { Modal, Button, Field } from "../ui/components";
import ChartOptionsPanel from "../sheet/ChartOptionsPanel";
import { chartSvg, DEFAULT_CHART, type DocChartData } from "./chartData";
import { parseTsvToChart } from "./chartPaste";
import type { ChartSpec } from "../sheet/model";

export default function ChartModal({
  editor,
  editingPos,
  initial,
  onClose,
}: {
  editor: Editor;
  editingPos?: number;
  initial?: DocChartData;
  onClose: () => void;
}) {
  const [data, setData] = useState<DocChartData>(initial ?? DEFAULT_CHART);
  const [paste, setPaste] = useState("");
  const [pasteError, setPasteError] = useState("");
  const svg = useMemo(() => chartSvg(data), [data]);

  const spec: ChartSpec = {
    id: "doc",
    type: data.chartType,
    c0: 0,
    r0: 0,
    c1: data.series.length,
    r1: Math.max(0, data.labels.length - 1),
    title: data.title,
    opts: data.opts,
  };
  const setCell = (r: number, c: number, v: string) =>
    setData((d) => {
      if (c < 0) return { ...d, labels: d.labels.map((l, i) => (i === r ? v : l)) };
      const n = Number(v.replace(",", "."));
      return { ...d, series: d.series.map((s, k) => (k === c ? { ...s, values: s.values.map((x, i) => (i === r ? (Number.isFinite(n) ? n : 0) : x)) } : s)) };
    });
  const addRow = () => setData((d) => ({ ...d, labels: [...d.labels, `L${d.labels.length + 1}`], series: d.series.map((s) => ({ ...s, values: [...s.values, 0] })) }));
  const delRow = () =>
    setData((d) => (d.labels.length <= 1 ? d : { ...d, labels: d.labels.slice(0, -1), series: d.series.map((s) => ({ ...s, values: s.values.slice(0, -1) })) }));
  const addCol = () =>
    setData((d) => ({ ...d, series: [...d.series, { label: `Série ${d.series.length + 1}`, values: d.labels.map(() => 0) }] }));
  const delCol = () => setData((d) => (d.series.length <= 1 ? d : { ...d, series: d.series.slice(0, -1) }));
  const renameSeries = (c: number, label: string) => setData((d) => ({ ...d, series: d.series.map((s, k) => (k === c ? { ...s, label } : s)) }));

  const applyPaste = () => {
    const r = parseTsvToChart(paste);
    if (!r) {
      setPasteError("Collez des cellules copiées depuis le Tableur : une ligne d'en-têtes, une colonne de libellés et au moins une colonne de nombres.");
      return;
    }
    setPasteError("");
    setData((d) => ({ ...d, labels: r.labels, series: r.series }));
    setPaste("");
  };

  const commit = () => {
    if (editingPos != null) editor.chain().focus().updateChart(editingPos, data).run();
    else editor.chain().focus().insertChart(data).run();
    onClose();
  };

  return (
    <Modal
      title={editingPos != null ? "Modifier le graphique" : "Insérer un graphique"}
      onClose={onClose}
      wide
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Annuler
          </Button>
          <Button onClick={commit}>{editingPos != null ? "Mettre à jour" : "Insérer"}</Button>
        </>
      }
    >
      <div className="settings">
        <section className="settings__section">
          <ChartOptionsPanel spec={spec} seriesLabels={data.series.map((s) => s.label)} onChange={(n) => setData((d) => ({ ...d, chartType: n.type, title: n.title ?? "", opts: n.opts }))} />
        </section>
        <section className="settings__section">
          <Field label="Données">
            <div className="chartdata" role="group" aria-label="Données du graphique">
              <table className="chartdata__grid">
                <thead>
                  <tr>
                    <th />
                    {data.series.map((s, c) => (
                      <th key={c}>
                        <input aria-label={`Nom de la série ${c + 1}`} value={s.label} onChange={(e) => renameSeries(c, e.target.value)} />
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.labels.map((l, r) => (
                    <tr key={r}>
                      <th>
                        <input aria-label={`Libellé de la ligne ${r + 1}`} value={l} onChange={(e) => setCell(r, -1, e.target.value)} />
                      </th>
                      {data.series.map((s, c) => (
                        <td key={c}>
                          <input aria-label={`Valeur ${l} / ${s.label}`} inputMode="decimal" value={s.values[r] ?? 0} onChange={(e) => setCell(r, c, e.target.value)} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="chartdata__actions">
                <Button variant="ghost" onClick={addRow}>
                  + Ligne
                </Button>
                <Button variant="ghost" onClick={delRow}>
                  − Ligne
                </Button>
                <Button variant="ghost" onClick={addCol}>
                  + Série
                </Button>
                <Button variant="ghost" onClick={delCol}>
                  − Série
                </Button>
              </div>
            </div>
          </Field>
          <Field label="Coller depuis le Tableur">
            <textarea
              className="settings__input"
              rows={3}
              placeholder="Copiez une plage dans le Tableur (avec ses en-têtes), puis collez-la ici."
              value={paste}
              onChange={(e) => setPaste(e.target.value)}
            />
            <Button variant="ghost" onClick={applyPaste} disabled={!paste.trim()}>
              Utiliser ces données
            </Button>
            {pasteError && <div role="alert" className="settings__error">{pasteError}</div>}
          </Field>
        </section>
        <section className="settings__section">
          <div className="chartdata__preview" dangerouslySetInnerHTML={{ __html: svg }} />
        </section>
      </div>
    </Modal>
  );
}
