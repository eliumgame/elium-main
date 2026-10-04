import { describe, it, expect } from "vitest";
import {
  canMoveFolder,
  childFolders,
  collectTags,
  copyName,
  daysLeftInTrash,
  descendantFolderIds,
  expiredTrash,
  filterItems,
  folderPath,
  normalizeTag,
  normalizeTags,
  planRestore,
  planTrash,
  recentItems,
  reconcile,
  sortItems,
  trashRoots,
  uniqueName,
} from "../src/workspace/model";
import type { WorkFolder, WorkItem } from "../src/workspace/types";

const T0 = "2026-09-01T10:00:00.000Z";

function item(p: Partial<WorkItem> & { id: string }): WorkItem {
  return {
    kind: "doc",
    contentStore: "drive",
    title: p.id,
    size: 100,
    createdAt: T0,
    modifiedAt: T0,
    folderId: null,
    tags: [],
    starred: false,
    vaultProtected: false,
    ...p,
  };
}
function folder(p: Partial<WorkFolder> & { id: string }): WorkFolder {
  return { parentId: null, name: p.id, createdAt: T0, vaultProtected: false, ...p };
}

describe("dossiers", () => {
  const folders = [
    folder({ id: "a" }),
    folder({ id: "b", parentId: "a" }),
    folder({ id: "c", parentId: "b" }),
    folder({ id: "d" }),
  ];

  it("liste les descendants et le chemin", () => {
    expect(descendantFolderIds(folders, "a").sort()).toEqual(["b", "c"]);
    expect(descendantFolderIds(folders, "d")).toEqual([]);
    expect(folderPath(folders, "c").map((f) => f.id)).toEqual(["a", "b", "c"]);
    expect(folderPath(folders, null)).toEqual([]);
  });

  it("interdit de déplacer un dossier dans lui-même ou un descendant", () => {
    expect(canMoveFolder(folders, "a", "a")).toEqual({ ok: false, reason: "self" });
    expect(canMoveFolder(folders, "a", "c")).toEqual({ ok: false, reason: "descendant" });
    expect(canMoveFolder(folders, "c", "d")).toEqual({ ok: true });
    expect(canMoveFolder(folders, "c", null)).toEqual({ ok: true });
    expect(canMoveFolder(folders, "zz", null)).toEqual({ ok: false, reason: "missing" });
    expect(canMoveFolder(folders, "a", "nope")).toEqual({ ok: false, reason: "missing" });
  });

  it("ne boucle pas sur un cycle déjà corrompu", () => {
    const bad = [folder({ id: "x", parentId: "y" }), folder({ id: "y", parentId: "x" })];
    expect(descendantFolderIds(bad, "x")).toEqual(["y"]);
    expect(folderPath(bad, "x").length).toBeLessThanOrEqual(2);
  });

  it("trie les sous-dossiers par nom et masque la corbeille", () => {
    const fs = [
      folder({ id: "1", name: "Zèbre" }),
      folder({ id: "2", name: "alpha" }),
      folder({ id: "3", name: "gone", trashedAt: T0 }),
    ];
    expect(childFolders(fs, null).map((f) => f.name)).toEqual(["alpha", "Zèbre"]);
    expect(childFolders(fs, null, true)).toHaveLength(3);
  });
});

describe("noms et étiquettes", () => {
  it("génère des noms uniques insensibles à la casse", () => {
    expect(uniqueName("Rapport", [])).toBe("Rapport");
    expect(uniqueName("Rapport", ["rapport"])).toBe("Rapport (2)");
    expect(uniqueName("Rapport", ["Rapport", "Rapport (2)"])).toBe("Rapport (3)");
    expect(uniqueName("  ", [])).toBe("Sans titre");
  });

  it("nomme les copies sans empiler les préfixes", () => {
    expect(copyName("Plan", ["Plan"])).toBe("Copie de Plan");
    expect(copyName("Copie de Plan", ["Plan", "Copie de Plan"])).toBe("Copie de Plan (2)");
  });

  it("normalise les étiquettes", () => {
    expect(normalizeTag("  #Facture  2026 ")).toBe("facture 2026");
    expect(normalizeTags(["A", "a", "#a ", "", "b"])).toEqual(["a", "b"]);
  });

  it("compte les étiquettes hors corbeille", () => {
    const items = [
      item({ id: "1", tags: ["x", "y"] }),
      item({ id: "2", tags: ["x"] }),
      item({ id: "3", tags: ["x"], trashedAt: T0 }),
    ];
    expect(collectTags(items)).toEqual([
      { tag: "x", count: 2 },
      { tag: "y", count: 1 },
    ]);
  });
});

