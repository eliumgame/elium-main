import { describe, it, expect } from "vitest";
import { Catalog } from "../src/workspace/catalog";
import { memoryKv } from "../src/workspace/kv";
import { WorkspaceService, type ContentApi, type LegacySlot } from "../src/workspace/service";
import { createJsonStore, type JsonRecord } from "../src/workspace/record-store";
import { createPdfStore, type PdfRecord } from "../src/workspace/pdf-store";
import { isDeckPristine, isWorkbookPristine } from "../src/workspace/pristine";
import { emptyWorkbook } from "../src/sheet/model";
import { emptyDeck } from "../src/slides/model";
import type { ContentStoreId, FolderRecord, ItemRecord } from "../src/workspace/types";
import type { VaultSecret } from "../src/crypto/local-vault";

/** Un contenu en mémoire : id → octets simulés. */
function memContent(initial: Record<string, number> = {}): ContentApi & { map: Map<string, number> } {
  const map = new Map(Object.entries(initial));
  return {
    map,
    async keys() {
      return [...map.keys()];
    },
    async info(id) {
      return map.has(id) ? { size: map.get(id)!, updatedAt: "2026-01-01T00:00:00.000Z" } : undefined;
    },
    async remove(ids) {
      for (const id of ids) map.delete(id);
    },
    async copy(a, b) {
      if (!map.has(a)) throw new Error("absent");
      map.set(b, map.get(a)!);
    },
  };
}

function world(opts: { secret?: VaultSecret; start?: number } = {}) {
  let clock = Date.parse("2026-09-01T10:00:00.000Z") + (opts.start ?? 0);
  let seq = 0;
  const now = () => new Date(clock);
  const items = memoryKv<ItemRecord>();
  const folders = memoryKv<FolderRecord>();
  const secretRef = { current: opts.secret as VaultSecret | undefined };
  const contents: Record<ContentStoreId, ReturnType<typeof memContent>> = {
    drive: memContent(),
    sheets: memContent(),
    slides: memContent(),
    pdfs: memContent(),
  };
  const catalog = new Catalog({
    items,
    folders,
    getSecret: () => secretRef.current,
    now: () => now().toISOString(),
    newId: () => `f${++seq}`,
  });
  const purged: string[] = [];
  const service = new WorkspaceService({
    catalog,
    contents,
    getSecret: () => secretRef.current,
    now,
    newId: () => `id${++seq}`,
    async duplicateDoc(id, newId) {
      contents.drive.map.set(newId, contents.drive.map.get(id)!);
      return { size: contents.drive.map.get(id)! };
    },
    async purgeSideData(its) {
      purged.push(...its.map((i) => i.id));
    },
    async describeUntrackedDocs(ids) {
      return ids.map((id) => ({
        id,
        title: `Ancien ${id}`,
        size: 10,
        savedAt: "2026-02-02T00:00:00.000Z",
        vaultProtected: false,
      }));
    },
  });
  return {
    service,
    catalog,
    contents,
    items,
    purged,
    secretRef,
    advance: (ms: number) => (clock += ms),
  };
}

describe("enregistrement dans le catalogue", () => {
  it("crée l'élément au premier enregistrement puis ne fait que le mettre à jour", async () => {
    const w = world();
    const a = await w.service.registerSaved({
      id: "d1",
      kind: "doc",
      title: "Rapport",
      size: 100,
      profile: "standard",
    });
    expect(a).toMatchObject({ title: "Rapport", contentStore: "drive", folderId: null });
    w.advance(5000);
    await w.service.rename("d1", "Rapport final");
    await w.service.registerSaved({ id: "d1", kind: "doc", title: "Autre titre de l'éditeur", size: 250 });
    const { items } = await w.catalog.load();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ title: "Rapport final", size: 250 }); // le renommage n'est pas écrasé
    expect(items[0]!.modifiedAt > a.modifiedAt).toBe(true);
  });

  it("reprend le titre de l'éditeur sur demande", async () => {
    const w = world();
    await w.service.registerSaved({ id: "d1", kind: "doc", title: "A", size: 1 });
    await w.service.registerSaved({ id: "d1", kind: "doc", title: "B", size: 1 }, { updateTitle: true });
    expect((await w.catalog.getItem("d1"))!.title).toBe("B");
  });

  it("déduplique les titres d'un même dossier et place le nouvel élément dans le dossier courant", async () => {
    const w = world();
    const f = await w.service.createFolder("Compta", null);
    const s2 = new WorkspaceService({
      catalog: w.catalog,
      contents: w.contents,
      getSecret: () => undefined,
      getCurrentFolder: () => f.id,
    });
    const a = await s2.registerSaved({ id: "s1", kind: "sheet", title: "Budget", size: 1 });
    const b = await s2.registerSaved({ id: "s2", kind: "sheet", title: "Budget", size: 1 });
    expect(a.folderId).toBe(f.id);
    expect(b.title).toBe("Budget (2)");
  });

  it("un dossier courant à la corbeille ramène le nouvel élément à la racine", async () => {
    const w = world();
    const f = await w.service.createFolder("Vieux", null);
    await w.service.trash({ folderIds: [f.id] });
    const it = await w.service.registerSaved({ id: "x", kind: "slides", size: 1, folderId: f.id });
    expect(it.folderId).toBeNull();
    expect(it.title).toBe("Présentation sans titre");
  });
});

