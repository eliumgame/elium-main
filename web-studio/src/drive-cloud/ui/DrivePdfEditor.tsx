/**
 * A PDF of the encrypted Drive, opened in the PDF module: decrypted here, and
 * each « Enregistrer » encrypts and uploads a new version of the same file
 * (the Drive keeps the earlier ones in its history). No real-time co-editing:
 * if the file changed in the Drive since it was opened, the save asks first.
 */
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Loader } from "lucide-react";
import { DriveConflict, downloadFile, saveNewVersion, type DriveEntry, type OpsCtx } from "../ops";
import { driveDestination, type SaveDestination } from "../../pdf/core/destination";
import { useDialogs } from "../../ui/dialogs";

const PdfWorkspace = lazy(() => import("../../pdf/ui/PdfWorkspace"));

interface Props {
  ctx: OpsCtx;
  entry: DriveEntry;
  author?: string;
  onClose: () => void;
  /** After a save: the listing shows the new size and date. */
  onSaved?: () => void;
}

export default function DrivePdfEditor({ ctx, entry, author, onClose, onSaved }: Props) {
  const dialogs = useDialogs();
  const [source, setSource] = useState<{ bytes: Uint8Array; name: string; destination: SaveDestination } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  // The version the session is based on: a save over a newer one asks first.
  const base = useRef(entry.modifiedAt);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const { bytes, name } = await downloadFile(ctx, entry);
        if (!alive) return;
        let force = false;
        const destination = driveDestination({
          name,
          async prepare() {
            force = false;
            const { node } = await ctx.api.getNode(entry.id);
            if (node.modifiedAt === base.current) return true;
            force = await dialogs.confirm({
              title: "Fichier modifié dans le Drive",
              message:
                `« ${name} » a été modifié dans le Drive depuis son ouverture. ` +
                "Enregistrer quand même ? La version actuelle restera dans l'historique des versions.",
              confirmLabel: "Enregistrer quand même",
            });
            return force;
          },
          async write(out) {
            try {
              const node = await saveNewVersion(ctx, entry.id, out, { expectedModifiedAt: base.current, force });
              base.current = node.modifiedAt;
              onSaved?.();
            } catch (e) {
              if (e instanceof DriveConflict) throw new Error(e.message + " Enregistrez de nouveau pour la remplacer.");
              throw e;
            }
          },
        });
        setSource({ bytes, name, destination });
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : "Fichier illisible.");
      }
    })();
    return () => {
      alive = false;
    };
    // Opened once per file.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.id]);

  const loading = (
    <div className="dc-pdf__loading">
      <Loader size={18} className="dc-spin" /> Déchiffrement — {entry.name}
    </div>
  );

  return (
    <div className="dc-modal-overlay dc-modal-overlay--full" role="region" aria-label={`PDF — ${entry.name}`}>
      <div className="dc-doc dc-doc--fullscreen dc-pdf">
        {error ? (
          <div className="dc-pdf__loading">
            <p>Ouverture impossible : {error}</p>
            <button className="eb eb--outline eb--md" onClick={onClose}>
              Fermer
            </button>
          </div>
        ) : !source ? (
          loading
        ) : (
          <Suspense fallback={loading}>
            <PdfWorkspace onHome={onClose} author={author} source={source} />
          </Suspense>
        )}
      </div>
    </div>
  );
}
