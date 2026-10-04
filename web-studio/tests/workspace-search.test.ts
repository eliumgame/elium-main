import { describe, it, expect } from "vitest";
import { SearchIndex, makeSnippet, mergeRanges, splitHighlight } from "../src/workspace/search/index";
import { SearchIndexer, VAULT_BUNDLE_ID, revOf, type IndexRecord } from "../src/workspace/search/indexer";
import { runSearch } from "../src/workspace/search/query";
import { capText, deckText, docText, foldText, queryTerms, sheetText, stripHtml } from "../src/workspace/search/text";
import { memoryKv } from "../src/workspace/kv";
import { emptyDeck } from "../src/slides/model";
import { emptyWorkbook } from "../src/sheet/model";
import type { WorkItem } from "../src/workspace/types";
import type { ProseMirrorNode } from "../src/format/types";

function item(p: Partial<WorkItem> & { id: string }): WorkItem {
  return {
    kind: "doc",
    contentStore: "drive",
    title: p.id,
    size: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    modifiedAt: "2026-01-01T00:00:00.000Z",
    folderId: null,
    tags: [],
    starred: false,
    vaultProtected: false,
    ...p,
  };
}

describe("normalisation", () => {
  it("plie casse et accents caractère par caractère (longueur conservée)", () => {
    expect(foldText("Éléphant ÇA Œuvre")).toBe("elephant ca œuvre");
    expect(foldText("Été").length).toBe("Été".length);
    expect(foldText("é")).toHaveLength(2); // base + marque combinante : 1 pour 1
  });

  it("découpe la requête en mots uniques", () => {
    expect(queryTerms("  Budget, BUDGET  été-2026 ")).toEqual(["budget", "ete", "2026"]);
    expect(queryTerms("   ")).toEqual([]);
  });

  it("extrait le texte d'un document ProseMirror par blocs", () => {
    const doc: ProseMirrorNode = {
      type: "doc",
      content: [
        { type: "heading", content: [{ type: "text", text: "Titre" }] },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "un " },
            { type: "text", text: "mot", marks: [{ type: "bold" }] },
          ],
        },
      ],
    };
    expect(docText(doc)).toBe("Titre\nun mot\n");
    expect(docText(undefined)).toBe("");
  });

  it("extrait classeurs (hors formules) et présentations", () => {
    const wb = emptyWorkbook();
    wb.sheets[0]!.cells = { A1: "Facture", B1: "=SUM(A1:A3)", C1: "42" };
    expect(sheetText(wb)).toContain("Facture");
    expect(sheetText(wb)).not.toContain("SUM");
    const deck = emptyDeck();
    deck.slides[0]!.notes = "note orale";
    deck.slides[0]!.elements = [
      { id: "e", type: "text", x: 0, y: 0, w: 10, h: 10, html: "<p>Bonjour <b>monde</b></p>" },
    ];
    const txt = deckText(deck);
    expect(txt).toContain("Titre de la présentation");
    expect(txt).toContain("note orale");
    expect(txt).toContain("Bonjour monde");
  });

  it("retire le HTML et plafonne le texte", () => {
    expect(stripHtml("<p>a&nbsp;b</p><p>c&amp;d</p>")).toBe("a b\nc&d");
    expect(capText("x".repeat(10), 4)).toBe("xxxx");
  });
});

