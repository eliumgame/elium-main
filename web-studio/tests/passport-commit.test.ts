import { describe, expect, it, vi } from "vitest";
import { committedRequest } from "../src/passport/idb-request";

function fixture() {
  const transaction = { objectStore: vi.fn(), oncomplete: null, onabort: null, error: null, abort: vi.fn() };
  const db = { transaction: vi.fn(() => transaction), close: vi.fn() };
  const request = { result: "saved" };
  const promise = committedRequest(
    db as unknown as IDBDatabase,
    "passport",
    "readwrite",
    () => request as IDBRequest<string>,
  );
  return { db, transaction: transaction as unknown as IDBTransaction, promise };
}

describe("passport persistence commits", () => {
  it("does not report success before the transaction commits", async () => {
    const { db, transaction, promise } = fixture();
    const done = vi.fn();
    void promise.then(done);
    await Promise.resolve();
    expect(done).not.toHaveBeenCalled();
    transaction.oncomplete!.call(transaction, {} as Event);
    await expect(promise).resolves.toBe("saved");
    expect(db.close).toHaveBeenCalledOnce();
  });

  it("rejects a late abort so callers keep the existing annexes", async () => {
    const { db, transaction, promise } = fixture();
    const rejection = expect(promise).rejects.toThrow("annulé");
    transaction.onabort!.call(transaction, {} as Event);
    await rejection;
    expect(db.close).toHaveBeenCalledOnce();
  });
});
