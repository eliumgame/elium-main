/**
 * Orchestrates the plagiarism scan: pick passages (shingles.ts), fan them out
 * to a `SearchProvider` with bounded concurrency, and keep the results whose
 * snippet overlaps a passage above `similarityThreshold`. Cancellation via
 * `AbortSignal` is an expected user action, not a failure — an aborted scan
 * resolves with whatever was gathered so far instead of rejecting.
 */

import type { ParagraphModel, PlagiarismMatch, PlagiarismScanResult, SearchProvider } from "../types";
import { jaccardSimilarity, selectPassages, type SelectedPassage } from "./shingles";

export interface RunPlagiarismScanOptions {
  /** Passed through to `selectPassages`. Default 60. */
  maxQueries?: number;
  /** Minimum Jaccard similarity (0..1) for a search result to count as a match. Default 0.5. */
  similarityThreshold?: number;
  /** Max in-flight `provider.search()` calls at once. Default 3. */
  concurrency?: number;
  signal?: AbortSignal;
  onProgress?: (processed: number, total: number) => void;
}

const DEFAULT_MAX_QUERIES = 60;
const DEFAULT_SIMILARITY_THRESHOLD = 0.5;
const DEFAULT_CONCURRENCY = 3;
const SHINGLE_SIZE = 5;

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

export async function runPlagiarismScan(
  paragraphs: ParagraphModel[],
  provider: SearchProvider,
  opts: RunPlagiarismScanOptions = {},
): Promise<PlagiarismScanResult> {
  const maxQueries = opts.maxQueries ?? DEFAULT_MAX_QUERIES;
  const similarityThreshold = opts.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;
  const concurrency = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY);
  const signal = opts.signal;

  const passages = selectPassages(paragraphs, { maxQueries });
  const total = passages.length;
  const matches: PlagiarismMatch[] = [];
  let processed = 0;
  let failed = 0;
  let lastError: string | undefined;
  let aborted = signal?.aborted ?? false;

  const checkPassage = async (passage: SelectedPassage): Promise<void> => {
    try {
      const results = await provider.search(passage.text, signal);
      if (signal?.aborted) {
        aborted = true;
        return;
      }
      for (const result of results) {
        const similarity = jaccardSimilarity(passage.text, result.snippet, SHINGLE_SIZE);
        if (similarity >= similarityThreshold) {
          matches.push({
            paragraphIndex: passage.paragraphIndex,
            passage: passage.text,
            url: result.url,
            sourceTitle: result.title,
            similarity,
          });
        }
      }
    } catch (err) {
      if (signal?.aborted || isAbortError(err)) {
        aborted = true;
      } else {
        // A non-abort failure (rate limit, transient network error, invalid
        // key) only drops this one passage — the rest of the scan still runs
        // — but it's tracked so the caller can tell "verified clean" apart
        // from "couldn't verify".
        failed++;
        lastError = err instanceof Error ? err.message : String(err);
      }
    } finally {
      processed++;
      opts.onProgress?.(processed, total);
    }
  };

  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (!aborted && !signal?.aborted && nextIndex < passages.length) {
      const passage = passages[nextIndex++];
      await checkPassage(passage);
    }
  };

  const workerCount = Math.min(concurrency, passages.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return {
    checkedPassages: processed,
    failedPassages: failed,
    ...(lastError != null && { lastError }),
    matches,
    provider: provider.name,
  };
}
