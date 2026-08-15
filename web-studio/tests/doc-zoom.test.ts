import { describe, it, expect } from "vitest";
import {
  MAX_ZOOM,
  MIN_ZOOM,
  ZOOM_STEPS,
  clampZoom,
  fitPageZoom,
  fitWidthZoom,
  resolveZoom,
  shouldAutoFit,
  stepZoom,
  zoomLabel,
} from "../src/editor/zoom";

// A4 at 96dpi: 210mm ≈ 794px, 297mm ≈ 1123px.
const A4 = { pageWidth: 794, pageHeight: 1123 };

describe("Zoom — bornes", () => {
  it("borne les valeurs hors plage", () => {
    expect(clampZoom(0.01)).toBe(MIN_ZOOM);
    expect(clampZoom(99)).toBe(MAX_ZOOM);
    expect(clampZoom(1.25)).toBe(1.25);
  });

  it("retombe sur 100 % pour une valeur non finie", () => {
    // NaN et Infinity ne sont pas des zooms : on revient à 100 % plutôt que de
    // borner, sans quoi un calcul raté afficherait le document à 400 %.
    expect(clampZoom(Number.NaN)).toBe(1);
    expect(clampZoom(Number.POSITIVE_INFINITY)).toBe(1);
  });
});

describe("Zoom — ajustement à la largeur", () => {
  it("ajuste la feuille à la largeur disponible", () => {
    const z = fitWidthZoom({ ...A4, viewportWidth: 397, viewportHeight: 800 });
    expect(z).toBeCloseTo(0.5, 2);
  });

  it("tient compte des marges du conteneur", () => {
    const z = fitWidthZoom({ ...A4, viewportWidth: 397, viewportHeight: 800, gutter: 8 });
    expect(z).toBeCloseTo((397 - 16) / 794, 3);
  });

  it("agrandit quand la place est large", () => {
    expect(fitWidthZoom({ ...A4, viewportWidth: 1588, viewportHeight: 900 })).toBeCloseTo(2, 2);
  });

  it("reste neutre sur des dimensions absurdes", () => {
    expect(fitWidthZoom({ ...A4, viewportWidth: 0, viewportHeight: 0 })).toBe(1);
    expect(fitWidthZoom({ pageWidth: 0, pageHeight: 0, viewportWidth: 500, viewportHeight: 500 })).toBe(1);
    expect(fitWidthZoom({ ...A4, viewportWidth: 10, viewportHeight: 800, gutter: 40 })).toBe(1);
  });
});

describe("Zoom — page entière", () => {
  it("retient la dimension la plus contraignante", () => {
    // La hauteur contraint : 561/1123 < 794/794.
    const z = fitPageZoom({ ...A4, viewportWidth: 794, viewportHeight: 561 });
    expect(z).toBeCloseTo(561 / 1123, 3);
  });

  it("retient la largeur quand c'est elle qui contraint", () => {
    const z = fitPageZoom({ ...A4, viewportWidth: 397, viewportHeight: 2000 });
    expect(z).toBeCloseTo(0.5, 2);
  });

  it("ne dépasse jamais les bornes", () => {
    expect(fitPageZoom({ ...A4, viewportWidth: 100000, viewportHeight: 100000 })).toBe(MAX_ZOOM);
  });
});

describe("Zoom — résolution du mode", () => {
  const input = { ...A4, viewportWidth: 397, viewportHeight: 800 };

  it("respecte la valeur manuelle", () => {
    expect(resolveZoom("manual", 1.5, input)).toBe(1.5);
  });

  it("recalcule pour les modes ajustés", () => {
    expect(resolveZoom("fitWidth", 1.5, input)).toBeCloseTo(0.5, 2);
    expect(resolveZoom("fitPage", 1.5, input)).toBeCloseTo(Math.min(397 / 794, 800 / 1123), 3);
  });
});

describe("Zoom — pas à pas", () => {
  it("monte et descend par paliers", () => {
    expect(stepZoom(1, 1)).toBe(1.25);
    expect(stepZoom(1, -1)).toBe(0.9);
    expect(stepZoom(0.5, -1)).toBeCloseTo(0.4, 5);
  });

  it("dépasse les paliers en multipliant", () => {
    expect(stepZoom(2, 1)).toBeCloseTo(2.5, 5);
  });

  it("part du palier voisin depuis une valeur intermédiaire", () => {
    expect(stepZoom(0.83, 1)).toBe(0.9);
    expect(stepZoom(0.83, -1)).toBe(0.75);
  });

  it("reste dans les bornes", () => {
    expect(stepZoom(MAX_ZOOM, 1)).toBe(MAX_ZOOM);
    expect(stepZoom(MIN_ZOOM, -1)).toBe(MIN_ZOOM);
  });
});

describe("Zoom — ajustement automatique", () => {
  it("s'active seulement quand la feuille ne rentre pas", () => {
    expect(shouldAutoFit({ ...A4, viewportWidth: 375, viewportHeight: 700, gutter: 8 })).toBe(true);
    expect(shouldAutoFit({ ...A4, viewportWidth: 1280, viewportHeight: 800, gutter: 32 })).toBe(false);
  });

  it("tient compte des marges à la limite", () => {
    expect(shouldAutoFit({ ...A4, viewportWidth: 810, viewportHeight: 800, gutter: 8 })).toBe(false);
    expect(shouldAutoFit({ ...A4, viewportWidth: 808, viewportHeight: 800, gutter: 8 })).toBe(true);
  });
});

describe("Zoom — libellé", () => {
  it("formate en pourcentage arrondi", () => {
    expect(zoomLabel(1)).toBe("100 %");
    expect(zoomLabel(0.475)).toBe("48 %");
    expect(zoomLabel(2)).toBe("200 %");
  });

  it("expose des paliers cohérents et croissants", () => {
    const steps = [...ZOOM_STEPS];
    expect(steps).toEqual([...steps].sort((a, b) => a - b));
    expect(steps).toContain(1);
  });
});
