/**
 * Hook React de l'espace de travail : charge le catalogue, expose les actions
 * (renommer, déplacer, corbeille…) en rafraîchissant l'état, et lance au
 * démarrage l'import de l'ancien contenu « current », la réconciliation et la
 * purge de la corbeille. Une seule instance, créée par App.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { VaultSecret } from "../crypto/local-vault";
import { reportError } from "../ui/crash-log";
import { createWorkspaceService } from "./content";
import type { RegisterInput, WorkspaceService } from "./service";
import type { Catalog } from "./catalog";
import type { WorkFolder, WorkItem } from "./types";

export interface WorkspaceApi {
  /** Le catalogue est chargé (import/réconciliation terminés). */
  ready: boolean;
  items: WorkItem[];
  folders: WorkFolder[];
  service: WorkspaceService;
  catalog: Catalog;
  currentFolderId: string | null;
  setCurrentFolderId: (id: string | null) => void;
  refresh: () => Promise<void>;
  /** Enregistre/actualise un élément après sauvegarde de son contenu (silencieux, journalise ses erreurs). */
  registerSaved: (input: RegisterInput, options?: { updateTitle?: boolean }) => Promise<void>;
  touchOpened: (id: string) => void;
  /** Exécute une action du service puis rafraîchit ; une erreur est journalisée ET remontée (jamais avalée). */
  run: <T>(label: string, fn: (s: WorkspaceService) => Promise<T>) => Promise<T | undefined>;
}

export function useWorkspace(opts: {
  vaultSecret: VaultSecret | undefined;
  /** Faux tant que l'état du coffre n'est pas résolu (« checking » / « locked »). */
  enabled: boolean;
  onError: (message: string) => void;
}): WorkspaceApi {
  const secretRef = useRef(opts.vaultSecret);
  secretRef.current = opts.vaultSecret;
  const folderRef = useRef<string | null>(null);
  const onErrorRef = useRef(opts.onError);
  onErrorRef.current = opts.onError;

  const { service, catalog } = useMemo(
    () =>
      createWorkspaceService(
        () => secretRef.current,
        () => folderRef.current,
      ),
    [],
  );

  const [items, setItems] = useState<WorkItem[]>([]);
  const [folders, setFolders] = useState<WorkFolder[]>([]);
  const [ready, setReady] = useState(false);
  const [currentFolderId, setCurrentFolderIdState] = useState<string | null>(null);

  const setCurrentFolderId = useCallback((id: string | null) => {
    folderRef.current = id;
    setCurrentFolderIdState(id);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const data = await service.load();
      setItems(data.items);
      setFolders(data.folders);
      // Le dossier courant a pu disparaître (corbeille, suppression) : retour à la racine.
      const cur = folderRef.current;
      if (cur && !data.folders.some((f) => f.id === cur && !f.trashedAt)) {
        folderRef.current = null;
        setCurrentFolderIdState(null);
      }
    } catch (e) {
      reportError("workspace-load", e);
      onErrorRef.current(e instanceof Error ? e.message : String(e));
    }
  }, [service]);

  // Démarrage (et à chaque changement d'état du coffre qui change le secret : le catalogue se relit).
  const secretKey = opts.vaultSecret?.password ?? "";
  useEffect(() => {
    if (!opts.enabled) return;
    let alive = true;
    void (async () => {
      try {
        await service.importLegacy();
        await service.reconcile();
        await service.purgeExpired();
      } catch (e) {
        reportError("workspace-startup", e);
        onErrorRef.current(e instanceof Error ? e.message : String(e));
      }
      if (!alive) return;
      await refresh();
      if (alive) setReady(true);
    })();
    return () => {
      alive = false;
    };
  }, [opts.enabled, secretKey, service, refresh]);

  const run = useCallback(
    async <T>(label: string, fn: (s: WorkspaceService) => Promise<T>): Promise<T | undefined> => {
      try {
        const out = await fn(service);
        await refresh();
        return out;
      } catch (e) {
        reportError(label, e);
        onErrorRef.current(e instanceof Error ? e.message : String(e));
        await refresh();
        return undefined;
      }
    },
    [service, refresh],
  );

  const registerSaved = useCallback(
    async (input: RegisterInput, options?: { updateTitle?: boolean }) => {
      try {
        await service.registerSaved(input, options);
        await refresh();
      } catch (e) {
        reportError("workspace-register", e);
      }
    },
    [service, refresh],
  );

  const touchOpened = useCallback(
    (id: string) => {
      void service
        .touchOpened(id)
        .then(refresh)
        .catch((e) => reportError("workspace-touch", e));
    },
    [service, refresh],
  );

  return {
    ready,
    items,
    folders,
    service,
    catalog,
    currentFolderId,
    setCurrentFolderId,
    refresh,
    registerSaved,
    touchOpened,
    run,
  };
}
