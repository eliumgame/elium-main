/** Sauvegarde automatique dans un fichier du PC (application de bureau, navigateurs Chromium). */
import { useCallback, useEffect, useRef, useState } from "react";
import { HardDrive } from "lucide-react";
import { Alert, Button } from "../../ui/components";
import { reportError } from "../../ui/crash-log";
import type { FsFileHandle } from "../../workspace/fs-access";
import {
  canWriteSilently,
  chooseBackupFile,
  fileSyncSupported,
  forgetBackupFile,
  recallBackupFile,
  regrantBackupFile,
  writeBackupFile,
} from "../file-sync";
import type { PassportData } from "../types";

const WRITE_DELAY_MS = 2000;

type State = { kind: "idle" | "ok" | "needs-permission" | "error"; message?: string; at?: string };

export default function FileSyncSection({ data }: { data: PassportData }) {
  const supported = fileSyncSupported();
  const [handle, setHandle] = useState<FsFileHandle | null>(null);
  const [state, setState] = useState<State>({ kind: "idle" });
  const dataRef = useRef(data);
  dataRef.current = data;
  const lastWritten = useRef<string>("");

  const write = useCallback(async (h: FsFileHandle) => {
    try {
      const d = dataRef.current;
      await writeBackupFile(h, d);
      lastWritten.current = d.updatedAt;
      setState({ kind: "ok", at: new Date().toISOString() });
    } catch (e) {
      reportError("passeport.file.write", e);
      setState({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  // Retrouve le fichier choisi lors d'une session précédente.
  useEffect(() => {
    if (!supported) return;
    let cancelled = false;
    void recallBackupFile().then(async (h) => {
      if (cancelled || !h) return;
      setHandle(h);
      if (!(await canWriteSilently(h))) setState({ kind: "needs-permission" });
    });
    return () => {
      cancelled = true;
    };
  }, [supported]);

  // Écriture différée après chaque modification.
  useEffect(() => {
    if (!handle || state.kind === "needs-permission" || lastWritten.current === data.updatedAt) return;
    const id = setTimeout(() => {
      void canWriteSilently(handle).then((ok) => (ok ? write(handle) : setState({ kind: "needs-permission" })));
    }, WRITE_DELAY_MS);
    return () => clearTimeout(id);
  }, [data.updatedAt, handle, state.kind, write]);

  const choose = async () => {
    try {
      const h = await chooseBackupFile(dataRef.current);
      if (!h) return;
      setHandle(h);
      await write(h);
    } catch (e) {
      reportError("passeport.file.choose", e);
      setState({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  };

  const regrant = async () => {
    if (!handle) return;
    if (await regrantBackupFile(handle)) await write(handle);
    else setState({ kind: "needs-permission", message: "Autorisation refusée." });
  };

  const stop = async () => {
    await forgetBackupFile();
    setHandle(null);
    setState({ kind: "idle" });
  };

  return (
    <section className="pp-card">
      <h3>
        <HardDrive size={18} aria-hidden="true" /> Sauvegarde automatique sur ce PC
      </h3>
      <p className="pp-note">
        Choisissez un fichier (idéalement dans un dossier synchronisé ou sur une clé USB) : Elium le réécrit à chaque
        modification. Le fichier est lisible par tout programme et n'est pas chiffré — gardez-le dans un endroit privé.
      </p>
      {!supported ? (
        <Alert tone="info">
          Ce navigateur ne permet pas d'écrire dans un fichier de votre choix : utilisez « Exporter une sauvegarde » ou
          la sauvegarde sur le serveur.
        </Alert>
      ) : (
        <>
          {handle ? (
            <p className="pp-note">
              Fichier : <b>{handle.name}</b>
              {state.kind === "ok" && state.at
                ? ` — enregistré à ${new Date(state.at).toLocaleTimeString("fr-FR")}.`
                : ""}
            </p>
          ) : (
            <p className="pp-note">Aucun fichier choisi : la sauvegarde automatique est désactivée.</p>
          )}
          {state.kind === "needs-permission" && (
            <Alert tone="warning">
              {state.message ?? "Le navigateur demande de confirmer l'accès au fichier après un redémarrage."}{" "}
              <Button size="sm" onClick={() => void regrant()}>
                Réactiver la sauvegarde
              </Button>
            </Alert>
          )}
          {state.kind === "error" && <Alert tone="danger">{state.message}</Alert>}
          <div className="pp-actions">
            <Button variant="outline" onClick={() => void choose()}>
              {handle ? "Changer de fichier" : "Choisir le fichier de sauvegarde"}
            </Button>
            {handle && (
              <Button variant="ghost" onClick={() => void stop()}>
                Désactiver
              </Button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
