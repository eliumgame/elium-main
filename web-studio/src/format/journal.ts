/**
 * Tracking journal — a hash-chained, append-only event log embedded in the
 * `.elium` file. Any tampering with a past event breaks the chain and is
 * detected by `verifyJournal`.
 *
 * Each event's hash = sha256( prevHash + canonicalJSON(payload) ) where
 * payload = { seq, type, at, [actor], [data] } (optional keys omitted when
 * absent, so the encoding matches the Python implementation byte-for-byte).
 */

import { canonicalJSON, sha256Hex, ZERO_HASH, nowIso } from "./canonical";
import type { Journal, JournalEvent, JournalEventType } from "./types";

export function emptyJournal(): Journal {
  return { version: 1, events: [] };
}

interface AppendOptions {
  actor?: { name?: string; fingerprint?: string };
  data?: Record<string, unknown>;
  at?: string;
}

function buildPayload(seq: number, type: JournalEventType, at: string, opts: AppendOptions) {
  const payload: Record<string, unknown> = { seq, type, at };
  if (opts.actor && Object.keys(opts.actor).length) payload.actor = opts.actor;
  if (opts.data && Object.keys(opts.data).length) payload.data = opts.data;
  return payload;
}

export async function appendEvent(
  journal: Journal,
  type: JournalEventType,
  opts: AppendOptions = {},
): Promise<Journal> {
  const seq = journal.events.length;
  const prevHash = seq === 0 ? ZERO_HASH : journal.events[seq - 1].hash;
  const at = opts.at ?? nowIso();
  const payload = buildPayload(seq, type, at, opts);
  const hash = await sha256Hex(prevHash + canonicalJSON(payload));

  const event: JournalEvent = {
    seq,
    type,
    at,
    ...(payload.actor ? { actor: payload.actor as JournalEvent["actor"] } : {}),
    ...(payload.data ? { data: payload.data as Record<string, unknown> } : {}),
    prevHash,
    hash,
  };
  return { ...journal, events: [...journal.events, event] };
}

export interface JournalVerdict {
  valid: boolean;
  /** Index of the first event whose hash/chain is inconsistent, if any. */
  brokenAt: number | null;
  count: number;
}

export async function verifyJournal(journal: Journal): Promise<JournalVerdict> {
  let prevHash = ZERO_HASH;
  for (let i = 0; i < journal.events.length; i++) {
    const e = journal.events[i];
    if (e.seq !== i || e.prevHash !== prevHash) {
      return { valid: false, brokenAt: i, count: journal.events.length };
    }
    const payload = buildPayload(e.seq, e.type, e.at, { actor: e.actor, data: e.data });
    const expected = await sha256Hex(prevHash + canonicalJSON(payload));
    if (expected !== e.hash) {
      return { valid: false, brokenAt: i, count: journal.events.length };
    }
    prevHash = e.hash;
  }
  return { valid: true, brokenAt: null, count: journal.events.length };
}

const LABELS: Record<JournalEventType, string> = {
  "document.created": "Création du document",
  "document.modified": "Modification importante",
  "signature.added": "Ajout d'une signature",
  "signature.validated": "Validation d'une signature",
  "protection.enabled": "Activation d'une protection",
  "document.locked": "Verrouillage final",
  export: "Export",
  "document.opened": "Ouverture locale",
};

export function eventLabel(type: JournalEventType): string {
  return LABELS[type] ?? type;
}
