import { Button, Alert } from "../ui/components";
import { FileText, FileCode2, FileType2, FileJson, Save, FileType } from "lucide-react";
import type { Studio } from "../studio/types";

export default function ExportPanel({ studio }: { studio: Studio }) {
  return (
    <div className="panel">
      <section className="panel-section">
        <h3 className="panel-title">Enregistrer</h3>
        <Button className="export-btn" onClick={() => studio.save()} disabled={studio.busy}>
          <Save size={16} /> Enregistrer le document .elium
        </Button>
        <p className="muted">Le document, les signatures et le suivi sont enregistrés dans un fichier portable.</p>
      </section>

      <section className="panel-section">
        <h3 className="panel-title">Exporter</h3>
        <div className="export-list">
          <Button variant="outline" className="export-btn" onClick={() => studio.exportAs("pdf")}>
            <FileType2 size={16} /> PDF (impression)
          </Button>
          <Button variant="outline" className="export-btn" onClick={() => studio.exportAs("html")}>
            <FileCode2 size={16} /> HTML
          </Button>
          <Button variant="outline" className="export-btn" onClick={() => studio.exportAs("docx")}>
            <FileType size={16} /> Word (.docx)
          </Button>
          <Button variant="outline" className="export-btn" onClick={() => studio.exportAs("md")}>
            <FileText size={16} /> Markdown
          </Button>
          <Button variant="outline" className="export-btn" onClick={() => studio.exportAs("text")}>
            <FileText size={16} /> Texte brut
          </Button>
          <Button variant="outline" className="export-btn" onClick={() => studio.exportAs("report")}>
            <FileJson size={16} /> Rapport de preuve (JSON)
          </Button>
        </div>
      </section>

      <Alert tone="info">
        Les exports PDF/HTML incluent une page <b>Signatures</b> avec les visuels et l'état de vérification.
        Le rapport de preuve liste les empreintes, signatures et l'intégrité du journal.
      </Alert>
    </div>
  );
}
