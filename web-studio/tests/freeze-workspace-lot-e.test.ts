import { describe, expect, it } from "vitest";
import { strToU8, unzipSync, zipSync } from "fflate";
import { unzipCooperative, zipCooperative } from "../src/format/coop-zip";
import { foldChar, foldText } from "../src/workspace/search/text";
import {
  MAX_BACKUP_TOTAL_BYTES,
  decodeBackup,
  decodeBackupAsync,
  encodeBackup,
  encodeBackupAsync,
  type BackupSnapshot,
} from "../src/workspace/backup";
import { BackupTooLargeError, collectSnapshot, type BackupDeps } from "../src/workspace/backup-io";
import type { WorkItem } from "../src/workspace/types";

const slow = (s: string) => {
  let out = "";
  for (let i = 0; i < s.length; i++) out += foldChar(s[i]!);
  return out;
};

describe("pliage du texte de recherche", () => {
  it("donne le même résultat que le pliage caractère par caractère", () => {
    const samples = [
      "Hello World 123",
      "Éléphant à l'été — ÇA va ? Œuvre naïve, Straße ŒIL ǅ İstanbul ﬁn",
      "日本語のテキスト ÀÉÎÕÜ ñ",
      "ábc 😀 x",
      "",
    ];
    for (const s of samples) {
      expect(foldText(s)).toBe(slow(s));
      expect(foldText(s).length).toBe(s.length);
    }
  });
  it("replie 2 millions de caractères accentués sans pause longue", () => {
    const s = "Élève à l'école, déjà là. ".repeat(80_000);
    const t0 = performance.now();
    const f = foldText(s);
    expect(performance.now() - t0).toBeLessThan(1500);
    expect(f.startsWith("eleve a l'ecole, deja la.")).toBe(true);
  });
});

describe("zip coopératif", () => {
  const files = {
    "a.txt": strToU8("bonjour ".repeat(100_000)),
    "dir/b.bin": new Uint8Array(300_000).map((_, i) => (i * 31) % 251),
    "vide.txt": new Uint8Array(0),
  };
  it("produit une archive lisible par unzipSync", async () => {
    const zip = await zipCooperative(files, 4);
    const back = unzipSync(zip);
    expect(Object.keys(back).sort()).toEqual(Object.keys(files).sort());
    for (const k of Object.keys(files))
      expect(Array.from(back[k]!)).toEqual(Array.from(files[k as keyof typeof files]));
  });
  it("relit par lots et applique le filtre", async () => {
    const zip = zipSync(files);
    const seen: string[] = [];
    const back = await unzipCooperative(zip, (f) => {
      seen.push(f.name);
      return f.name !== "dir/b.bin";
    });
    expect(Object.keys(back).sort()).toEqual(["a.txt", "vide.txt"]);
    expect(seen.sort()).toEqual(["a.txt", "dir/b.bin", "vide.txt"]);
  });
  it("propage le refus d'un filtre", async () => {
    const zip = zipSync(files);
    await expect(
      unzipCooperative(zip, () => {
        throw new Error("refusé");
      }),
    ).rejects.toThrow("refusé");
  });
});

describe("sauvegarde de l'espace de travail : variantes coopératives", () => {
  const item = (id: string): WorkItem =>
    ({
      id,
      kind: "pdf",
      contentStore: "pdfs",
      title: `Élément ${id}`,
      size: 10,
      createdAt: "2026-01-01T00:00:00.000Z",
      modifiedAt: "2026-01-02T00:00:00.000Z",
      folderId: null,
      tags: [],
      starred: false,
      vaultProtected: false,
    }) as WorkItem;
  const snap = (): BackupSnapshot => ({
    createdAt: "2026-01-03T00:00:00.000Z",
    folders: [],
    items: [item("a"), item("b")],
    contents: new Map([
      ["pdfs/a", new Uint8Array(2_000_000).map((_, i) => i % 200)],
      ["pdfs/b", strToU8("petit")],
    ]),
    settings: {},
    secrets: {},
  });
  it("encodeBackupAsync / decodeBackupAsync : mêmes données que la version synchrone", async () => {
    const s = snap();
    const zipA = await encodeBackupAsync(s, { includeSecrets: false });
    const a = await decodeBackupAsync(zipA);
    const b = decodeBackup(encodeBackup(s, { includeSecrets: false }));
    expect(a.manifest).toEqual(b.manifest);
    expect(a.snapshot.items).toEqual(b.snapshot.items);
    expect([...a.snapshot.contents.keys()].sort()).toEqual(["pdfs/a", "pdfs/b"]);
    expect(Array.from(a.snapshot.contents.get("pdfs/a")!)).toEqual(Array.from(s.contents.get("pdfs/a")!));
  });
  it("refuse une archive illisible", async () => {
    await expect(decodeBackupAsync(strToU8("pas une archive"))).rejects.toThrow(/sauvegarde/i);
  });
  it("plafond global à la collecte", async () => {
    const huge = { length: MAX_BACKUP_TOTAL_BYTES / 2 + 1 } as unknown as Uint8Array;
    const deps = {
      catalog: { load: async () => ({ items: [item("a"), item("b")], folders: [] }) },
      contents: {
        pdfs: { read: async () => huge, write: async () => {} },
        drive: { read: async () => undefined, write: async () => {} },
        sheets: { read: async () => undefined, write: async () => {} },
        slides: { read: async () => undefined, write: async () => {} },
      },
      getSecret: () => undefined,
      storage: { get: () => null, set: () => {} },
    } as unknown as BackupDeps;
    await expect(collectSnapshot(deps, { includeSecrets: false })).rejects.toBeInstanceOf(BackupTooLargeError);
  });
});