describe("corbeille", () => {
  const folders = [folder({ id: "f" }), folder({ id: "g", parentId: "f" })];
  const items = [
    item({ id: "i1", folderId: "f" }),
    item({ id: "i2", folderId: "g" }),
    item({ id: "i3" }),
    item({ id: "i4", folderId: "f", trashedAt: "2026-08-01T00:00:00.000Z" }),
  ];
  const NOW = "2026-09-10T00:00:00.000Z";

  it("un dossier emporte son contenu avec la même date, et pas ce qui était déjà à la corbeille", () => {
    const plan = planTrash(items, folders, { folderIds: ["f"] }, NOW);
    expect(plan.folders.get("f")).toEqual({ trashedAt: NOW, trashedBy: undefined });
    expect(plan.folders.get("g")).toEqual({ trashedAt: NOW, trashedBy: "f" });
    expect(plan.items.get("i1")).toEqual({ trashedAt: NOW, trashedBy: "f" });
    expect(plan.items.get("i2")).toEqual({ trashedAt: NOW, trashedBy: "f" });
    expect(plan.items.has("i3")).toBe(false);
    expect(plan.items.has("i4")).toBe(false);
  });

  it("met un élément seul à la corbeille, une seule fois", () => {
    const plan = planTrash(items, folders, { itemIds: ["i3", "i4", "nope"] }, NOW);
    expect([...plan.items.keys()]).toEqual(["i3"]);
  });

  it("restaure un dossier avec ce qui est parti avec lui", () => {
    const trashedFolders = [
      folder({ id: "f", trashedAt: NOW }),
      folder({ id: "g", parentId: "f", trashedAt: NOW, trashedBy: "f" }),
    ];
    const trashedItems = [
      item({ id: "i1", folderId: "f", trashedAt: NOW, trashedBy: "f" }),
      item({ id: "i5", folderId: "f", trashedAt: "2026-08-01T00:00:00.000Z" }), // supprimé à part
    ];
    const plan = planRestore(trashedItems, trashedFolders, { folderIds: ["f"] });
    expect(plan.folders.get("f")).toMatchObject({ trashedAt: undefined });
    expect(plan.folders.get("g")).toMatchObject({ trashedAt: undefined });
    expect(plan.items.has("i1")).toBe(true);
    expect(plan.items.has("i5")).toBe(false);
  });

  it("remonte à la racine un élément restauré dont le dossier est encore à la corbeille", () => {
    const fs = [folder({ id: "f", trashedAt: NOW })];
    const its = [item({ id: "i", folderId: "f", trashedAt: NOW })];
    expect(planRestore(its, fs, { itemIds: ["i"] }).items.get("i")).toMatchObject({ folderId: null });
    const missing = [item({ id: "j", folderId: "ghost", trashedAt: NOW })];
    expect(planRestore(missing, [], { itemIds: ["j"] }).items.get("j")).toMatchObject({ folderId: null });
  });

  it("n'expose que les entrées de premier niveau et calcule les jours restants", () => {
    const fs = [folder({ id: "f", trashedAt: NOW }), folder({ id: "g", trashedAt: NOW, trashedBy: "f" })];
    const its = [item({ id: "a", trashedAt: NOW, trashedBy: "f" }), item({ id: "b", trashedAt: NOW })];
    const roots = trashRoots(its, fs);
    expect(roots.folders.map((f) => f.id)).toEqual(["f"]);
    expect(roots.items.map((i) => i.id)).toEqual(["b"]);
    expect(daysLeftInTrash(NOW, new Date("2026-09-11T00:00:00.000Z"))).toBe(29);
    expect(daysLeftInTrash(NOW, new Date("2027-01-01T00:00:00.000Z"))).toBe(0);
  });

  it("purge ce qui dépasse 30 jours, avec ce qui est parti avec un dossier périmé", () => {
    const old = "2026-07-01T00:00:00.000Z";
    const fs = [
      folder({ id: "f", trashedAt: old }),
      folder({ id: "g", trashedAt: old, trashedBy: "f" }),
      folder({ id: "h", trashedAt: "2026-09-05T00:00:00.000Z" }),
    ];
    const its = [
      item({ id: "x", trashedAt: old }),
      item({ id: "y", trashedAt: old, trashedBy: "f" }),
      item({ id: "z", trashedAt: "2026-09-05T00:00:00.000Z" }),
      item({ id: "live" }),
    ];
    const exp = expiredTrash(its, fs, new Date("2026-09-10T00:00:00.000Z"));
    expect(exp.itemIds.sort()).toEqual(["x", "y"]);
    expect(exp.folderIds.sort()).toEqual(["f", "g"]);
  });
});

