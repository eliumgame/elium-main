import { useRef, useState } from "react";
import { Loader2, Upload } from "lucide-react";
import { zipSync } from "fflate";
import { Alert, Button, Modal } from "../../ui/components";
import { reportError } from "../../ui/crash-log";
import { downloadBlob } from "../../export/exporters";
import {
  DEFAULT_BATCH_MARKS,
  applyMarksToFiles,
  batesRegister,
  hasAnyMark,
  type BatchInput,
  type BatchMarksSpec,
  type BatchOutput,
} from "../ops/batch-marks";

/**
 * Bates, en-têtes, pieds de page et filigrane appliqués à plusieurs PDF d'un
 * coup. Résultat : une archive .zip des fichiers marqués et un registre CSV
 * (fichier, pages, plage Bates).
 */
export function BatchMarksDialog({ onClose }: { onClose: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<BatchInput[]>([]);
  const [spec, setSpec] = useState<BatchMarksSpec>(DEFAULT_BATCH_MARKS);
  const [busy, setBusy] = useState<{ done: number; total: number } | null>(null);
  const [results, setResults] = useState<BatchOutput[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const patch = <K extends keyof BatchMarksSpec>(key: K, value: Partial<BatchMarksSpec[K]>) =>
    setSpec((s) => ({ ...s, [key]: { ...(s[key] as object), ...value } }));

  const pick = async (list: FileList | null) => {
    if (!list?.length) return;
    try {
      const read = await Promise.all(
        Array.from(list).map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })),
      );
      setFiles((prev) => [...prev, ...read]);
      setResults(null);
    } catch (e) {
      reportError("pdf.batchmarks.read", e);
      setError("Impossible de lire l'un des fichiers choisis.");
    }
  };

  const run = async () => {
    setError(null);
    setResults(null);
    setBusy({ done: 0, total: files.length });
    try {
      const out = await applyMarksToFiles(files, spec, {
        onProgress: (done, total) => setBusy({ done, total }),
      });
      setResults(out);
      const ok = out.filter((o) => o.bytes);
      if (ok.length) {
        const zip: Record<string, Uint8Array> = {};
        for (const o of ok) zip[o.name] = o.bytes!;
        if (spec.bates.enabled) zip["registre-bates.csv"] = new TextEncoder().encode(batesRegister(files, out));
        downloadBlob("documents-marques.zip", "application/zip", zipSync(zip));
      }
    } catch (e) {
      reportError("pdf.batchmarks", e);
      setError(e instanceof Error ? e.message : "Le traitement a échoué.");
    } finally {
      setBusy(null);
    }
  };

  const band = (key: "header" | "footer", label: string) => (
    <fieldset className="pdfx-batch__group">
      <legend>
        <label>
          <input type="checkbox" checked={spec[key].enabled} onChange={(e) => patch(key, { enabled: e.target.checked })} />{" "}
          {label}
        </label>
      </legend>
      {(["left", "center", "right"] as const).map((pos) => (
        <label key={pos} className="pdfx-batch__field">
          {pos === "left" ? "Gauche" : pos === "center" ? "Centre" : "Droite"}
          <input
            className="input"
            value={spec[key][pos]}
            disabled={!spec[key].enabled}
            placeholder="{page} / {pages} · {date} · {bates}"
            onChange={(e) => patch(key, { [pos]: e.target.value })}
          />
        </label>
      ))}
    </fieldset>
  );

  const failed = results?.filter((r) => r.error) ?? [];

  return (
    <Modal
      title="Marques en lot (Bates, en-têtes, filigrane)"
      onClose={onClose}
      wide
      footer={
        <>
          <Button onClick={onClose}>Fermer</Button>
          <Button variant="primary" disabled={!files.length || !hasAnyMark(spec) || !!busy} onClick={() => void run()}>
            {busy ? <Loader2 size={14} className="pdfx-spin" /> : null}{" "}
            {busy ? `Traitement ${Math.min(busy.done + 1, busy.total)} / ${busy.total}…` : "Appliquer et télécharger"}
          </Button>
        </>
      }
    >
      <div className="pdfx-batch">
        <div>
          <Button size="sm" onClick={() => input.current?.click()}>
            <Upload size={14} /> Ajouter des PDF…
          </Button>
          <input
            ref={input}
            type="file"
            multiple
            accept="application/pdf,.pdf"
            className="visually-hidden"
            aria-label="PDF à marquer"
            onChange={(e) => {
              void pick(e.target.files);
              e.target.value = "";
            }}
          />
          <ul aria-label="Fichiers choisis">
            {files.map((f, i) => (
              <li key={`${f.name}-${i}`}>
                {f.name}{" "}
                <button
                  className="eb eb--ghost eb--sm"
                  aria-label={`Retirer ${f.name}`}
                  onClick={() => setFiles((v) => v.filter((_, k) => k !== i))}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        </div>

        <fieldset className="pdfx-batch__group">
          <legend>
            <label>
              <input
                type="checkbox"
                checked={spec.watermark.enabled}
                onChange={(e) => patch("watermark", { enabled: e.target.checked })}
              />{" "}
              Filigrane texte
            </label>
          </legend>
          <input
            className="input"
            aria-label="Texte du filigrane"
            value={spec.watermark.text}
            disabled={!spec.watermark.enabled}
            onChange={(e) => patch("watermark", { text: e.target.value })}
          />
        </fieldset>

        {band("header", "En-tête")}
        {band("footer", "Pied de page")}

        <fieldset className="pdfx-batch__group">
          <legend>
            <label>
              <input
                type="checkbox"
                checked={spec.bates.enabled}
                onChange={(e) => patch("bates", { enabled: e.target.checked })}
              />{" "}
              Numérotation Bates (à placer avec le jeton {"{bates}"} dans un en-tête ou un pied de page)
            </label>
          </legend>
          <label className="pdfx-batch__field">
            Préfixe
            <input className="input" value={spec.bates.prefix} onChange={(e) => patch("bates", { prefix: e.target.value })} />
          </label>
          <label className="pdfx-batch__field">
            Suffixe
            <input className="input" value={spec.bates.suffix} onChange={(e) => patch("bates", { suffix: e.target.value })} />
          </label>
          <label className="pdfx-batch__field">
            Début
            <input
              className="input"
              type="number"
              min={0}
              value={spec.bates.start}
              onChange={(e) => patch("bates", { start: Math.max(0, Number(e.target.value) || 0) })}
            />
          </label>
          <label className="pdfx-batch__field">
            Chiffres
            <input
              className="input"
              type="number"
              min={1}
              max={12}
              value={spec.bates.digits}
              onChange={(e) => patch("bates", { digits: Math.min(12, Math.max(1, Number(e.target.value) || 1)) })}
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={spec.continueBates}
              onChange={(e) => setSpec((s) => ({ ...s, continueBates: e.target.checked }))}
            />{" "}
            Poursuivre la numérotation d'un fichier au suivant
          </label>
        </fieldset>

        {error && (
          <Alert tone="danger" title="Échec">
            {error}
          </Alert>
        )}
        {results && (
          <div role="status" aria-live="polite">
            {results.length - failed.length} fichier(s) marqué(s)
            {failed.length ? `, ${failed.length} en échec :` : "."}
            <ul>
              {failed.map((f, i) => (
                <li key={i}>
                  {f.name} — {f.error}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Modal>
  );
}
