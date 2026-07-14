import type { EliumManifest } from "./types";

/**
 * The stable local key for a document, used to index everything keyed per-doc
 * on this machine (version history, Parapheur workflow, seal TOFU pinning).
 *
 * Prefers the unique `docId` (a UUID minted at creation). Files written before
 * `docId` existed fall back to `createdAt` — a soft migration: those legacy
 * documents keep their old key (second-precision `createdAt`, with its rare
 * same-second collision risk), while every new/re-saved document gets a
 * collision-free UUID.
 */
export function docKeyOf(manifest: Pick<EliumManifest, "docId" | "createdAt">): string {
  return manifest.docId ?? manifest.createdAt;
}
