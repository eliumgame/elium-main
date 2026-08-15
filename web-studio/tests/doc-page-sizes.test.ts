import { describe, it, expect } from "vitest";
import {
  DEFAULT_CUSTOM_MM,
  MAX_PAGE_MM,
  MIN_PAGE_MM,
  PAGE_FORMATS,
  PAGE_FORMAT_LABELS,
  PAGE_SIZES_MM,
  formatSizeMm,
  pageSizeMm,
  pageSizeOf,
} from "../src/format/pageSizes";
import type { PageSettings } from "../src/format/types";

describe("Formats de page — table", () => {
  it("expose un libellé pour chaque format offert", () => {
    for (const f of PAGE_FORMATS) {
      expect(PAGE_FORMAT_LABELS[f], `libellé manquant pour ${f}`).toBeTruthy();
    }
  });

  it("donne les dimensions ISO et US attendues", () => {
    expect(PAGE_SIZES_MM.A4).toEqual({ width: 210, height: 297 });
    expect(PAGE_SIZES_MM.A3).toEqual({ width: 297, height: 420 });
    expect(PAGE_SIZES_MM.A5).toEqual({ width: 148, height: 210 });
    expect(PAGE_SIZES_MM.Letter).toEqual({ width: 216, height: 279 });
    expect(PAGE_SIZES_MM.Legal).toEqual({ width: 216, height: 356 });
    expect(PAGE_SIZES_MM.Tabloid).toEqual({ width: 279, height: 432 });
  });

  it("garde la relation A(n+1) = moitié de A(n)", () => {
    // A3 → A4 → A5 → A6 : la hauteur devient la largeur, à 1 mm d'arrondi près.
    expect(PAGE_SIZES_MM.A4.height).toBe(PAGE_SIZES_MM.A3.width);
    expect(PAGE_SIZES_MM.A5.height).toBe(PAGE_SIZES_MM.A4.width);
    expect(PAGE_SIZES_MM.A6.height).toBe(PAGE_SIZES_MM.A5.width);
  });

  it("est en portrait dans la table (hauteur > largeur)", () => {
    for (const [name, s] of Object.entries(PAGE_SIZES_MM)) {
      expect(s.height, `${name} devrait être en portrait`).toBeGreaterThan(s.width);
    }
  });
});

describe("Formats de page — orientation", () => {
  it("échange largeur et hauteur en paysage", () => {
    expect(pageSizeMm("A4", "portrait")).toEqual({ width: 210, height: 297 });
    expect(pageSizeMm("A4", "landscape")).toEqual({ width: 297, height: 210 });
  });

  it("fonctionne pour tous les formats", () => {
    for (const f of PAGE_FORMATS) {
      const p = pageSizeMm(f, "portrait");
      const l = pageSizeMm(f, "landscape");
      expect(l.width).toBe(p.height);
      expect(l.height).toBe(p.width);
    }
  });
});

describe("Formats de page — personnalisé", () => {
  it("utilise les dimensions fournies", () => {
    expect(formatSizeMm("Custom", { widthMm: 120, heightMm: 200 })).toEqual({ width: 120, height: 200 });
  });

  it("retombe sur A4 sans dimensions", () => {
    expect(formatSizeMm("Custom")).toEqual(DEFAULT_CUSTOM_MM);
  });

  it("borne les valeurs absurdes", () => {
    expect(formatSizeMm("Custom", { widthMm: 1, heightMm: 99999 })).toEqual({
      width: MIN_PAGE_MM,
      height: MAX_PAGE_MM,
    });
    expect(formatSizeMm("Custom", { widthMm: Number.NaN })).toMatchObject({ width: DEFAULT_CUSTOM_MM.width });
  });

  it("s'oriente comme les autres formats", () => {
    expect(pageSizeMm("Custom", "landscape", { widthMm: 120, heightMm: 200 })).toEqual({ width: 200, height: 120 });
  });
});

describe("Formats de page — depuis PageSettings", () => {
  const base: PageSettings = {
    format: "A4",
    orientation: "portrait",
    margins: { top: 25, right: 20, bottom: 25, left: 20 },
  };

  it("lit le format et l'orientation du document", () => {
    expect(pageSizeOf(base)).toEqual({ width: 210, height: 297 });
    expect(pageSizeOf({ ...base, format: "Legal" })).toEqual({ width: 216, height: 356 });
    expect(pageSizeOf({ ...base, orientation: "landscape" })).toEqual({ width: 297, height: 210 });
  });

  it("lit les dimensions personnalisées du document", () => {
    expect(pageSizeOf({ ...base, format: "Custom", customWidthMm: 150, customHeightMm: 240 })).toEqual({
      width: 150,
      height: 240,
    });
  });

  it("tolère un format inconnu venant d'un fichier plus récent", () => {
    expect(pageSizeOf({ ...base, format: "Inconnu" as PageSettings["format"] })).toEqual({ width: 210, height: 297 });
  });
});