describe("organisation", () => {
  it("déplace, met en favori, étiquette, refuse un dossier inexistant", async () => {
    const w = world();
    const f = await w.service.createFolder("Projets", null);
    await w.service.registerSaved({ id: "a", kind: "doc", title: "A", size: 1 });
    await w.service.registerSaved({ id: "b", kind: "doc", title: "B", size: 1 });
    await w.service.moveItems(["a", "b"], f.id);
    await w.service.setStarred(["a"], true);
    await w.service.addTag(["a", "b"], "#Urgent");
    await w.service.removeTag(["b"], "urgent");
    const { items } = await w.catalog.load();
    expect(items.find((i) => i.id === "a")).toMatchObject({ folderId: f.id, starred: true, tags: ["urgent"] });
    expect(items.find((i) => i.id === "b")!.tags).toEqual([]);
    await expect(w.service.moveItems(["a"], "nope")).rejects.toThrow(/introuvable/);
  });

  it("refuse de déplacer un dossier dans son propre sous-dossier", async () => {
    const w = world();
    const a = await w.service.createFolder("A", null);
    const b = await w.service.createFolder("B", a.id);
    await expect(w.service.moveFolder(a.id, b.id)).rejects.toThrow(/dans lui-même/);
    await w.service.moveFolder(b.id, null);
    expect((await w.catalog.load()).folders.find((f) => f.id === b.id)!.parentId).toBeNull();
  });

  it("deux dossiers de même nom côte à côte sont numérotés", async () => {
    const w = world();
    await w.service.createFolder("Photos", null);
    const second = await w.service.createFolder("photos", null);
    expect(second.name).toBe("photos (2)");
  });

  it("duplique un contenu natif et un document", async () => {
    const w = world();
    w.contents.sheets.map.set("s1", 40);
    w.contents.drive.map.set("d1", 70);
    await w.service.registerSaved({ id: "s1", kind: "sheet", title: "Budget", size: 40 });
    await w.service.registerSaved({ id: "d1", kind: "doc", title: "Note", size: 70 });
    await w.service.setStarred(["s1"], true);
    const copies = await w.service.duplicate(["s1", "d1"]);
    expect(copies.map((c) => c.title)).toEqual(["Copie de Budget", "Copie de Note"]);
    expect(copies[0]!.starred).toBe(false);
    expect(w.contents.sheets.map.size).toBe(2);
    expect(w.contents.drive.map.size).toBe(2);
    const again = await w.service.duplicate(["s1"]);
    expect(again[0]!.title).toBe("Copie de Budget (2)");
  });
});

