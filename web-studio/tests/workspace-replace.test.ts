import { describe, it, expect } from "vitest";
import {
  EncryptedDocument,
  applyReplacements,
  findInDoc,
  replaceInDoc,
  scanDocuments,
  undoReplacement,
  type ParsedDoc,
  type ReplaceDeps,
  type ReplaceOptions,
  type UndoRecord,
} from "../src/workspace/replace";
import { memoryKv } from "../src/workspace/kv";
import type { ProseMirrorNode } from "../src/format/types";
import type { WorkItem } from "../src/workspace/types";

const opts = (find: string, replace = "", extra: Partial<ReplaceOptions> = {}): ReplaceOptions => ({
  find,
  replace,
  caseSensitive: false,
  wholeWord: false,
  ...extra,
});

const text = (t: string, bold = false): ProseMirrorNode => ({
  type: "text",
  text: t,
  ...(bold ? { marks: [{ type: "bold" }] } : {}),
});
const para = (...kids: ProseMirrorNode[]): ProseMirrorNode => ({ type: "paragraph", content: kids });
const doc = (...blocks: ProseMirrorNode[]): ProseMirrorNode => ({ type: "doc", content: blocks });
const plain = (d: ProseMirrorNode): string =>
  (d.content ?? [])
    .map((b) => (b.content ?? []).map((c) => c.text ?? (c.type === "hardBreak" ? "\n" : "?")).join(""))
    .join("|");

describe("findInDoc", () => {
  it("trouve les occurrences avec leur contexte, sans tenir compte de la casse par défaut", () => {
    const d = doc(para(text("La société Acme signe. ACME paie.")));
    const m = findInDoc(d, opts("acme"));
    expect(m.map((x) => x.match)).toEqual(["Acme", "ACME"]);
    expect(m[0]!.before).toContain("société");
    expect(m[0]!.after.startsWith(" signe")).toBe(true);
    expect(findInDoc(d, opts("acme", "", { caseSensitive: true }))).toEqual([]);
  });

  it("mot entier : n'accroche pas l'intérieur d'un autre mot", () => {
    const d = doc(para(text("chat chatte achat chat.")));
    expect(findInDoc(d, opts("chat", "", { wholeWord: true })).map((m) => m.start)).toEqual([0, 18]);
    expect(findInDoc(d, opts("chat")).length).toBe(4);
  });

  it("une occurrence peut chevaucher plusieurs nœuds de texte (mise en forme au milieu du mot)", () => {
    const d = doc(para(text("Eli"), text("um", true), text(" est là")));
    const m = findInDoc(d, opts("elium"));
    expect(m).toHaveLength(1);
    expect(m[0]!.match).toBe("Elium");
  });

  it("traite les caractères spéciaux littéralement et ignore une recherche vide", () => {
    const d = doc(para(text("prix (HT) = 10.50 €")));
    expect(findInDoc(d, opts("(HT)")).length).toBe(1);
    expect(findInDoc(d, opts("10.50")).length).toBe(1);
    expect(findInDoc(d, opts("1x50")).length).toBe(0);
    expect(findInDoc(d, opts(""))).toEqual([]);
  });

  it("descend dans les tableaux et les listes ; ne traverse pas une image ou un saut de ligne", () => {
    const table: ProseMirrorNode = {
      type: "table",
      content: [{ type: "tableRow", content: [{ type: "tableCell", content: [para(text("alpha beta"))] }] }],
    };
    const d = doc(table, para(text("a"), { type: "hardBreak" }, text("b")));
    expect(findInDoc(d, opts("beta")).length).toBe(1);
    expect(findInDoc(d, opts("a\nb"))).toEqual([]);
  });
});

describe("replaceInDoc", () => {
  it("remplace dans un nœud, sans toucher l'original", () => {
    const d = doc(para(text("un deux trois")));
    const all = findInDoc(d, opts("deux"));
    const out = replaceInDoc(d, new Set(all.map((m) => m.id)), "2", opts("deux"));
    expect(plain(out)).toBe("un 2 trois");
    expect(plain(d)).toBe("un deux trois");
  });

  it("remplace sur plusieurs nœuds en gardant la mise en forme du début", () => {
    const d = doc(para(text("Eli", true), text("um"), text(" fort")));
    const m = findInDoc(d, opts("elium"));
    const out = replaceInDoc(d, new Set([m[0]!.id]), "Nova", opts("elium"));
    expect(plain(out)).toBe("Nova fort");
    expect(out.content![0]!.content![0]!.marks).toEqual([{ type: "bold" }]);
  });

  it("supprime les nœuds vidés (remplacement par du vide)", () => {
    const d = doc(para(text("a"), text("XYZ", true), text("b")));
    const m = findInDoc(d, opts("xyz"));
    const out = replaceInDoc(d, new Set([m[0]!.id]), "", opts("xyz"));
    expect(out.content![0]!.content!.map((c) => c.text)).toEqual(["a", "b"]);
  });

  it("applique seulement les occurrences choisies, plusieurs par bloc, du bon côté", () => {
    const d = doc(para(text("chat chat chat")));
    const m = findInDoc(d, opts("chat"));
    const out = replaceInDoc(d, new Set([m[0]!.id, m[2]!.id]), "chien", opts("chat"));
    expect(plain(out)).toBe("chien chat chien");
  });

  it("un remplacement plus long ou plus court ne décale pas les autres occurrences", () => {
    const d = doc(para(text("aa bb aa bb aa")));
    const m = findInDoc(d, opts("aa"));
    const out = replaceInDoc(d, new Set(m.map((x) => x.id)), "longueur", opts("aa"));
    expect(plain(out)).toBe("longueur bb longueur bb longueur");
  });

  it("des blocs différents sont traités indépendamment", () => {
    const d = doc(para(text("x1")), para(text("x2")), para(text("y")));
    const m = findInDoc(d, opts("x"));
    const out = replaceInDoc(d, new Set([m[1]!.id]), "Z", opts("x"));
    expect(plain(out)).toBe("x1|Z2|y");
  });
});

