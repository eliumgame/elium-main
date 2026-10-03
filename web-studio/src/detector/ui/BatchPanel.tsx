/**
 * Mode lot du Détecteur : analyse plusieurs fichiers (ou un dossier) et
 * présente un tableau comparatif exportable en CSV ou JSON.
 */
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Download, Loader2 } from "lucide-react";
import { Alert, Badge, Button } from "../../ui/components";
import { reportError } from "../../ui/crash-log";
import { downloadBlob } from "../../export/exporters";
import { loadDocumentModel } from "../ingest/loadFile";
import { batchToCsv, batchToJson, runBatch, type BatchRow, type BatchStatus } from "../batch";

const STATUS_LABEL: Record<BatchStatus, string> = {
  ok: "Analysé",
  protege: "Protégé",
  illisible: "Format non pris en charge",
  erreur: "Erreur",
  annule: "Annulé",
};

function scoreAccent(score: number | undefined): "success" | "warning" | "danger" | "neutral" {
  if (score === undefined) return "neutral";
  return score >= 60 ? "danger" : score >= 30 ? "warning" : "success";
}

export default function BatchPanel({
  files,
  ignored,
  disabledSignals,
  onBack,
}: {
  files: File[];
  ignored: number;
  disabledSignals: ReadonlySet<string>;
  onBack: () => void;
}) {
  const [rows, setRows] = useState<BatchRow[]>([]);
  const [done, setDone] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);

  useEffect(() => {
    const ctl = new AbortController();
    controller.current = ctl;
    setRows([]);
    setDone(false);
    setFailure(null);
    runBatch(files, {
      generatedAt: new Date().toISOString(),
      disabledSignals,
      signal: ctl.signal,
      load: (f) => loadDocumentModel(f),
      onRow: (row) => setRows((prev) => [...prev, row]),
    })
      .catch((err) => {
        reportError("detector.batch", err);
        setFailure(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setDone(true));
    return () => ctl.abort();
    // Le lot ne se relance que si la sélection de fichiers change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files]);

  const exportAs = (kind: "csv" | "json") => {
    try {
      const stamp = new Date().toISOString().slice(0, 10);
      if (kind === "csv") downloadBlob(`Detecteur-lot-${stamp}.csv`, "text/csv;charset=utf-8", batchToCsv(rows));
      else downloadBlob(`Detecteur-lot-${stamp}.json`, "application/json", batchToJson(rows, new Date().toISOString()));
    } catch (err) {
      reportError("detector.batch.export", err);
      setFailure(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="det-batch">
      <div className="det-batch__bar">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft size={15} /> Nouvelle analyse
        </Button>
        <div role="status" aria-live="polite" className="det-batch__progress">
          {done ? (
            <>
              {rows.length} fichier(s) traité(s)
              {ignored > 0 ? ` — ${ignored} fichier(s) de format non pris en charge ignoré(s)` : ""}
            </>
          ) : (
            <>
              <Loader2 className="elx-spin" size={14} /> Analyse {rows.length + 1} / {files.length}…
            </>
          )}
        </div>
        {!done && (
          <Button size="sm" onClick={() => controller.current?.abort()}>
            Annuler
          </Button>
        )}
        <Button size="sm" disabled={!rows.length} onClick={() => exportAs("csv")}>
          <Download size={14} /> Exporter CSV
        </Button>
        <Button size="sm" disabled={!rows.length} onClick={() => exportAs("json")}>
          <Download size={14} /> Exporter JSON
        </Button>
      </div>
      {failure && (
        <Alert tone="danger" title="Le lot a rencontré une erreur">
          {failure}
        </Alert>
      )}
      <div className="det-batch__scroll">
        <table className="det-batch__table">
          <caption className="visually-hidden">Résultats de l'analyse par lot</caption>
          <thead>
            <tr>
              <th scope="col">Fichier</th>
              <th scope="col">Statut</th>
              <th scope="col">Score global</th>
              <th scope="col">Confiance</th>
              <th scope="col">Principaux constats</th>
              <th scope="col">C2PA</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={`${r.fileName}-${i}`}>
                <th scope="row">{r.fileName}</th>
                <td>{STATUS_LABEL[r.status]}</td>
                <td>
                  {r.overallScore === undefined ? "—" : <Badge accent={scoreAccent(r.overallScore)}>{r.overallScore} / 100</Badge>}
                </td>
                <td>{r.confidence ?? "—"}</td>
                <td>{r.status === "ok" ? (r.topFindings?.length ? r.topFindings.join(" · ") : "Aucun signal notable") : r.detail}</td>
                <td>{r.c2pa ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="det-batch__note">
        Un score élevé est un indice, jamais une preuve. Chaque fichier peut ensuite être rouvert seul pour consulter le
        rapport complet et l'exporter en .docx ou PDF.
      </p>
    </div>
  );
}