describe("index plein texte", () => {
  const index = new SearchIndex();
  index.set({
    id: "1",
    rev: "a",
    title: "Contrat de location",
    text: "Le locataire verse un loyer mensuel de 800 euros.",
  });
  index.set({ id: "2", rev: "a", title: "Budget 2026", text: "Postes de dépenses : loyer, énergie, assurance." });
  index.set({ id: "3", rev: "a", title: "Notes", text: "Rien de pertinent ici." });

  it("exige tous les mots, sans tenir compte des accents ni de la casse", () => {
    expect(
      index
        .search("LOYER")
        .map((h) => h.id)
        .sort(),
    ).toEqual(["1", "2"]);
    expect(index.search("loyer energie").map((h) => h.id)).toEqual(["2"]);
    expect(index.search("depenses")[0]!.id).toBe("2");
    expect(index.search("inexistant")).toEqual([]);
    expect(index.search("   ")).toEqual([]);
  });

  it("trouve les préfixes et classe un titre plus haut qu'un simple passage", () => {
    index.set({ id: "4", rev: "a", title: "Loyer", text: "" });
    const r = index.search("loy");
    expect(r[0]!.id).toBe("4");
    expect(r[0]!.titleMatch).toBe(true);
    expect(r.map((h) => h.id)).toContain("1");
  });

  it("restreint aux éléments permis", () => {
    expect(index.search("loyer", new Set(["2"])).map((h) => h.id)).toEqual(["2"]);
  });

  it("donne des plages de surlignage cohérentes avec l'extrait", () => {
    const hit = index.search("loyer").find((h) => h.id === "1")!;
    expect(hit.snippet).not.toBeNull();
    const seg = splitHighlight(hit.snippet!.text, hit.snippet!.ranges);
    const marked = seg.filter((s) => s.mark).map((s) => s.text.toLowerCase());
    expect(marked.length).toBeGreaterThan(0);
    expect(marked.every((m) => m === "loyer")).toBe(true);
  });

  it("surligne le titre avec les bons décalages malgré les accents", () => {
    const idx = new SearchIndex();
    idx.set({ id: "x", rev: "a", title: "Été à Paris", text: "" });
    const hit = idx.search("ete")[0]!;
    expect(splitHighlight("Été à Paris", hit.titleRanges).find((s) => s.mark)!.text).toBe("Été");
  });

  it("supprime et remplace une entrée", () => {
    const idx = new SearchIndex();
    idx.set({ id: "a", rev: "1", title: "Alpha", text: "" });
    idx.set({ id: "a", rev: "2", title: "Alpha", text: "bêta" });
    expect(idx.size).toBe(1);
    expect(idx.search("beta")).toHaveLength(1);
    idx.delete("a");
    expect(idx.search("beta")).toHaveLength(0);
  });
});

describe("extraits et plages", () => {
  it("fusionne les plages qui se touchent", () => {
    expect(
      mergeRanges([
        [5, 8],
        [0, 3],
        [3, 4],
        [7, 10],
      ]),
    ).toEqual([
      [0, 4],
      [5, 10],
    ]);
  });

  it("découpe en segments surlignés sans perdre de texte", () => {
    const segs = splitHighlight("abcdef", [
      [1, 3],
      [4, 5],
    ]);
    expect(segs.map((s) => s.text).join("")).toBe("abcdef");
    expect(segs.filter((s) => s.mark).map((s) => s.text)).toEqual(["bc", "e"]);
  });

  it("l'extrait borne la fenêtre et indique la coupure", () => {
    const text = "x".repeat(300) + " cible " + "y".repeat(300);
    const at = text.indexOf("cible");
    const s = makeSnippet(text, [[at, at + 5]]);
    expect(s.text.startsWith("… ")).toBe(true);
    expect(s.text.endsWith(" …")).toBe(true);
    expect(s.text.slice(s.ranges[0]![0], s.ranges[0]![1])).toBe("cible");
    expect(s.text.length).toBeLessThan(200);
  });
});

