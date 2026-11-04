import { Awareness, applyAwarenessUpdate } from "y-protocols/awareness";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { record, int, str, cellRef } from "./collab-decode";
import { colorForId } from "./presence-colors";

const relativePosition = (v: unknown): boolean => record(v) &&
  (v.tname == null || str(v.tname)) && (v.assoc === undefined || Number.isSafeInteger(v.assoc)) &&
  [v.type, v.item].every((id) => id == null || record(id) && int(id.client, Number.MAX_SAFE_INTEGER) && int(id.clock, Number.MAX_SAFE_INTEGER));

/** Each authenticated socket owns ONE local awareness slot. The sender's Yjs id is never used as a target. */
export class BoundAwareness {
  private peers = new Map<string, { remoteId: number; localId: number; userId: string }>();
  private nextId = 0xffffffff;
  constructor(private awareness: Awareness) {}

  apply(bytes: Uint8Array, userId: string, peerId: string, name: string): void {
    if (!userId || !peerId || bytes.length > 32 * 1024) return;
    const dec = decoding.createDecoder(bytes);
    if (decoding.readVarUint(dec) !== 1) return;
    const remoteId = decoding.readVarUint(dec), clock = decoding.readVarUint(dec);
    const value: unknown = JSON.parse(decoding.readVarString(dec));
    if (dec.pos !== bytes.length || !int(clock, Number.MAX_SAFE_INTEGER) || !(value === null || record(value))) return;
    let peer = this.peers.get(peerId);
    if (peer && (peer.remoteId !== remoteId || peer.userId !== userId)) return;
    if (!peer) {
      if (this.peers.size >= 4096) return;
      while (this.nextId === this.awareness.clientID || this.awareness.getStates().has(this.nextId)) this.nextId--;
      peer = { remoteId, localId: this.nextId--, userId };
      this.peers.set(peerId, peer);
    }
    let state: Record<string, unknown> | null = null;
    if (value !== null) {
      state = { user: { name: str(name) && name ? name.slice(0, 200) : "Participant", color: colorForId(userId), userId } };
      if (int(value.slide, 100_000)) state.slide = value.slide;
      if (record(value.cell) && int(value.cell.s, 1000) && cellRef(value.cell.ref)) state.cell = { s: value.cell.s, ref: value.cell.ref };
      if (record(value.cursor) && relativePosition(value.cursor.anchor) && relativePosition(value.cursor.head))
        state.cursor = { anchor: value.cursor.anchor, head: value.cursor.head };
    }
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, 1);
    encoding.writeVarUint(enc, peer.localId);
    encoding.writeVarUint(enc, clock);
    encoding.writeVarString(enc, JSON.stringify(state));
    applyAwarenessUpdate(this.awareness, encoding.toUint8Array(enc), "remote");
  }
}
