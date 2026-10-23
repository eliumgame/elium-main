import { describe, expect, it } from "vitest";
import { MAX_COMBINED_RECORDS, mergeCombined, mergeCombinedAsync, type MergeData } from "../src/editor/mailmerge";
import type { ProseMirrorNode } from "../src/format/types";

const doc: ProseMirrorNode = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [
        { type: "text", text: "Bonjour " },
        { type: "mergeField", attrs: { field: "nom" } },
      ],
    },
  ],
};
const data = (n: number): MergeData => ({
  fields: ["nom"],
  records: Array.from({ length: n }, (_, i) => ({ nom: `Client ${i}` })),
});

describe("publipostage coopératif", () => {
  it("donne le même document que la version synchrone", async () => {
    const d = data(30);
    expect(await mergeCombinedAsync(doc, d, { selected: [0, 5, 7] })).toEqual(
      mergeCombined(doc, d, { selected: [0, 5, 7] }),
    );
    expect(await mergeCombinedAsync(doc, d)).toEqual(mergeCombined(doc, d));
  });

  it("ignore les indices hors plage et renvoie un document valide si rien n'est sélectionné", async () => {
    const out = await mergeCombinedAsync(doc, data(2), { selected: [9] });
    expect(out.content).toEqual([{ type: "paragraph" }]);
  });

  it("rend la main au navigateur pendant une grosse fusion", async () => {
    let turns = 0;
    const big = data(MAX_COMBINED_RECORDS);
    // Un modèle volumineux rend chaque enregistrement coûteux : plusieurs tranches attendues.
    const heavy: ProseMirrorNode = {
      type: "doc",
      content: Array.from({ length: 400 }, () => doc.content![0]!),
    };
    await mergeCombinedAsync(heavy, big, {}, () => (turns += 1));
    expect(turns).toBeGreaterThan(0);
  });

  it("le plafond est de 200 enregistrements", () => {
    expect(MAX_COMBINED_RECORDS).toBe(200);
  });
});