describe("indexation incrémentale", () => {
  function setup(opts: { secret?: { password: string }; extract?: (i: WorkItem) => Promise<string> } = {}) {
    const store = memoryKv<IndexRecord>();
    const index = new SearchIndex();
    const calls: string[] = [];
    const secretRef = { current: opts.secret as { password: string } | undefined };
    const progress: number[] = [];
    const indexer = new SearchIndexer({
      store,
      index,
      getSecret: () => secretRef.current,
      yieldNow: async () => {},
      extract:
        opts.extract ??
        (async (i) => {
          calls.push(i.id);
          return `contenu de ${i.title}`;
        }),
      onProgress: (p) => progress.push(p.done),
    });
    return { store, index, indexer, calls, secretRef, progress };
  }

  it("n'extrait que les éléments nouveaux ou modifiés, retire ceux qui disparaissent ou vont à la corbeille", async () => {
    const s = setup();
    const a = item({ id: "a", title: "Alpha" });
    const b = item({ id: "b", title: "Bravo" });
    await s.indexer.sync([a, b]);
    expect(s.calls.sort()).toEqual(["a", "b"]);
    await s.indexer.sync([a, b]);
    expect(s.calls).toHaveLength(2); // rien de neuf
    await s.indexer.sync([a, { ...b, modifiedAt: "2026-02-01T00:00:00.000Z" }]);
    expect(s.calls.filter((c) => c === "b")).toHaveLength(2);
    await s.indexer.sync([a, { ...b, trashedAt: "2026-02-02T00:00:00.000Z" }]);
    expect(s.index.has("b")).toBe(false);
    expect(s.store.snapshot().map((r) => r.id)).toEqual(["a"]);
  });

  it("un renommage suffit à relancer l'extraction", async () => {
    const s = setup();
    await s.indexer.sync([item({ id: "a", title: "Ancien" })]);
    await s.indexer.sync([item({ id: "a", title: "Nouveau" })]);
    expect(s.calls).toHaveLength(2);
    expect(s.index.search("nouveau")).toHaveLength(1);
  });

  it("recharge l'index persisté au démarrage sans ré-extraire", async () => {
    const s = setup();
    const a = item({ id: "a", title: "Alpha" });
    await s.indexer.sync([a]);
    const index2 = new SearchIndex();
    const calls2: string[] = [];
    const indexer2 = new SearchIndexer({
      store: s.store,
      index: index2,
      getSecret: () => undefined,
      yieldNow: async () => {},
      extract: async (i) => {
        calls2.push(i.id);
        return "";
      },
    });
    await indexer2.loadPersisted();
    expect(index2.search("alpha")).toHaveLength(1);
    await indexer2.sync([a]);
    expect(calls2).toEqual([]);
  });

  it("une erreur d'extraction ne bloque pas les autres (titre seul)", async () => {
    const errors: string[] = [];
    const store = memoryKv<IndexRecord>();
    const index = new SearchIndex();
    const indexer = new SearchIndexer({
      store,
      index,
      getSecret: () => undefined,
      yieldNow: async () => {},
      extract: async (i) => {
        if (i.id === "bad") throw new Error("illisible");
        return "ok";
      },
      onError: (i) => errors.push(i.id),
    });
    await indexer.sync([item({ id: "bad", title: "Cassé" }), item({ id: "good", title: "Bon" })]);
    expect(errors).toEqual(["bad"]);
    expect(index.search("casse")).toHaveLength(1); // trouvé par son titre
    expect(index.search("ok")).toHaveLength(1);
  });

  it("une synchronisation interrompue garde ce qui était fait et le persiste à la suivante", async () => {
    const store = memoryKv<IndexRecord>();
    const index = new SearchIndex();
    let n = 0;
    const indexerRef: SearchIndexer = new SearchIndexer({
      store,
      index,
      getSecret: () => undefined,
      yieldNow: async () => {},
      extract: async (i) => {
        if (++n === 2) indexerRef.cancel(); // interruption pendant le 2e élément
        return `t ${i.id}`;
      },
    });
    const items = [item({ id: "a" }), item({ id: "b" }), item({ id: "c" })];
    await indexerRef.sync(items);
    expect(index.size).toBeLessThan(3);
    await indexerRef.sync(items);
    expect(index.size).toBe(3);
    expect(store.snapshot()).toHaveLength(3); // tout est bien sur disque
  });

  it("avec le coffre : un seul enregistrement chiffré, jamais de texte en clair sur disque", async () => {
    const s = setup({ secret: { password: "coffre" } });
    await s.indexer.sync([item({ id: "a", title: "Confidentiel" })]);
    const records = s.store.snapshot();
    expect(records.map((r) => r.id)).toEqual([VAULT_BUNDLE_ID]);
    expect(JSON.stringify(records)).not.toContain("Confidentiel");
    expect(JSON.stringify(records)).not.toContain("contenu de");
    // Redémarrage avec le bon secret : l'index revient sans ré-extraction.
    const index2 = new SearchIndex();
    const calls: string[] = [];
    const i2 = new SearchIndexer({
      store: s.store,
      index: index2,
      getSecret: () => ({ password: "coffre" }),
      yieldNow: async () => {},
      extract: async (i) => (calls.push(i.id), ""),
    });
    await i2.sync([item({ id: "a", title: "Confidentiel" })]);
    expect(calls).toEqual([]);
    expect(index2.search("confidentiel")).toHaveLength(1);
  });

  it("avec un mauvais secret l'index est abandonné puis reconstruit", async () => {
    const s = setup({ secret: { password: "bon" } });
    await s.indexer.sync([item({ id: "a" })]);
    const calls: string[] = [];
    const i2 = new SearchIndexer({
      store: s.store,
      index: new SearchIndex(),
      getSecret: () => ({ password: "faux" }),
      yieldNow: async () => {},
      extract: async (i) => (calls.push(i.id), "x"),
    });
    await i2.sync([item({ id: "a" })]);
    expect(calls).toEqual(["a"]);
  });

  it("à l'activation du coffre, les entrées en clair sont supprimées", async () => {
    const s = setup();
    await s.indexer.sync([item({ id: "a", title: "Public" })]);
    expect(s.store.snapshot()[0]!.text).toContain("contenu");
    s.secretRef.current = { password: "coffre" };
    await s.indexer.reset();
    await s.indexer.sync([item({ id: "a", title: "Public" })]);
    expect(s.store.snapshot().map((r) => r.id)).toEqual([VAULT_BUNDLE_ID]);
  });

  it("ignore les éléments verrouillés et la corbeille, et expose la progression", async () => {
    const s = setup();
    await s.indexer.sync([
      item({ id: "a" }),
      item({ id: "l", locked: true }),
      item({ id: "t", trashedAt: "2026-01-02T00:00:00.000Z" }),
    ]);
    expect(s.calls).toEqual(["a"]);
    expect(s.progress).toContain(1);
  });

  it("revOf change avec la date et le titre", () => {
    expect(revOf({ modifiedAt: "x", title: "a" })).not.toBe(revOf({ modifiedAt: "x", title: "b" }));
  });
});

