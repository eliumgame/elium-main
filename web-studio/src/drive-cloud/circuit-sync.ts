/**
 * Persisted "circuit not yet synced" marker for the Parapheur↔cloud-sign-link
 * bridge (see `ops.ts#reconcileCircuitForSignRequest` /
 * `format/document.ts#alignCircuitWithRequest`).
 *
 * Before this, a failure to align the document's embedded circuit with a
 * freshly-created sign request was a purely EPHEMERAL, component-local React
 * warning (`SignRequestDialog`'s `syncWarning`): close the dialog, reopen the
 * app, refresh the page — and the fact that the bridge never ran is gone
 * without a trace, even though the sign request (and later, a remote
 * signature) keeps existing server-side regardless. This module makes that
 * "not yet synced" state survive exactly like the sign request itself does —
 * local-only (localStorage), keyed by node id, so the dialog can show a
 * persistent, un-missable banner and retry, instead of a warning that can be
 * missed once and then never seen again.
 *
 * This is UI bookkeeping ONLY: it never becomes a second source of truth
 * about signatures. The server's `signature_request_parties` and the
 * `.elium`'s embedded `parapheur.parties` remain the only two, and this
 * marker is cleared the moment a (re)sync actually succeeds.
 */
const STORAGE_KEY = "elium_drive_circuit_sync_v1";

export interface PendingCircuitSync {
  parties: { partyId: string; label?: string }[];
  /** ISO timestamp of the most recent failed attempt. */
  failedAt: string;
  lastError: string;
  attempts: number;
}

type Store = Record<string, PendingCircuitSync>; // nodeId -> pending sync

function readAll(): Store {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Store) : {};
  } catch {
    return {};
  }
}

function writeAll(store: Store): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    /* best effort — private window / full quota just means this marker won't persist */
  }
}

/** Is there a circuit sync for this node that failed and hasn't succeeded since? */
export function getPendingCircuitSync(nodeId: string): PendingCircuitSync | null {
  return readAll()[nodeId] ?? null;
}

/** Record (or bump the attempt count of) a failed circuit sync for this node. */
export function setPendingCircuitSync(
  nodeId: string,
  parties: { partyId: string; label?: string }[],
  error: string,
): void {
  const store = readAll();
  const prevAttempts = store[nodeId]?.attempts ?? 0;
  store[nodeId] = { parties, failedAt: new Date().toISOString(), lastError: error, attempts: prevAttempts + 1 };
  writeAll(store);
}

/** Clear the marker for this node — call once a (re)sync actually succeeds. */
export function clearPendingCircuitSync(nodeId: string): void {
  const store = readAll();
  if (!(nodeId in store)) return;
  delete store[nodeId];
  writeAll(store);
}