describe("corbeille", () => {
  it("met à la corbeille sans toucher au contenu, restaure, puis supprime définitivement", async () => {
    const w = world();
    w.contents.slides.map.set("p1", 10);
    await w.service.registerSaved({ id: "p1", kind: "slides", title: "Deck", size: 10 });
    await w.service.trash({ itemIds: ["p1"] });
    expect(w.contents.slides.map.has("p1")).toBe(true);
    expect((await w.catalog.getItem("p1"))!.trashedAt).toBeTruthy();
    await w.service.restore({ itemIds: ["p1"] });
    expect((await w.catalog.getItem("p1"))!.trashedAt).toBeUndefined();
    await w.service.trash({ itemIds: ["p1"] });
    await w.service.deleteForever({ itemIds: ["p1"] });
    expect(w.contents.slides.map.has("p1")).toBe(false);
    expect(await w.catalog.getItem("p1")).toBeUndefined();
    expect(w.purged).toEqual(["p1"]);
  });

  it("ne supprime jamais définitivement un élément qui n'est pas à la corbeille", async () => {
    const w = world();
    w.contents.drive.map.set("d", 1);
    await w.service.registerSaved({ id: "d", kind: "doc", size: 1 });
    await w.service.deleteForever({ itemIds: ["d"] });
    expect(w.contents.drive.map.has("d")).toBe(true);
    expect(await w.catalog.getItem("d")).toBeDefined();
  });

  it("vider la corbeille efface tout ce qui y est, rien d'autre", async () => {
    const w = world();
    for (const id of ["a", "b", "c"]) {
      w.contents.drive.map.set(id, 1);
      await w.service.registerSaved({ id, kind: "doc", size: 1 });
    }
    const f = await w.service.createFolder("Dossier", null);
    await w.service.moveItems(["c"], f.id);
    await w.service.trash({ itemIds: ["a"], folderIds: [f.id] });
    const n = await w.service.emptyTrash();
    expect(n).toBe(3); // a, c (parti avec le dossier) et le dossier
    expect([...w.contents.drive.map.keys()]).toEqual(["b"]);
    const { items, folders } = await w.catalog.load();
    expect(items.map((i) => i.id)).toEqual(["b"]);
    expect(folders).toHaveLength(0);
  });

  it("la purge automatique ne retire que ce qui a plus de 30 jours", async () => {
    const w = world();
    w.contents.drive.map.set("old", 1);
    w.contents.drive.map.set("recent", 1);
    await w.service.registerSaved({ id: "old", kind: "doc", size: 1 });
    await w.service.registerSaved({ id: "recent", kind: "doc", size: 1 });
    await w.service.trash({ itemIds: ["old"] });
    w.advance(31 * 24 * 3600 * 1000);
    await w.service.trash({ itemIds: ["recent"] });
    expect(await w.service.purgeExpired()).toBe(1);
    expect([...w.contents.drive.map.keys()]).toEqual(["recent"]);
  });

  it("si l'effacement du contenu échoue, le catalogue garde l'élément (réessayable)", async () => {
    const w = world();
    w.contents.drive.map.set("d", 1);
    await w.service.registerSaved({ id: "d", kind: "doc", size: 1 });
    await w.service.trash({ itemIds: ["d"] });
    w.contents.drive.remove = async () => {
      throw new Error("disque plein");
    };
    await expect(w.service.deleteForever({ itemIds: ["d"] })).rejects.toThrow("disque plein");
    expect(await w.catalog.getItem("d")).toBeDefined();
  });
});