// --- Orchestration ---------------------------------------------------------

function world(
  docs: Record<string, { doc: ProseMirrorNode; signed?: boolean; sealed?: boolean; encrypted?: boolean }>,
) {
  const files = new Map<string, { content: ProseMirrorNode; version: string }>();
  for (const [id, d] of Object.entries(docs)) files.set(id, { content: d.doc, version: "v0" });
  const writes: string[] = [];
  let tick = 0;
  const undo = memoryKv<UndoRecord>();
  const encode = (d: ProseMirrorNode) => new TextEncoder().encode(JSON.stringify(d));
  const secretRef = { current: undefined as { password: string } | undefined };
  const deps: ReplaceDeps = {
    async read(id) {
      const f = files.get(id);
      return f && { bytes: encode(f.content), version: f.version };
    },
    async parse(bytes): Promise<ParsedDoc> {
      const content = JSON.parse(new TextDecoder().decode(bytes)) as ProseMirrorNode;
      const id = [...files.entries()].find(([, f]) => JSON.stringify(f.content) === JSON.stringify(content))?.[0];
      const meta = id ? docs[id] : undefined;
      if (meta?.encrypted) throw new EncryptedDocument("chiffré");
      return { doc: content, signed: !!meta?.signed, sealed: !!meta?.sealed, rewrite: async (n) => encode(n) };
    },
    async write(id, bytes) {
      files.set(id, { content: JSON.parse(new TextDecoder().decode(bytes)), version: `v${++tick}` });
      writes.push(id);
      return `v${tick}`;
    },
    undo,
    getSecret: () => secretRef.current,
    now: () => new Date("2026-10-01T10:00:00Z"),
    newId: () => `b${tick}`,
  };
  return { deps, files, writes, undo, secretRef };
}

const docItem = (id: string, extra: Partial<WorkItem> = {}): WorkItem => ({
  id,
  kind: "doc",
  contentStore: "drive",
  title: `Doc ${id}`,
  size: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  modifiedAt: "2026-01-01T00:00:00.000Z",
  folderId: null,
  tags: [],
  starred: false,
  vaultProtected: false,
  ...extra,
});

describe("scanDocuments", () => {
  it("ne garde que les documents qui contiennent l'occurrence et signale chiffré / signé / scellé", async () => {
    const w = world({
      a: { doc: doc(para(text("Acme SA"))) },
      b: { doc: doc(para(text("rien"))) },
      c: { doc: doc(para(text("Acme"))), signed: true, sealed: true },
      d: { doc: doc(para(text("Acme chiffré"))), encrypted: true },
    });
    const items = [
      docItem("a"),
      docItem("b"),
      docItem("c"),
      docItem("d"),
      docItem("e", { kind: "sheet", contentStore: "sheets" }),
      docItem("f", { trashedAt: "2026-01-02T00:00:00.000Z" }),
    ];
    const scans = await scanDocuments(items, opts("acme"), w.deps);
    expect(scans.map((s) => [s.itemId, s.status, s.signed, s.sealed])).toEqual([
      ["a", "ok", false, false],
      ["c", "ok", true, true],
      ["d", "encrypted", false, false],
    ]);
  });

  it("remonte une erreur de lecture sans interrompre l'analyse", async () => {
    const w = world({ a: { doc: doc(para(text("acme"))) } });
    const items = [docItem("ghost"), docItem("a")];
    const scans = await scanDocuments(items, opts("acme"), w.deps);
    expect(scans.find((s) => s.itemId === "ghost")!.status).toBe("error");
    expect(scans.find((s) => s.itemId === "a")!.status).toBe("ok");
  });
});