describe("filtres et tri", () => {
  const items = [
    item({ id: "1", title: "Budget été", kind: "sheet", tags: ["finance"], modifiedAt: "2026-09-05T08:00:00.000Z" }),
    item({
      id: "2",
      title: "Plan de projet",
      kind: "doc",
      starred: true,
      folderId: "f",
      modifiedAt: "2026-09-07T08:00:00.000Z",
    }),
    item({ id: "3", title: "Réunion", kind: "slides", modifiedAt: "2026-08-01T08:00:00.000Z" }),
    item({ id: "4", title: "Vieux", trashedAt: T0 }),
  ];
  const ids = (xs: WorkItem[]) => xs.map((x) => x.id).sort();

  it("ignore accents et casse, cherche aussi dans les étiquettes", () => {
    expect(ids(filterItems(items, { query: "ETE" }))).toEqual(["1"]);
    expect(ids(filterItems(items, { query: "fin" }))).toEqual(["1"]);
    expect(ids(filterItems(items, { query: "reunion" }))).toEqual(["3"]);
  });

  it("filtre par type, dossier, étiquette, favori et période", () => {
    expect(ids(filterItems(items, { kinds: ["sheet", "slides"] }))).toEqual(["1", "3"]);
    expect(ids(filterItems(items, { folderId: "f" }))).toEqual(["2"]);
    expect(ids(filterItems(items, { folderId: null }))).toEqual(["1", "3"]);
    expect(ids(filterItems(items, { tag: "finance" }))).toEqual(["1"]);
    expect(ids(filterItems(items, { starred: true }))).toEqual(["2"]);
    expect(ids(filterItems(items, { modifiedFrom: "2026-09-01", modifiedTo: "2026-09-05" }))).toEqual(["1"]);
  });

  it("sépare vivant et corbeille", () => {
    expect(ids(filterItems(items, { trashed: true }))).toEqual(["4"]);
    expect(filterItems(items, {}).some((i) => i.id === "4")).toBe(false);
  });

  it("trie par titre (naturel), date et taille, stable", () => {
    const named = [
      item({ id: "a", title: "Doc 10" }),
      item({ id: "b", title: "Doc 2" }),
      item({ id: "c", title: "alpha" }),
    ];
    expect(sortItems(named, "title").map((i) => i.title)).toEqual(["alpha", "Doc 2", "Doc 10"]);
    expect(sortItems(named, "title", "desc").map((i) => i.title)).toEqual(["Doc 10", "Doc 2", "alpha"]);
    expect(sortItems(items, "modifiedAt", "desc")[0]!.id).toBe("2");
  });

  it("liste les récents selon la dernière ouverture ou modification", () => {
    const r = recentItems([
      item({ id: "old", modifiedAt: "2026-01-01T00:00:00.000Z" }),
      item({ id: "opened", modifiedAt: "2026-01-02T00:00:00.000Z", lastOpenedAt: "2026-09-09T00:00:00.000Z" }),
      item({ id: "edited", modifiedAt: "2026-09-08T00:00:00.000Z" }),
      item({ id: "bin", modifiedAt: "2026-09-10T00:00:00.000Z", trashedAt: T0 }),
    ]);
    expect(r.map((i) => i.id)).toEqual(["opened", "edited", "old"]);
  });
});

describe("réconciliation", () => {
  it("détecte contenus orphelins et éléments sans catalogue", () => {
    const r = reconcile(
      [
        { id: "doc1", contentStore: "drive" },
        { id: "gone", contentStore: "drive" },
        { id: "sh1", contentStore: "sheets" },
      ],
      { drive: ["doc1", "doc2"], sheets: ["sh1", "current"], slides: [], pdfs: ["p1"] },
    );
    expect(r.orphanItemIds).toEqual(["gone"]);
    expect(r.untracked).toEqual([
      { store: "drive", id: "doc2" },
      { store: "sheets", id: "current" },
      { store: "pdfs", id: "p1" },
    ]);
  });
});
