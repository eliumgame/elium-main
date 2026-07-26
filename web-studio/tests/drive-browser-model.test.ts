import { describe, it, expect } from "vitest";
import {
  canDropInto, EMPTY_FILTER, familyOf, filterEntries, humanDate, humanSize, isCollab,
  matchesQuery, movePayload, nextSelection, pruneSelection, quotaState, selectionSummary,
  sortEntries, visibleEntries,
} from "../src/drive-cloud/browser-model";
import type { DriveEntry } from "../src/drive-cloud/ops";

const entry = (over: Partial<DriveEntry> & { id: string; name: string }): DriveEntry => ({
  orgId: "o1",
  parentId: null,
  kind: "file",
  ownerUserId: "u1",
  nameEncrypted: "",
  nameNonce: "",
  metaEncrypted: null,
  metaNonce: null,
  appKind: null,
  sizeBytes: 0,
  hasContent: true,
  contentNonce: null,
  trashedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  modifiedAt: "2026-01-01T00:00:00.000Z",
  ...over,
} as DriveEntry);

describe("Drive — classification", () => {
  it("maps app kinds to filter families", () => {
    expect(familyOf(entry({ id: "1", name: "d", kind: "folder" }))).toBe("folder");
    expect(familyOf(entry({ id: "2", name: "d", appKind: "doc" }))).toBe("document");
    expect(familyOf(entry({ id: "3", name: "d", appKind: "collab-doc" }))).toBe("document");
    expect(familyOf(entry({ id: "4", name: "d", appKind: "collab-sheet" }))).toBe("spreadsheet");
    expect(familyOf(entry({ id: "5", name: "d", appKind: "slides" }))).toBe("presentation");
    expect(familyOf(entry({ id: "6", name: "d", appKind: "pdf" }))).toBe("pdf");
    expect(familyOf(entry({ id: "7", name: "d", appKind: null }))).toBe("other");
  });

  it("recognises co-edited documents", () => {
    expect(isCollab(entry({ id: "1", name: "a", appKind: "collab-slides" }))).toBe(true);
    expect(isCollab(entry({ id: "2", name: "a", appKind: "slides" }))).toBe(false);
    expect(isCollab(entry({ id: "3", name: "a", appKind: null }))).toBe(false);
  });
});

describe("Drive — search", () => {
  it("ignores case and accents", () => {
    expect(matchesQuery("Résumé annuel", "resume")).toBe(true);
    expect(matchesQuery("Résumé annuel", "RÉSUMÉ")).toBe(true);
    expect(matchesQuery("Budget", "resume")).toBe(false);
  });

  it("treats an empty query as no filter", () => {
    expect(matchesQuery("n'importe quoi", "   ")).toBe(true);
  });

  it("filters by family and by text together", () => {
    const list = [
      entry({ id: "1", name: "Contrat", kind: "folder" }),
      entry({ id: "2", name: "Contrat de bail", appKind: "pdf" }),
      entry({ id: "3", name: "Budget", appKind: "pdf" }),
    ];
    expect(filterEntries(list, { query: "contrat", kind: null }).map((e) => e.id)).toEqual(["1", "2"]);
    expect(filterEntries(list, { query: "contrat", kind: "pdf" }).map((e) => e.id)).toEqual(["2"]);
    expect(filterEntries(list, EMPTY_FILTER)).toHaveLength(3);
  });
});

describe("Drive — sorting", () => {
  const list = [
    entry({ id: "f2", name: "Zèbre", kind: "folder", modifiedAt: "2026-05-01T00:00:00.000Z" }),
    entry({ id: "a", name: "annexe 10", sizeBytes: 500, modifiedAt: "2026-03-01T00:00:00.000Z" }),
    entry({ id: "f1", name: "Archives", kind: "folder", modifiedAt: "2026-01-01T00:00:00.000Z" }),
    entry({ id: "b", name: "annexe 2", sizeBytes: 9000, modifiedAt: "2026-04-01T00:00:00.000Z" }),
  ];

  it("always puts folders first, whatever the key or direction", () => {
    for (const key of ["name", "size", "modified", "kind"] as const) {
      for (const dir of ["asc", "desc"] as const) {
        const kinds = sortEntries(list, key, dir).map((e) => e.kind);
        expect(kinds.slice(0, 2)).toEqual(["folder", "folder"]);
      }
    }
  });

  it("sorts names naturally, so 2 comes before 10", () => {
    const names = sortEntries(list, "name", "asc").filter((e) => e.kind === "file").map((e) => e.name);
    expect(names).toEqual(["annexe 2", "annexe 10"]);
  });

  it("sorts names case- and accent-insensitively", () => {
    const folders = sortEntries(list, "name", "asc").filter((e) => e.kind === "folder").map((e) => e.name);
    expect(folders).toEqual(["Archives", "Zèbre"]);
  });

  it("sorts by size and by date", () => {
    expect(sortEntries(list, "size", "asc").filter((e) => e.kind === "file").map((e) => e.id)).toEqual(["a", "b"]);
    expect(sortEntries(list, "size", "desc").filter((e) => e.kind === "file").map((e) => e.id)).toEqual(["b", "a"]);
    expect(sortEntries(list, "modified", "desc").filter((e) => e.kind === "file").map((e) => e.id)).toEqual(["b", "a"]);
  });

  it("does not mutate the input", () => {
    const before = list.map((e) => e.id);
    sortEntries(list, "size", "desc");
    expect(list.map((e) => e.id)).toEqual(before);
  });

  it("combines filtering and sorting", () => {
    const out = visibleEntries(list, { query: "annexe", kind: null }, "size", "desc");
    expect(out.map((e) => e.id)).toEqual(["b", "a"]);
  });
});