describe("recherche avec filtres", () => {
  const index = new SearchIndex();
  const items = [
    item({
      id: "1",
      title: "Contrat",
      kind: "doc",
      tags: ["juridique"],
      folderId: "f1",
      modifiedAt: "2026-09-01T00:00:00.000Z",
    }),
    item({ id: "2", title: "Budget", kind: "sheet", folderId: "f2", modifiedAt: "2026-09-05T00:00:00.000Z" }),
    item({ id: "3", title: "Contrat cadre", kind: "pdf", modifiedAt: "2026-08-01T00:00:00.000Z" }),
    item({ id: "4", title: "Vieux contrat", trashedAt: "2026-09-01T00:00:00.000Z" }),
  ];
  index.set({ id: "1", rev: revOf(items[0]!), title: "Contrat", text: "clause de résiliation" });
  index.set({ id: "2", rev: revOf(items[1]!), title: "Budget", text: "résiliation anticipée des contrats" });

  it("cherche dans le contenu et retrouve par le titre un élément pas encore indexé", () => {
    const r = runSearch(index, items, "résiliation", {});
    expect(r.map((x) => x.item.id).sort()).toEqual(["1", "2"]);
    const byTitle = runSearch(index, items, "cadre", {});
    expect(byTitle.map((x) => x.item.id)).toEqual(["3"]);
  });

  it("n'inclut jamais la corbeille", () => {
    expect(runSearch(index, items, "vieux", {})).toEqual([]);
  });

  it("filtre par type, dossier, étiquette et date", () => {
    expect(runSearch(index, items, "contrat", { kinds: ["pdf"] }).map((x) => x.item.id)).toEqual(["3"]);
    expect(runSearch(index, items, "résiliation", { folderId: "f2" }).map((x) => x.item.id)).toEqual(["2"]);
    expect(runSearch(index, items, "contrat", { tag: "juridique" }).map((x) => x.item.id)).toEqual(["1"]);
    expect(runSearch(index, items, "résiliation", { modifiedFrom: "2026-09-03" }).map((x) => x.item.id)).toEqual(["2"]);
  });

  it("inclut les sous-dossiers sur demande", () => {
    const r = runSearch(
      index,
      items,
      "résiliation",
      { folderId: "f1", includeSubfolders: true },
      new Set(["f1", "f2"]),
    );
    expect(r.map((x) => x.item.id).sort()).toEqual(["1", "2"]);
  });

  it("sans texte, liste les éléments filtrés du plus récent au plus ancien", () => {
    const r = runSearch(index, items, "", { kinds: ["doc", "sheet", "pdf"] });
    expect(r.map((x) => x.item.id)).toEqual(["2", "1", "3"]);
  });
});
