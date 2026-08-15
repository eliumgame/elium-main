import { useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { GitCompareArrows, Upload } from "lucide-react";
import { Modal, Button, Alert } from "../ui/components";
import { compareDocuments, hasChanges, type CompareSummary } from "./compare";
import { docxToDoc } from "../format/docx";
import { importToDoc } from "../format/importers";
import { readEliumPackage, EliumPasswordRequired } from "../format/elium-package";
import type { ProseMirrorNode } from "../format/types";

type Direction = "openedIsRevision" | "openedIsOriginal";

interface Loaded {
  name: string;
  doc: ProseMirrorNode;
}

/**
 * Compare the open document with another file (Word's "Comparer").
 *
 * The result is ONE document whose differences ride on the normal track-changes
 * marks, so it lands in the review workflow that already exists: walk the
 * changes, accept or reject them with the Révision buttons.
 */
export default function CompareModal({
  editor,
  onApply,
  onClose,
}: {
  editor: Editor;
  /** Replaces the editor content with the merged, tracked document. */
  onApply: (doc: ProseMirrorNode, summary: CompareSummary) => void;
  onClose: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [direction, setDirection] = useState<Direction>("openedIsRevision");
  const [error, setError] = useState("");
  const [password, setPassword] = useState("");
  const [needsPassword, setNeedsPassword] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ doc: ProseMirrorNode; summary: CompareSummary } | null>(null);

  const readFile = async (file: File, pwd?: string): Promise<ProseMirrorNode> => {
    const lower = file.name.toLowerCase();
    if (lower.endsWith(".docx")) {
      return docxToDoc(new Uint8Array(await file.arrayBuffer())).doc;
    }
    if (lower.endsWith(".elium")) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const res = await readEliumPackage(bytes, pwd ? { password: pwd } : {});
      return res.file.document.doc;
    }
    return importToDoc(file.name, await file.text());
  };

  const pick = async (file: File | undefined, pwd?: string) => {
    if (!file) return;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const doc = await readFile(file, pwd);
      setLoaded({ name: file.name, doc });
      setNeedsPassword(null);
      setPassword("");
    } catch (e) {
      if (e instanceof EliumPasswordRequired) {
        setNeedsPassword(file);
        setError("Ce document est protégé : saisissez son mot de passe.");
      } else {
        setLoaded(null);
        setError(e instanceof Error ? e.message : "Impossible de lire ce fichier.");
      }
    } finally {
      setBusy(false);
    }
  };

  const run = () => {
    if (!loaded) return;
    const opened = editor.getJSON() as ProseMirrorNode;
    const [original, revised] = direction === "openedIsRevision" ? [loaded.doc, opened] : [opened, loaded.doc];
    setResult(compareDocuments(original, revised, { author: "Comparaison", ts: new Date().toISOString() }));
  };

  const summaryRows = (s: CompareSummary) => [
    { label: "Caractères ajoutés", value: s.insertions },
    { label: "Caractères supprimés", value: s.deletions },
    { label: "Blocs modifiés", value: s.blocksChanged },
    { label: "Blocs ajoutés", value: s.blocksAdded },
    { label: "Blocs supprimés", value: s.blocksRemoved },
  ];

  return (
    <Modal
      title="Comparer des documents"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Fermer
          </Button>
          {!result && (
            <Button onClick={run} disabled={!loaded || busy}>
              Comparer
            </Button>
          )}
          {result && (
            <Button
              onClick={() => {
                onApply(result.doc, result.summary);
                onClose();
              }}
              disabled={!hasChanges(result.summary)}
            >
              Appliquer comme suggestions
            </Button>
          )}
        </>
      }
    >
      <div className="settings">
        <section className="settings__section">
          <h3 className="settings__title">Document à comparer</h3>
          <div className="settings__row">
            <Button variant="outline" onClick={() => inputRef.current?.click()} disabled={busy}>
              <Upload size={15} /> Choisir un fichier
            </Button>
            {loaded && <span className="muted">{loaded.name}</span>}
          </div>
          <input
            ref={inputRef}
            type="file"
            accept=".elium,.docx,.txt,.md,.markdown,.html,.htm"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              void pick(f);
            }}
          />
          {needsPassword && (
            <div className="settings__row">
              <input
                className="settings__input"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Mot de passe du document"
              />
              <Button variant="outline" onClick={() => void pick(needsPassword, password)} disabled={!password || busy}>
                Déverrouiller
              </Button>
            </div>
          )}
          {error && <Alert tone={needsPassword ? "warning" : "danger"}>{error}</Alert>}
        </section>

        <section className="settings__section">
          <h3 className="settings__title">Sens de la comparaison</h3>
          <label className="checkbox-row">
            <input
              type="radio"
              name="cmp-dir"
              checked={direction === "openedIsRevision"}
              onChange={() => setDirection("openedIsRevision")}
            />
            <span>
              Le fichier choisi est l'<b>original</b>, le document ouvert la <b>révision</b>
            </span>
          </label>
          <label className="checkbox-row">
            <input
              type="radio"
              name="cmp-dir"
              checked={direction === "openedIsOriginal"}
              onChange={() => setDirection("openedIsOriginal")}
            />
            <span>
              Le document ouvert est l'<b>original</b>, le fichier choisi la <b>révision</b>
            </span>
          </label>
        </section>

        {result && (
          <section className="settings__section">
            <h3 className="settings__title">Résultat</h3>
            {!hasChanges(result.summary) ? (
              <Alert tone="success" title="Documents identiques">
                Aucune différence de contenu n'a été trouvée.
              </Alert>
            ) : (
              <>
                <ul className="cmp-summary">
                  {summaryRows(result.summary).map((r) => (
                    <li key={r.label}>
                      <span>{r.label}</span>
                      <b>{r.value}</b>
                    </li>
                  ))}
                </ul>
                {result.summary.structural > 0 && (
                  <Alert tone="info" title="Éléments structurels">
                    {result.summary.structural} élément(s) qu'aucune marque ne peut décrire (sauts de page ou de
                    section, tables générées) suivent la version révisée : ils ne sont pas proposés en suggestion.
                  </Alert>
                )}
                <p className="muted">
                  « Appliquer » remplace le contenu ouvert par le document fusionné, différences comprises. Utilisez
                  ensuite l'onglet Révision pour accepter ou refuser chaque modification.
                </p>
              </>
            )}
          </section>
        )}

        {!loaded && !error && (
          <section className="settings__section">
            <p className="muted">
              <GitCompareArrows size={14} /> Formats acceptés : <b>.elium</b>, <b>.docx</b>, <b>.md</b>, <b>.txt</b>,{" "}
              <b>.html</b>.
            </p>
          </section>
        )}
      </div>
    </Modal>
  );
}
