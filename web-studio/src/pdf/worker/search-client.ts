import { runWorkerTask, WorkerTimeoutError } from "../../workers/worker-task";
import { search, type SearchHit, type SearchOptions } from "../core/search";

export interface SearchRequest {
  pageTexts: string[];
  query: string;
  opts: SearchOptions;
}

/** Une regex qui met plus longtemps est jugée catastrophique (ex. `(a+)+$`) : le Worker est terminé. */
export const REGEX_SEARCH_TIMEOUT_MS = 2500;

export class RegexTooComplexError extends Error {
  override name = "RegexTooComplexError";
  constructor() {
    super("Ce motif d'expression régulière est trop complexe : la recherche a été interrompue. Simplifiez-le.");
  }
}

/**
 * `search`, sans jamais figer l'interface : la recherche littérale (linéaire) reste en ligne ; une
 * expression régulière, dont le temps n'est pas borné, tourne dans un Worker terminé au-delà de
 * REGEX_SEARCH_TIMEOUT_MS (rejette alors avec RegexTooComplexError).
 */
export async function searchAsync(
  pageTexts: readonly string[],
  query: string,
  opts: SearchOptions,
  signal?: AbortSignal,
): Promise<SearchHit[]> {
  if (!opts.regex) return search(pageTexts, query, opts);
  const request: SearchRequest = { pageTexts: [...pageTexts], query, opts };
  try {
    return await runWorkerTask<SearchRequest, SearchHit[]>({
      create: () => new Worker(new URL("./search.worker.ts", import.meta.url), { type: "module" }),
      request,
      inline: (r) => search(r.pageTexts, r.query, r.opts),
      signal,
      timeoutMs: REGEX_SEARCH_TIMEOUT_MS,
    });
  } catch (e) {
    if (e instanceof WorkerTimeoutError) throw new RegexTooComplexError();
    throw e;
  }
}
