/**
 * Concrete `SearchProvider` adapters for the plagiarism scanner. Both use the
 * global `fetch` (no new dependency) and forward the caller's `AbortSignal`
 * so a scan can be cancelled mid-flight. Neither ever puts the API key in a
 * thrown message, a log line, or any other string — only the HTTP status
 * code is surfaced on failure.
 */

import type { SearchProvider, SearchResult } from "../types";

function apiErrorMessage(providerLabel: string, status: number): string {
  if (status === 401 || status === 403 || status === 429) {
    return `Clé API invalide ou quota dépassé (${providerLabel})`;
  }
  return `Échec de la recherche (${providerLabel}) : le service a répondu avec le code ${status}`;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** https://serper.dev — Google search results via a simple JSON API. */
export function createSerperProvider(apiKey: string): SearchProvider {
  return {
    name: "Serper (Google)",
    async search(query: string, signal?: AbortSignal): Promise<SearchResult[]> {
      const response = await fetch("https://google.serper.dev/search", {
        method: "POST",
        headers: {
          "X-API-KEY": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ q: query }),
        signal,
      });
      if (!response.ok) throw new Error(apiErrorMessage("Serper", response.status));

      const data = await response.json();
      const organic = Array.isArray(data?.organic) ? data.organic : [];
      return organic.map(
        (item: Record<string, unknown>): SearchResult => ({
          title: asString(item?.title),
          url: asString(item?.link),
          snippet: asString(item?.snippet),
        }),
      );
    },
  };
}

/** https://www.microsoft.com/en-us/bing/apis/bing-web-search-api */
export function createBingProvider(apiKey: string): SearchProvider {
  return {
    name: "Bing",
    async search(query: string, signal?: AbortSignal): Promise<SearchResult[]> {
      const url = `https://api.bing.microsoft.com/v7.0/search?q=${encodeURIComponent(query)}`;
      const response = await fetch(url, {
        headers: { "Ocp-Apim-Subscription-Key": apiKey },
        signal,
      });
      if (!response.ok) throw new Error(apiErrorMessage("Bing", response.status));

      const data = await response.json();
      const items = Array.isArray(data?.webPages?.value) ? data.webPages.value : [];
      return items.map(
        (item: Record<string, unknown>): SearchResult => ({
          title: asString(item?.name),
          url: asString(item?.url),
          snippet: asString(item?.snippet),
        }),
      );
    },
  };
}