describe("réconciliation et ancien contenu « current »", () => {
  it("inscrit les documents d'avant l'espace de travail et retire les éléments orphelins", async () => {
    const w = world();
    w.contents.drive.map.set("old1", 5);
    w.contents.drive.map.set("old2", 6);
    await w.service.registerSaved({ id: "ghost", kind: "doc", size: 1 }); // contenu absent
    const r = await w.service.reconcile();
    expect(r).toEqual({ removed: 1, added: 2 });
    const { items } = await w.catalog.load();
    expect(items.map((i) => i.id).sort()).toEqual(["old1", "old2"]);
    expect(items.find((i) => i.id === "old1")).toMatchObject({
      title: "Ancien old1",
      modifiedAt: "2026-02-02T00:00:00.000Z",
    });
    expect(await w.service.reconcile()).toEqual({ removed: 0, added: 0 }); // idempotent
  });

  function slot(w: ReturnType<typeof world>, pristine: boolean | "locked"): LegacySlot {
    return {
      store: "sheets",
      legacyId: "current",
      title: "Classeur importé",
      async isPristine() {
        if (pristine === "locked") throw new Error("chiffré");
        return pristine;
      },
      async move(a, b) {
        const v = w.contents.sheets.map.get(a);
        if (v === undefined) return false;
        w.contents.sheets.map.set(b, v);
        w.contents.sheets.map.delete(a);
        return true;
      },
    };
  }
  function withSlot(w: ReturnType<typeof world>, s: LegacySlot) {
    return new WorkspaceService({
      catalog: w.catalog,
      contents: w.contents,
      getSecret: () => w.secretRef.current,
      legacySlots: [s],
      newId: () => "imported-1",
    });
  }

  it("importe l'ancien classeur comme premier élément, sans le copier", async () => {
    const w = world();
    w.contents.sheets.map.set("current", 321);
    const svc = withSlot(w, slot(w, false));
    expect(await svc.importLegacy()).toEqual({ imported: 1, locked: 0 });
    expect([...w.contents.sheets.map.entries()]).toEqual([["imported-1", 321]]);
    const it = (await w.catalog.load()).items[0]!;
    expect(it).toMatchObject({ id: "imported-1", kind: "sheet", title: "Classeur importé", size: 321 });
    // Idempotent : « current » n'existe plus.
    expect(await svc.importLegacy()).toEqual({ imported: 0, locked: 0 });
  });

  it("un contenu vierge est retiré sans créer d'élément", async () => {
    const w = world();
    w.contents.sheets.map.set("current", 12);
    const svc = withSlot(w, slot(w, true));
    expect(await svc.importLegacy()).toEqual({ imported: 0, locked: 0 });
    expect(w.contents.sheets.map.size).toBe(0);
    expect((await w.catalog.load()).items).toHaveLength(0);
  });

  it("un contenu chiffré non déverrouillé est laissé intact pour une prochaine fois", async () => {
    const w = world();
    w.contents.sheets.map.set("current", 12);
    const svc = withSlot(w, slot(w, "locked"));
    expect(await svc.importLegacy()).toEqual({ imported: 0, locked: 1 });
    expect(w.contents.sheets.map.has("current")).toBe(true);
  });

  it("la réconciliation n'inscrit pas l'ancien « current » comme un élément à part", async () => {
    const w = world();
    w.contents.sheets.map.set("current", 12);
    const svc = withSlot(w, slot(w, "locked"));
    expect(await svc.reconcile()).toEqual({ removed: 0, added: 0 });
  });
});

describe("coffre local : catalogue chiffré", () => {
  const secret: VaultSecret = { password: "coffre-test" };

  it("chiffre titre et étiquettes au repos et les relit avec le bon secret seulement", async () => {
    const w = world({ secret });
    await w.service.registerSaved({ id: "d1", kind: "doc", title: "Contrat confidentiel", size: 1 });
    await w.service.addTag(["d1"], "secret");
    const raw = w.items.snapshot()[0]!;
    expect(raw.vaultProtected).toBe(true);
    expect(JSON.stringify(raw)).not.toContain("confidentiel");
    expect(raw.title).toBeUndefined();
    expect(await w.catalog.getItem("d1")).toMatchObject({ title: "Contrat confidentiel", tags: ["secret"] });
    w.secretRef.current = { password: "mauvais" };
    expect(await w.catalog.getItem("d1")).toMatchObject({ locked: true, title: "Élément protégé" });
    w.secretRef.current = undefined;
    expect((await w.catalog.getItem("d1"))!.locked).toBe(true);
  });

  it("déplacer ou mettre en favori ne demande aucun déchiffrement", async () => {
    const w = world({ secret });
    await w.service.registerSaved({ id: "d1", kind: "doc", title: "Privé", size: 1 });
    w.secretRef.current = undefined; // coffre « oublié » : les champs d'organisation restent modifiables
    await w.service.setStarred(["d1"], true);
    expect(w.items.snapshot()[0]!.starred).toBe(true);
  });

  it("rechiffre tout le catalogue vers un autre secret, puis vers le clair", async () => {
    const w = world({ secret });
    await w.service.registerSaved({ id: "d1", kind: "doc", title: "Plan", size: 1 });
    const folder = await w.service.createFolder("Dossier privé", null);
    const next: VaultSecret = { password: "nouveau" };
    await w.catalog.reencrypt(secret, next);
    w.secretRef.current = next;
    expect((await w.catalog.getItem("d1"))!.title).toBe("Plan");
    expect((await w.catalog.load()).folders.find((f) => f.id === folder.id)!.name).toBe("Dossier privé");
    await w.catalog.reencrypt(next, undefined);
    w.secretRef.current = undefined;
    const raw = w.items.snapshot()[0]!;
    expect(raw).toMatchObject({ vaultProtected: false, title: "Plan" });
    expect(raw.enc).toBeUndefined();
  });

  it("refuse de rechiffrer avec un mauvais secret et n'écrit rien", async () => {
    const w = world({ secret });
    await w.service.registerSaved({ id: "d1", kind: "doc", title: "Plan", size: 1 });
    const before = JSON.stringify(w.items.snapshot());
    await expect(w.catalog.reencrypt({ password: "faux" }, undefined)).rejects.toThrow(/incorrect/);
    await expect(w.catalog.reencrypt(undefined, undefined)).rejects.toThrow(/requis/);
    expect(JSON.stringify(w.items.snapshot())).toBe(before);
  });
});

