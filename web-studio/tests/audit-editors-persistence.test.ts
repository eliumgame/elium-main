import { describe, it, expect, vi, beforeEach } from "vitest";
import { putDraft, listDrafts, snapshotDraftFile } from "../src/format/drafts-store";
import { createEliumFile } from "../src/format/document";
const h = vi.hoisted(() => ({ open: vi.fn(), dirty: vi.fn(), project: vi.fn() }));
vi.mock("../src/format/idb-migrate", () => ({ openMigrated: h.open }));
vi.mock("../src/workspace/sync-dirty", () => ({ markDirty: h.dirty }));
vi.mock("../src/format/idb-cursor", () => ({ readProjected: h.project }));
beforeEach(() => vi.clearAllMocks());
async function fixture() {
  const file = await createEliumFile({ title: "Draft" });
  const request = { result: "id", onsuccess: null, onerror: null } as unknown as IDBRequest;
  const transaction = {
    oncomplete: null,
    onabort: null,
    onerror: null,
    error: null,
    objectStore: () => ({ put: vi.fn(() => request) }),
  } as unknown as IDBTransaction;
  const db = { transaction: () => transaction, close: vi.fn() };
  h.open.mockResolvedValue(db);
  const input = {
    id: "id",
    title: "Draft",
    profile: file.manifest.profile,
    updatedAt: "now",
    doc: file.document.doc,
    page: file.document.page,
    snapshot: snapshotDraftFile(file),
  };
  return { request, transaction, db, input };
}
describe("F-08 committed draft persistence", () => {
  it("does not acknowledge request success until the transaction commits", async () => {
    const f = await fixture();
    const done = vi.fn();
    const saving = putDraft(f.input).then(done);
    await vi.waitFor(() => expect(f.request.onsuccess).toBeTypeOf("function"));
    f.request.onsuccess!.call(f.request, {} as Event);
    await Promise.resolve();
    expect(done).not.toHaveBeenCalled();
    expect(h.dirty).not.toHaveBeenCalled();
    f.transaction.oncomplete!.call(f.transaction, {} as Event);
    await saving;
    expect(done).toHaveBeenCalledOnce();
    expect(h.dirty).toHaveBeenCalledWith("brouillons");
    expect(f.db.close).toHaveBeenCalledOnce();
  });
  it("rejects a late abort and does not announce a saved draft", async () => {
    const f = await fixture();
    const saving = putDraft(f.input);
    const rejection = expect(saving).rejects.toThrow(/annulé/);
    await vi.waitFor(() => expect(f.request.onsuccess).toBeTypeOf("function"));
    f.request.onsuccess!.call(f.request, {} as Event);
    f.transaction.onabort!.call(f.transaction, {} as Event);
    await rejection;
    expect(h.dirty).not.toHaveBeenCalled();
    expect(f.db.close).toHaveBeenCalledOnce();
  });
  it("excludes the full snapshot and body from the recovery listing", async () => {
    const f = await fixture();
    h.project.mockImplementation(async (_open: unknown, _store: unknown, project: (v: unknown) => unknown) => [
      project({ ...f.input, protected: false, size: 12 }),
    ]);
    const entries = await listDrafts();
    expect(entries[0]).not.toHaveProperty("snapshot");
    expect(entries[0]).not.toHaveProperty("doc");
    expect(entries[0]).not.toHaveProperty("page");
    expect(entries[0].title).toBe("Draft");
  });
});
