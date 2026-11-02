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
  inspectBackupFile,
  recallBackupFile,
  regrantBackupFile,
  writeBackupFile,
  type BackupComparison,
} from "../file-sync";
import type { PassportData } from "../types";

const WRITE_DELAY_MS = 2000;

type State =
  | { kind: "idle" | "checking" | "ok" | "needs-permission" | "error"; message?: string; at?: string }
  | { kind: "conflict"; cmp: Extract<BackupComparison, { kind: "differs" | "unreadable" }> };

const fmt = (iso: string) => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? "date inconnue" : new Date(t).toLocaleString("fr-FR");
};

interface Props {
  data: PassportData;
  /** Reprend la version du fichier (mêmes règles qu'un import : les annexes de ce poste sont gardées). */
  onAdopt: (next: PassportData) => Promise<void>;
}

export default function FileSyncSection({ data, onAdopt }: Props) {
  const supported = fileSyncSupported();
  const [handle, setHandle] = useState<FsFileHandle | null>(null);
  const [state, setState] = useState<State>({ kind: "idle" });
  const dataRef = useRef(data);
  dataRef.current = data;
  const lastWritten = useRef<string>("");
  /** Poignée dont le contenu a été vérifié dans cette session : seule elle peut être réécrite automatiquement. */
  const verified = useRef<FsFileHandle | null>(null);

  const fail = useCallback((source: string, e: unknown) => {
    reportError(`passeport.file.${source}`, e);
    setState({ kind: "error", message: e instanceof Error ? e.message : String(e) });
  }, []);

  const write = useCallback(
    async (h: FsFileHandle) => {
      try {
        const d = dataRef.current;
        await writeBackupFile(h, d);
        lastWritten.current = d.updatedAt;
        verified.current = h;
        setState({ kind: "ok", at: new Date().toISOString() });
      } catch (e) {
        fail("write", e);
      }
    },
    [fail],
  );

  /**
   * Avant la première écriture : relit le fichier. Vide → on l'écrit ; identique → rien à faire ; différent ou
   * illisible → conflit, l'utilisateur choisit (jamais d'écrasement silencieux d'une version d'un autre poste).
   */
  const verifyThenWrite = useCallback(
    async (h: FsFileHandle) => {
      verified.current = null;
      setState({ kind: "checking" });
      try {
        const cmp = await inspectBackupFile(h, dataRef.current);
        if (cmp.kind === "empty") return void (await write(h));
        if (cmp.kind === "same") {
          lastWritten.current = dataRef.current.updatedAt;
          verified.current = h;
          setState({ kind: "ok" });
          return;
        }
        setState({ kind: "conflict", cmp });
      } catch (e) {
        fail("read", e);
      }
    },
    [write, fail],
  );

  // Retrouve le fichier choisi lors d'une session précédente, et le compare avant toute écriture.
  useEffect(() => {
    if (!supported) return;
    let cancelled = false;
    void recallBackupFile()
      .then(async (h) => {
        if (cancelled || !h) return;
        setHandle(h);
        if (!(await canWriteSilently(h))) setState({ kind: "needs-permission" });
        else if (!cancelled) await verifyThenWrite(h);
      })
      .catch((e: unknown) => fail("recall", e));
    return () => {
      cancelled = true;
    };
  }, [supported, verifyThenWrite, fail]);

  // Écriture différée après chaque modification — seulement vers un fichier vérifié dans cette session.
  useEffect(() => {
    if (!handle || verified.current !== handle || state.kind === "needs-permission" || state.kind === "conflict")
      return;
    if (lastWritten.current === data.updatedAt) return;
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
      await verifyThenWrite(h);
    } catch (e) {
      fail("choose", e);
    }
  };

  const regrant = async () => {
    if (!handle) return;
    if (await regrantBackupFile(handle)) await verifyThenWrite(handle);
    else setState({ kind: "needs-permission", message: "Autorisation refusée." });
  };

  const adoptFile = async (next: PassportData) => {
    if (!handle) return;
    try {
      await onAdopt(next);
      // Le passeport repris porte une nouvelle date : l'écriture automatique suivante y recopiera cette version.
      verified.current = handle;
      setState({ kind: "ok" });
    } catch (e) {
      fail("adopt", e);
    }
  };

  const stop = async () => {
    await forgetBackupFile().catch((e: unknown) => reportError("passeport.file.forget", e));
    verified.current = null;
    setHandle(null);
    setState({ kind: "idle" });
  };

  const conflict = state.kind === "conflict" ? state.cmp : null;

  return (
    <section className="pp-card">
      <h3>
        <HardDrive size={18} aria-hidden="true" /> Sauvegarde automatique sur ce PC
      </h3>
      <p className="pp-note">
        Choisissez un fichier (idéalement dans un dossier synchronisé ou sur une clé USB) : Elium le réécrit à chaque
        modification. À l'ouverture, le fichier est relu : s'il contient une autre version (modifiée depuis un autre
        poste), Elium vous demande laquelle garder. Le fichier est lisible par tout programme et n'est pas chiffré —
        gardez-le dans un endroit privé.
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
              {state.kind === "checking" ? " — vérification…" : ""}
              {state.kind === "ok" && state.at
                ? ` — enregistré à ${new Date(state.at).toLocaleTimeString("fr-FR")}.`
                : state.kind === "ok"
                  ? " — à jour."
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
          {conflict?.kind === "differs" && (
            <Alert tone="warning" title="Le fichier contient une autre version du passeport">
              Fichier : modifié le {fmt(conflict.fileData.updatedAt)}
              {conflict.newer === "file" ? " (plus récent)" : ""}. Ce poste : modifié le {fmt(data.updatedAt)}
              {conflict.newer === "local" ? " (plus récent)" : ""}. La sauvegarde automatique est suspendue jusqu'à
              votre choix ; rien n'a été écrasé.
              <div className="pp-actions">
                <Button
                  size="sm"
                  variant={conflict.newer === "local" ? "outline" : undefined}
                  onClick={() => void adoptFile(conflict.fileData)}
                >
                  Reprendre la version du fichier
                </Button>
                <Button
                  size="sm"
                  variant={conflict.newer === "local" ? undefined : "danger"}
                  onClick={() => handle && void write(handle)}
                >
                  Écraser le fichier avec ce poste
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void stop()}>
                  Désactiver
                </Button>
              </div>
            </Alert>
          )}
          {conflict?.kind === "unreadable" && (
            <Alert tone="warning" title="Ce fichier n'est pas une sauvegarde de passeport">
              Son contenu n'a pas été reconnu ; il n'a pas été modifié. Choisissez un autre fichier, ou remplacez-le.
              <div className="pp-actions">
                <Button size="sm" variant="outline" onClick={() => void choose()}>
                  Choisir un autre fichier
                </Button>
                <Button size="sm" variant="danger" onClick={() => handle && void write(handle)}>
                  Remplacer son contenu
                </Button>
              </div>
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
