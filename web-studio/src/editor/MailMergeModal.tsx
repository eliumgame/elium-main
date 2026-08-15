import { useMemo, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { ChevronLeft, ChevronRight, Eye, EyeOff, Upload, Users } from "lucide-react";
import { Modal, Button, Field, Alert, EmptyState } from "../ui/components";
import { mergeCombined, missingFields, parseDataSource, recordLabel, usedFields, type MergeData } from "./mailmerge";
import { setMergePreview } from "./wordExtensions";
import type { ProseMirrorNode } from "../format/types";

const EMPTY: MergeData = { fields: [], records: [] };

/**
 * Mail merge (publipostage).
 *
 * Load a data source (CSV/TSV file or pasted text), drop merge fields into the
 * document, step through the records with a live preview rendered in the editor
 * itself, then produce the merged document — either one long document with a page
 * break per record, or a single record for a one-off letter.
 */
export default function MailMergeModal({
  editor,
  onMerged,
  onClose,
}: {
  editor: Editor;
  /** Opens the merged result as a new document. */
  onMerged: (doc: ProseMirrorNode, recordCount: number) => void;
  onClose: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [data, setData] = useState<MergeData>(EMPTY);
  const [sourceName, setSourceName] = useState("");
  const [pasted, setPasted] = useState("");
  const [error, setError] = useState("");
  const [current, setCurrent] = useState(0);
  const [previewing, setPreviewing] = useState(false);
  const [excluded, setExcluded] = useState<Set<number>>(new Set());

  const docJson = editor.getJSON() as ProseMirrorNode;
  const used = useMemo(() => usedFields(docJson), [docJson]);
  const missing = useMemo(() => (data.records.length ? missingFields(docJson, data) : []), [docJson, data]);

  const selected = useMemo(
    () => data.records.map((_, i) => i).filter((i) => !excluded.has(i)),
    [data.records, excluded],
  );

  const load = (text: string, name: string) => {
    const parsed = parseDataSource(text);
    if (!parsed.fields.length || !parsed.records.length) {
      setError("Aucun enregistrement lisible : la première ligne doit contenir les noms de colonnes.");
      return;
    }
    setData(parsed);
    setSourceName(name);
    setCurrent(0);
    setExcluded(new Set());
    setError("");
  };

  /** Live preview: merge-field node views subscribe to this record. */
  const applyPreview = (on: boolean, index = current) => {
    setPreviewing(on);
    setMergePreview(on ? (data.records[index] ?? null) : null);
  };

  const step = (delta: number) => {
    if (!data.records.length) return;
    const next = Math.min(data.records.length - 1, Math.max(0, current + delta));
    setCurrent(next);
    if (previewing) applyPreview(true, next);
  };

  const closeAndReset = () => {
    setMergePreview(null);
    onClose();
  };

  const mergeAllRecords = () => {
    const merged = mergeCombined(docJson, data, { selected });
    setMergePreview(null);
    onMerged(merged, selected.length);
    onClose();
  };

  const mergeOne = () => {
    const merged = mergeCombined(docJson, data, { selected: [current] });
    setMergePreview(null);
    onMerged(merged, 1);
    onClose();
  };

  const toggleExcluded = (i: number) => {
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  };

  const record = data.records[current];

  return (
    <Modal
      title="Publipostage"
      onClose={closeAndReset}
      wide
      footer={
        <>
          <Button variant="ghost" onClick={closeAndReset}>
            Fermer
          </Button>
          <Button variant="outline" onClick={mergeOne} disabled={!record}>
            Fusionner cet enregistrement
          </Button>
          <Button onClick={mergeAllRecords} disabled={!selected.length}>
            Fusionner {selected.length || ""} enregistrement{selected.length > 1 ? "s" : ""}
          </Button>
        </>
      }
    >
      <div className="settings">
        <section className="settings__section">
          <h3 className="settings__title">1. Source de données</h3>
          <div className="settings__row">
            <Button variant="outline" onClick={() => inputRef.current?.click()}>
              <Upload size={15} /> Fichier CSV / TSV
            </Button>
            {sourceName && (
              <span className="muted">
                {sourceName} — {data.records.length} enregistrement{data.records.length > 1 ? "s" : ""},{" "}
                {data.fields.length} colonne{data.fields.length > 1 ? "s" : ""}
              </span>
            )}
          </div>
          <input
            ref={inputRef}
            type="file"
            accept=".csv,.tsv,.txt"
            hidden
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) load(await f.text(), f.name);
            }}
          />
          <Field
            label="…ou collez les données"
            hint="Première ligne = noms de colonnes. Virgule, point-virgule ou tabulation."
          >
            <textarea
              className="settings__input"
              rows={3}
              value={pasted}
              onChange={(e) => setPasted(e.target.value)}
              placeholder={"Nom,Prénom,Ville\nDupont,Jean,Lyon"}
            />
          </Field>
          {pasted.trim() && (
            <Button variant="outline" size="sm" onClick={() => load(pasted, "données collées")}>
              Utiliser ces données
            </Button>
          )}
          {error && <Alert tone="danger">{error}</Alert>}
        </section>

        {data.fields.length > 0 && (
          <>
            <section className="settings__section">
              <h3 className="settings__title">2. Insérer des champs</h3>
              <p className="muted">
                Placez le curseur dans le document, puis cliquez un champ. Vous pouvez aussi écrire{" "}
                <code>{"{Nom}"}</code> directement dans le texte.
              </p>
              <div className="mm-fields">
                {data.fields.map((f) => (
                  <button
                    key={f}
                    type="button"
                    className={`mm-field ${used.some((u) => u.toLowerCase() === f.toLowerCase()) ? "is-used" : ""}`}
                    onClick={() => editor.chain().focus().insertMergeField(f).run()}
                    title={`Insérer «${f}»`}
                  >
                    «{f}»
                  </button>
                ))}
              </div>
              {missing.length > 0 && (
                <Alert tone="warning" title="Champs sans colonne">
                  {missing.join(", ")} — ces champs resteront vides à la fusion.
                </Alert>
              )}
            </section>

            <section className="settings__section">
              <h3 className="settings__title">3. Aperçu</h3>
              <div className="settings__row mm-nav">
                <Button variant="outline" size="sm" onClick={() => step(-1)} disabled={current === 0}>
                  <ChevronLeft size={15} />
                </Button>
                <span className="mm-nav__pos">
                  {current + 1} / {data.records.length}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => step(1)}
                  disabled={current >= data.records.length - 1}
                >
                  <ChevronRight size={15} />
                </Button>
                <Button
                  variant={previewing ? "primary" : "outline"}
                  size="sm"
                  onClick={() => applyPreview(!previewing)}
                >
                  {previewing ? <EyeOff size={15} /> : <Eye size={15} />}
                  {previewing ? " Masquer l'aperçu" : " Voir dans le document"}
                </Button>
                <label className="checkbox-row mm-nav__skip">
                  <input type="checkbox" checked={excluded.has(current)} onChange={() => toggleExcluded(current)} />
                  <span>Exclure de la fusion</span>
                </label>
              </div>
              {record && (
                <table className="mm-preview">
                  <tbody>
                    {data.fields.map((f) => (
                      <tr key={f}>
                        <th>{f}</th>
                        <td>{record[f] || <span className="muted">(vide)</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <p className="muted">
                <Users size={14} /> {recordLabel(record ?? {}, data.fields)}
                {excluded.size > 0 && ` · ${excluded.size} enregistrement(s) exclu(s)`}
              </p>
            </section>
          </>
        )}

        {!data.fields.length && !error && (
          <EmptyState
            icon={<Users size={22} />}
            title="Aucune source de données"
            hint="Chargez un CSV ou collez vos données pour commencer un publipostage."
          />
        )}
      </div>
    </Modal>
  );
}