describe("Drive — selection", () => {
  const ids = ["a", "b", "c", "d", "e"];

  it("replaces the selection on a plain click", () => {
    expect(nextSelection(ids, ["a", "b"], "a", "d", {})).toEqual({ selection: ["d"], anchor: "d" });
  });

  it("toggles with Ctrl", () => {
    expect(nextSelection(ids, ["a"], "a", "c", { ctrl: true }).selection).toEqual(["a", "c"]);
    expect(nextSelection(ids, ["a", "c"], "a", "c", { ctrl: true }).selection).toEqual(["a"]);
  });

  it("extends a range with Shift, in either direction", () => {
    expect(nextSelection(ids, ["b"], "b", "d", { shift: true }).selection).toEqual(["b", "c", "d"]);
    expect(nextSelection(ids, ["d"], "d", "b", { shift: true }).selection).toEqual(["b", "c", "d"]);
  });

  it("keeps the anchor when extending", () => {
    expect(nextSelection(ids, ["b"], "b", "d", { shift: true }).anchor).toBe("b");
  });

  it("falls back to a plain click when the anchor has gone", () => {
    expect(nextSelection(ids, [], "zzz", "c", { shift: true })).toEqual({ selection: ["c"], anchor: "c" });
  });

  it("drops ids that no longer exist after a reload", () => {
    const list = [entry({ id: "a", name: "a" }), entry({ id: "c", name: "c" })];
    expect(pruneSelection(["a", "b", "c"], list)).toEqual(["a", "c"]);
  });
});

describe("Drive — moving", () => {
  const folder = entry({ id: "f1", name: "Dossier", kind: "folder" });
  const file = entry({ id: "x", name: "Fichier", parentId: "root" });

  it("accepts a drop into a folder", () => {
    expect(canDropInto([file], folder, "root")).toBe(true);
  });

  it("refuses a drop onto a file", () => {
    expect(canDropInto([file], entry({ id: "y", name: "autre" }), "root")).toBe(false);
  });

  it("refuses dropping a folder into itself", () => {
    expect(canDropInto([folder], folder, "root")).toBe(false);
  });

  it("refuses a drop into the folder we are already in", () => {
    expect(canDropInto([file], null, null)).toBe(false);
    expect(canDropInto([file], folder, "f1")).toBe(false);
  });

  it("refuses an empty drag", () => {
    expect(canDropInto([], folder, "root")).toBe(false);
  });

  it("only sends the entries that actually change parent", () => {
    const already = entry({ id: "z", name: "déjà", parentId: "f1" });
    expect(movePayload([file, already, folder], "f1")).toEqual([{ id: "x", parentId: "f1" }]);
  });

  it("supports moving up to the root", () => {
    expect(movePayload([entry({ id: "q", name: "q", parentId: "f1" })], null)).toEqual([{ id: "q", parentId: null }]);
  });
});

describe("Drive — formatting", () => {
  it("formats sizes", () => {
    expect(humanSize(0)).toBe("—");
    expect(humanSize(512)).toBe("512 o");
    expect(humanSize(2048)).toBe("2.0 Ko");
    expect(humanSize(5 * 1024 * 1024)).toBe("5.0 Mo");
    expect(humanSize(1536 * 1024 * 1024)).toBe("1.5 Go");
  });

  it("formats dates relatively then absolutely", () => {
    const now = new Date("2026-06-15T12:00:00.000Z");
    expect(humanDate("2026-06-15T11:59:30.000Z", now)).toBe("à l'instant");
    expect(humanDate("2026-06-15T10:00:00.000Z", now)).toBe("il y a 2 h");
    expect(humanDate("2026-06-14T12:00:00.000Z", now)).toBe("hier");
    expect(humanDate("2026-06-12T12:00:00.000Z", now)).toBe("il y a 3 j");
    expect(humanDate("2026-01-02T12:00:00.000Z", now)).toMatch(/janv/);
    expect(humanDate("pas une date", now)).toBe("—");
  });

  it("reports the storage gauge, including unlimited", () => {
    expect(quotaState(50, null).tone).toBe("ok");
    expect(quotaState(50, null).ratio).toBe(0);
    expect(quotaState(500, 1000).ratio).toBeCloseTo(0.5, 5);
    expect(quotaState(850, 1000).tone).toBe("warn");
    expect(quotaState(990, 1000).tone).toBe("full");
    expect(quotaState(2000, 1000).ratio).toBe(1);
  });

  it("summarises a mixed selection", () => {
    const sel = [
      entry({ id: "1", name: "a", kind: "folder" }),
      entry({ id: "2", name: "b", sizeBytes: 1024 }),
      entry({ id: "3", name: "c", sizeBytes: 1024 }),
    ];
    expect(selectionSummary(sel)).toBe("1 dossier · 2 fichiers · 2.0 Ko");
    expect(selectionSummary([])).toBe("");
  });
});
