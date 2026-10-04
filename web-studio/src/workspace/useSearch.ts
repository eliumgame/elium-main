/**
 * Hook de recherche : possède l'index en mémoire et l'indexeur incrémental,
 * relance la synchronisation (par petits morceaux, quand le navigateur est
 * disponible) à chaque évolution du catalogue, et expose `search`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { VaultSecret } from "../crypto/local-vault";
import { WORKSPACE_SPEC } from "../format/db-specs";
import { reportError } from "../ui/crash-log";
import { idbKv } from "./kv";
import { descendantFolderIds } from "./model";
import type { WorkFolder, WorkItem } from "./types";
import { extractItemText } from "./search/extract";
import { SearchIndex } from "./search/index";
import { SearchIndexer, type IndexProgress, type IndexRecord } from "./search/indexer";
import { runSearch, type SearchFilters, type SearchResult } from "./search/query";

function idle(): Promise<void> {
  return new Promise((resolve) => {
    const w = globalThis as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void };
    if (typeof w.requestIdleCallback === "function") w.requestIdleCallback(() => resolve(), { timeout: 250 });
    else setTimeout(resolve, 16);
  });
}

export interface SearchApi {
  progress: IndexProgress;
  /** Version de l'index : change quand des éléments sont (ré)indexés, pour relancer l'affichage. */
  version: number;
  search: (query: string, filters: SearchFilters) => SearchResult[];
  /** Nombre d'éléments actuellement indexés. */
  indexedCount: number;
  /** Vide l'index et le reconstruit entièrement. */
  rebuild: () => void;
}

export function useSearch(opts: {
  items: WorkItem[];
  folders: WorkFolder[];
  vaultSecret: VaultSecret | undefined;
  /** Le catalogue est chargé et le coffre résolu. */
  enabled: boolean;
}): SearchApi {
  const secretRef = useRef(opts.vaultSecret);
  secretRef.current = opts.vaultSecret;
  const [progress, setProgress] = useState<IndexProgress>({ running: false, done: 0, total: 0 });
  const [version, setVersion] = useState(0);

  const { index, indexer } = useMemo(() => {
    const index = new SearchIndex();
    const indexer = new SearchIndexer({
      store: idbKv<IndexRecord>(WORKSPACE_SPEC, "search"),
      index,
      getSecret: () => secretRef.current,
      yieldNow: idle,
      extract: (item) => extractItemText(item, secretRef.current),
      onProgress: (p) => {
        setProgress(p);
        if (!p.running || p.done % 10 === 0) setVersion((v) => v + 1);
      },
      onError: (item, err) => reportError(`search-index:${item.contentStore}`, err),
    });
    return { index, indexer };
  }, []);

  // Le coffre change (activé, modifié, désactivé) : l'index, donnée dérivée, est vidé puis reconstruit.
  const secretKey = opts.vaultSecret?.password ?? "";
  const lastSecret = useRef<string | null>(null);
  const itemsRef = useRef(opts.items);
  itemsRef.current = opts.items;

  useEffect(() => {
    if (!opts.enabled) return;
    let alive = true;
    const run = async () => {
      try {
        if (lastSecret.current !== null && lastSecret.current !== secretKey) await indexer.reset();
        lastSecret.current = secretKey;
        await indexer.sync(itemsRef.current);
        if (alive) setVersion((v) => v + 1);
      } catch (e) {
        reportError("search-sync", e);
      }
    };
    // Regroupe les rafales de modifications (autosave) avant de resynchroniser.
    const timer = setTimeout(() => void run(), 1200);
    return () => {
      alive = false;
      clearTimeout(timer);
      indexer.cancel();
    };
  }, [opts.enabled, opts.items, secretKey, indexer]);

  const search = useCallback(
    (query: string, filters: SearchFilters): SearchResult[] => {
      const scope =
        filters.includeSubfolders && filters.folderId
          ? new Set([filters.folderId, ...descendantFolderIds(opts.folders, filters.folderId)])
          : undefined;
      return runSearch(index, opts.items, query, filters, scope);
    },
    // `version` relance le calcul quand l'index évolue.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [index, opts.items, opts.folders, version],
  );

  const rebuild = useCallback(() => {
    void (async () => {
      try {
        await indexer.reset();
        await indexer.sync(itemsRef.current);
        setVersion((v) => v + 1);
      } catch (e) {
        reportError("search-rebuild", e);
      }
    })();
  }, [indexer]);

  return { progress, version, search, indexedCount: index.size, rebuild };
}