describe("applyReplacements et annulation", () => {
  const O = opts("acme", "Nova");

  it("applique la sélection, journalise l'original puis annule exactement", async () => {
    const w = world({ a: { doc: doc(para(text("Acme et acme"))) }, b: { doc: doc(para(text("Acme"))) } });
    const scans = await scanDocuments([docItem("a"), docItem("b")], O, w.deps);
    const sel = new Map<string, Set<string>>();
    sel.set("a", new Set([scans[0]!.matches[0]!.id])); // seulement la 1re occurrence de a
    // b non sélectionné
    const r = await applyReplacements(scans, sel, O, w.deps);
    expect(r).toMatchObject({ replaced: 1, documents: 1 });
    expect(plain(w.files.get("a")!.content)).toBe("Nova et acme");
    expect(plain(w.files.get("b")!.content)).toBe("Acme");
    expect(w.writes).toEqual(["a"]);

    const u = await undoReplacement(r.batchId!, w.deps);
    expect(u.restored).toBe(1);
    expect(plain(w.files.get("a")!.content)).toBe("Acme et acme");
    expect(await w.undo.get(r.batchId!)).toBeUndefined(); // lot consommé
  });

  it("refuse d'écraser un document modifié depuis l'analyse", async () => {
    const w = world({ a: { doc: doc(para(text("acme"))) } });
    const scans = await scanDocuments([docItem("a")], O, w.deps);
    w.files.set("a", { content: doc(para(text("acme modifié par l'utilisateur"))), version: "v-autre" });
    const sel = new Map([["a", new Set(scans[0]!.matches.map((m) => m.id))]]);
    const r = await applyReplacements(scans, sel, O, w.deps);
    expect(r.documents).toBe(0);
    expect(r.skipped).toEqual([{ itemId: "a", title: "Doc a", reason: "changed" }]);
    expect(w.writes).toEqual([]);
  });

  it("l'annulation ne touche pas un document modifié depuis le remplacement", async () => {
    const w = world({ a: { doc: doc(para(text("acme"))) } });
    const scans = await scanDocuments([docItem("a")], O, w.deps);
    const r = await applyReplacements(scans, new Map([["a", new Set(scans[0]!.matches.map((m) => m.id))]]), O, w.deps);
    w.files.set("a", { content: doc(para(text("travail récent"))), version: "v-recent" });
    const u = await undoReplacement(r.batchId!, w.deps);
    expect(u.restored).toBe(0);
    expect(u.skipped[0]).toMatchObject({ title: "Doc a", reason: "changed" });
    expect(plain(w.files.get("a")!.content)).toBe("travail récent");
  });

  it("une erreur sur un document n'empêche pas les autres, et rien n'est journalisé s'il n'y a eu aucune écriture", async () => {
    const w = world({ a: { doc: doc(para(text("acme"))) }, b: { doc: doc(para(text("acme"))) } });
    const scans = await scanDocuments([docItem("a"), docItem("b")], O, w.deps);
    const realWrite = w.deps.write;
    w.deps.write = async (id, bytes, title) => {
      if (id === "a") throw new Error("disque plein");
      return realWrite(id, bytes, title);
    };
    const sel = new Map(scans.map((s) => [s.itemId, new Set(s.matches.map((m) => m.id))]));
    const r = await applyReplacements(scans, sel, O, w.deps);
    expect(r.documents).toBe(1);
    expect(r.skipped).toEqual([{ itemId: "a", title: "Doc a", reason: "error", message: "disque plein" }]);
    const none = await applyReplacements(scans.slice(0, 1), new Map(), O, w.deps);
    expect(none.batchId).toBeNull();
  });

  it("avec le coffre : l'original journalisé est chiffré, et l'annulation exige le coffre déverrouillé", async () => {
    const w = world({ a: { doc: doc(para(text("acme secret"))) } });
    w.secretRef.current = { password: "coffre" };
    const scans = await scanDocuments([docItem("a")], O, w.deps);
    const r = await applyReplacements(scans, new Map([["a", new Set(scans[0]!.matches.map((m) => m.id))]]), O, w.deps);
    const rec = (await w.undo.get(r.batchId!))!;
    expect(JSON.stringify(rec)).not.toContain("secret");
    expect(rec.entries[0]!.bytes).toBeUndefined();
    w.secretRef.current = undefined;
    const locked = await undoReplacement(r.batchId!, w.deps);
    expect(locked.restored).toBe(0);
    expect(locked.skipped[0]!.reason).toBe("error");
    w.secretRef.current = { password: "coffre" };
    const ok = await undoReplacement(r.batchId!, w.deps);
    expect(ok.restored).toBe(1);
    expect(plain(w.files.get("a")!.content)).toBe("acme secret");
  });

  it("ne garde que les 3 dernières opérations annulables", async () => {
    const w = world({ a: { doc: doc(para(text("acme"))) } });
    let n = 0;
    for (let i = 0; i < 5; i++) {
      w.files.set("a", { content: doc(para(text("acme"))), version: `base${i}` });
      w.deps.now = () => new Date(Date.UTC(2026, 9, 1, 10, i));
      w.deps.newId = () => `b${n++}`;
      const scans = await scanDocuments([docItem("a")], O, w.deps);
      await applyReplacements(scans, new Map([["a", new Set(scans[0]!.matches.map((m) => m.id))]]), O, w.deps);
    }
    expect((await w.undo.keys()).sort()).toEqual(["b2", "b3", "b4"]);
  });

  it("annuler un lot inconnu échoue clairement", async () => {
    const w = world({});
    await expect(undoReplacement("nope", w.deps)).rejects.toThrow(/plus être annulée/);
  });
});
