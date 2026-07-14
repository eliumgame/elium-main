import { useCallback, useEffect, useState } from "react";
import type { Editor } from "@tiptap/react";
import { Save, RotateCcw, Trash2, Clock } from "lucide-react";
import { Button, EmptyState } from "../ui/components";
import { listVersions, saveVersion, deleteVersion, versionDoc, type DocumentVersion } from "../format/versions-store";
import { docKeyOf } from "../format/doc-key";
import type { Studio } from "../studio/types";
import { useDialogs } from "../ui/dialogs";

/**
 * Version history panel: manual snapshots of the document stored locally
 * (IndexedDB). Restoring first auto-snapshots the current state so it is never
 * lost. Distinct from the signed, immutable tracking journal.
 */
export default function VersionsPanel({ studio, editor }: { studio: Studio; editor: Editor | null }) {
  const docKey = docKeyOf(studio.file.manifest);
  const [versions, setVersions] = useState<DocumentVersion[]>([]);
  const [busy, setBusy] = useState(false);
  const { prompt, confirm, alert } = useDialogs();

  const reload = useCallback(() => {
    listVersions(docKey)
      .then(setVersions)
      .catch(() => setVersions([]));
  }, [docKey]);

  useEffect(() => {
    reload();
  }, [reload]);

  const snapshot = useCallback(
    async (label: string) => {
      setBusy(true);
      try {
        await saveVersion(docKey, label, studio.file.document.doc, new Date().toISOString(), studio.versionSecret);
        reload();
      } finally {
        setBusy(false);
      }
    },
    [docKey, studio, reload],
  );

  const onSnapshot = async () => {
    const label = await prompt({ title: "Enregistrer une version", label: "Nom de la version", placeholder: "ex. Avant relecture" });
    if (label === null) return;
    void snapshot(label.trim() || "Version sans nom");
  };

  const onRestore = async (v: DocumentVersion) => {
    if (!studio.editable || !editor) return;
    if (!(await confirm({ title: "Restaurer cette version ?", message: "L'état actuel sera d'abord enregistré comme version.", confirmLabel: "Restaurer" }))) return;
    let doc;
    try { doc = await versionDoc(v, studio.versionSecret); }
    catch { await alert({ title: "Restauration impossible", message: "Impossible de déchiffrer cette version (mot de passe du document requis)." }); return; }
    await saveVersion(docKey, "Avant restauration", studio.file.document.doc, new Date().toISOString(), studio.versionSecret);
    editor.commands.setContent(doc);
    studio.onDocChange(doc);
    reload();
  };

  const onDelete = async (v: DocumentVersion) => {
    if (v.id == null) return;
    if (!(await confirm({ title: "Supprimer la version", message: `Supprimer la version « ${v.label} » ?`, danger: true, confirmLabel: "Supprimer" }))) return;
    await deleteVersion(v.id);
    reload();
  };

  return (
    <div className="panel-section">
      <div className="panel-title-row">
        <h3 className="panel-title"><Clock size={16} /> Historique de versions</h3>
        {studio.editable && (
          <Button size="sm" variant="outline" onClick={onSnapshot} disabled={busy}>
            <Save size={14} /> Enregistrer
          </Button>
        )}
      </div>
      <p className="muted" style={{ marginBottom: 10 }}>
        Instantanés locaux du document (ce navigateur uniquement). Le journal de suivi reste l'historique
        immuable et signé qui voyage dans le fichier.
      </p>
      {versions.length === 0 ? (
        <EmptyState title="Aucune version enregistrée" hint="« Enregistrer » fige l'état actuel du document." />
      ) : (
        <ul className="version-list">
          {versions.map((v) => (
            <li key={v.id} className="version-item">
              <div className="version-item__main">
                <span className="version-item__label">{v.label}</span>
                <span className="version-item__date">{new Date(v.ts).toLocaleString("fr-FR")}</span>
              </div>
              <div className="version-item__actions">
                {studio.editable && (
                  <button className="icon-btn" title="Restaurer cette version" onClick={() => void onRestore(v)}>
                    <RotateCcw size={15} />
                  </button>
                )}
                <button className="icon-btn icon-btn--danger" title="Supprimer" onClick={() => void onDelete(v)}>
                  <Trash2 size={15} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
