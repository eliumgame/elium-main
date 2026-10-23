/// <reference lib="webworker" />
/**
 * Worker d'import XLSX : exécute le lecteur en flux (xlsx-stream.ts) hors du fil
 * principal et lui renvoie des lots compacts (tableaux typés transférés, pas copiés).
 */
import { runStreamImport, type StreamMsg, type StreamOptions } from "./xlsx-stream";

const ctx = self as unknown as DedicatedWorkerGlobalScope;

function post(m: StreamMsg): void {
  const transfer: ArrayBuffer[] = [];
  if (m.type === "cells")
    transfer.push(
      m.rows.buffer as ArrayBuffer,
      m.cols.buffer as ArrayBuffer,
      m.styles.buffer as ArrayBuffer,
      m.kinds.buffer as ArrayBuffer,
    );
  else if (m.type === "meta") for (const v of Object.values(m.zip)) transfer.push(v.buffer as ArrayBuffer);
  ctx.postMessage(m, transfer);
}

ctx.onmessage = (ev: MessageEvent<{ bytes: Uint8Array; opts: StreamOptions }>) => {
  try {
    runStreamImport(ev.data.bytes, ev.data.opts, post);
    ctx.postMessage({ type: "done" });
  } catch (e) {
    ctx.postMessage({ type: "error", message: e instanceof Error ? e.message : String(e) });
  }
};
