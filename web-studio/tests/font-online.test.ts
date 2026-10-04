import { describe, it, expect } from "vitest";
import { parseCatalog, planVariants, variantName } from "../src/ui/font-online";

describe("parseCatalog", () => {
  it("garde les champs utiles, trie par nom et ignore les entrées invalides", () => {
    const out = parseCatalog([
      {
        id: "zilla",
        family: "Zilla Slab",
        weights: [400, 700],
        styles: ["normal"],
        category: "serif",
        license: "OFL-1.1",
      },
      {
        id: "abel",
        family: "Abel",
        weights: [400],
        styles: ["normal", "italic"],
        defSubset: "latin",
        category: "sans-serif",
      },
      { id: "broken" },
      { id: "noweights", family: "X", weights: [] },
      null,
      42,
    ]);
    expect(out.map((f) => f.id)).toEqual(["abel", "zilla"]);
    expect(out[0]).toMatchObject({ family: "Abel", defSubset: "latin", styles: ["normal", "italic"] });
  });

  it("tolère une réponse qui n'est pas une liste", () => {
    expect(parseCatalog({ error: "x" })).toEqual([]);
    expect(parseCatalog(undefined)).toEqual([]);
  });
});

describe("variantName", () => {
  it("nomme les variantes comme dans les sélecteurs de traitement de texte", () => {
    expect(variantName("Roboto", 400, "normal")).toBe("Roboto");
    expect(variantName("Roboto", 700, "normal")).toBe("Roboto Bold");
    expect(variantName("Roboto", 400, "italic")).toBe("Roboto Italic");
    expect(variantName("Roboto", 700, "italic")).toBe("Roboto Bold Italic");
    expect(variantName("Roboto", 300, "normal")).toBe("Roboto Light");
    expect(variantName("Roboto", 450, "normal")).toBe("Roboto 450");
  });
});

const url = (id: string, subset: string, w: number, s: string) =>
  `https://cdn.jsdelivr.net/fontsource/fonts/${id}@latest/${subset}-${w}-${s}.woff2`;
const face = (id: string, subset: string, w: number, s: string) => ({ url: { woff2: url(id, subset, w, s) } });

describe("planVariants", () => {
  it("prend normal + gras, droit + italique, en latin", () => {
    const detail = {
      family: "Lora",
      defSubset: "latin",
      variants: {
        "400": {
          normal: { latin: face("lora", "latin", 400, "normal"), cyrillic: face("lora", "cyrillic", 400, "normal") },
          italic: { latin: face("lora", "latin", 400, "italic") },
        },
        "500": { normal: { latin: face("lora", "latin", 500, "normal") } },
        "700": {
          normal: { latin: face("lora", "latin", 700, "normal") },
          italic: { latin: face("lora", "latin", 700, "italic") },
        },
      },
    };
    expect(planVariants(detail).map((v) => v.name)).toEqual(["Lora", "Lora Italic", "Lora Bold", "Lora Bold Italic"]);
    expect(planVariants(detail).every((v) => v.url.includes("/latin-"))).toBe(true);
  });

  it("retombe sur la graisse la plus proche de 400 quand ni 400 ni 700 n'existent", () => {
    const detail = {
      family: "Thin One",
      variants: {
        "100": { normal: { latin: face("t", "latin", 100, "normal") } },
        "300": { normal: { latin: face("t", "latin", 300, "normal") } },
      },
    };
    expect(planVariants(detail).map((v) => v.name)).toEqual(["Thin One Light"]);
  });

  it("utilise le sous-ensemble par défaut quand il n'y a pas de latin", () => {
    const detail = {
      family: "Noto Korean",
      defSubset: "korean",
      variants: { "400": { normal: { korean: face("nk", "korean", 400, "normal") } } },
    };
    const plan = planVariants(detail);
    expect(plan).toHaveLength(1);
    expect(plan[0]!.url).toContain("korean-400-normal");
  });

  it("renvoie une liste vide pour une famille sans fichiers", () => {
    expect(planVariants({ family: "Empty" })).toEqual([]);
    expect(planVariants({ family: "Empty", variants: {} })).toEqual([]);
  });
});
