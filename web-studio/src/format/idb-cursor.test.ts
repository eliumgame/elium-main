import { describe, expect, it } from "vitest";
import { readProjected } from "./idb-cursor";

/** Base factice : un curseur qui sert les enregistrements un par un. */
function fakeDb(records: unknown[]) {
  let closed = false;
  let served = 0;
  const db = {
    close: () => (closed = true),
    transaction: () => ({
      onabort: null,
      objectStore: () => ({
        openCursor: () => {
          const req: { result: unknown; onsuccess: (() => void) | null; onerror: null } = {
            result: null,
            onsuccess: null,
            onerror: null,
          };
          let i = 0;
          const step = () => {
            req.result = i < records.length ? { value: records[i++], continue: () => queueMicrotask(step) } : null;
            served = i;
            req.onsuccess?.();
          };
          queueMicrotask(step);
          return req;
        },
      }),
    }),
  };
  return { db: db as unknown as IDBDatabase, isClosed: () => closed, served: () => served };
}

describe("readProjected", () => {
  it("projette chaque enregistrement (les octets ne sont pas conservés) et ferme la base", async () => {
    const f = fakeDb([
      { id: "a", title: "A", bytes: new Uint8Array(1000) },
      { id: "b", title: "B", bytes: new Uint8Array(1000) },
    ]);
    const out = await readProjected<{ id: string; title: string; bytes: Uint8Array }, { id: string; title: string }>(
      async () => f.db,
      "docs",
      ({ bytes: _b, ...meta }) => meta,
    );
    expect(out).toEqual([
      { id: "a", title: "A" },
      { id: "b", title: "B" },
    ]);
    expect(out[0]).not.toHaveProperty("bytes");
    expect(f.isClosed()).toBe(true);
  });
  it("magasin vide", async () => {
    const f = fakeDb([]);
    expect(
      await readProjected(
        async () => f.db,
        "docs",
        (v) => v,
      ),
    ).toEqual([]);
  });
});