describe("magasins de contenu", () => {
  it("magasin JSON : aller-retour clair et chiffré, déplacement, copie, rechiffrement", async () => {
    const kv = memoryKv<JsonRecord>();
    const store = createJsonStore<{ n: number }>(kv, { field: "wb", lockedMessage: "chiffré" });
    await store.save("a", { n: 1 });
    expect(await store.load("a")).toEqual({ n: 1 });
    await store.save("b", { n: 2 }, { password: "x" });
    expect(JSON.stringify(kv.snapshot().find((r) => r.id === "b"))).not.toContain('"n":2');
    await expect(store.load("b")).rejects.toThrow("chiffré");
    await expect(store.load("b", { password: "x" })).resolves.toEqual({ n: 2 });
    expect(await store.move("a", "c")).toBe(true);
    expect(await store.keys()).toEqual(expect.arrayContaining(["b", "c"]));
    expect(await store.load("a")).toBeUndefined();
    await store.copy("c", "d");
    expect(await store.load("d")).toEqual({ n: 1 });
    await store.reencrypt({ password: "x" }, { password: "y" });
    await expect(store.load("b", { password: "y" })).resolves.toEqual({ n: 2 });
    await expect(store.load("c", { password: "y" })).resolves.toEqual({ n: 1 });
  });

  it("un ancien enregistrement « current » d'avant le coffre reste lisible", async () => {
    const kv = memoryKv<JsonRecord>([{ id: "current", wb: { n: 9 } }]);
    const store = createJsonStore<{ n: number }>(kv, { field: "wb", lockedMessage: "chiffré" });
    expect(await store.load("current")).toEqual({ n: 9 });
  });

  it("magasin PDF : octets et nom chiffrés avec le coffre", async () => {
    const kv = memoryKv<PdfRecord>();
    const store = createPdfStore(kv);
    const bytes = new Uint8Array([37, 80, 68, 70, 1, 2, 3]);
    await store.put({ id: "p", name: "contrat.pdf", bytes });
    expect(await store.get("p")).toMatchObject({ name: "contrat.pdf", bytes });
    await store.put({ id: "q", name: "secret.pdf", bytes }, { password: "k" });
    const raw = kv.snapshot().find((r) => r.id === "q")!;
    expect(raw.bytes).toBeUndefined();
    expect(raw.name).toBeUndefined();
    await expect(store.get("q")).rejects.toThrow(/chiffré/);
    expect((await store.get("q", { password: "k" }))!.name).toBe("secret.pdf");
    await store.reencrypt({ password: "k" }, undefined);
    expect((await store.get("q"))!.name).toBe("secret.pdf");
  });
});

describe("contenu vierge", () => {
  it("reconnaît un classeur et une présentation intacts, pas ceux modifiés", () => {
    expect(isWorkbookPristine(emptyWorkbook())).toBe(true);
    const wb = emptyWorkbook();
    wb.sheets[0]!.cells["A1"] = "42";
    expect(isWorkbookPristine(wb)).toBe(false);
    expect(isDeckPristine(emptyDeck())).toBe(true);
    const d = emptyDeck();
    d.slides[0]!.title = "Mon sujet";
    expect(isDeckPristine(d)).toBe(false);
  });
});
