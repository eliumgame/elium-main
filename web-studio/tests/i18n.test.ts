import { describe, it, expect } from "vitest";
import { catalogs, en, fr } from "../src/i18n/catalog";
import {
  createTranslator,
  formatBytes,
  formatDate,
  formatNumber,
  formatRelative,
  interpolate,
  pluralCategory,
} from "../src/i18n/core";

const params = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();

describe("catalogues", () => {
  it("l'anglais contient chaque clé du français, et rien de plus", () => {
    const frKeys = Object.keys(fr).sort();
    const enKeys = Object.keys(en).sort();
    expect(frKeys.filter((k) => !(k in en))).toEqual([]); // clés manquantes en anglais
    expect(enKeys.filter((k) => !(k in fr))).toEqual([]); // clés orphelines
  });

  it("aucune valeur vide", () => {
    for (const [k, v] of Object.entries(fr)) expect(v.trim(), `fr:${k}`).not.toBe("");
    for (const [k, v] of Object.entries(en)) expect(v.trim(), `en:${k}`).not.toBe("");
  });

  it("les paramètres {x} sont les mêmes dans les deux langues", () => {
    for (const k of Object.keys(fr) as (keyof typeof fr)[]) {
      expect(params(en[k]), `paramètres de ${k}`).toEqual(params(fr[k]));
    }
  });

  it("chaque pluriel déclare _one ET _other, dans les deux langues", () => {
    for (const cat of [fr, en] as Record<string, string>[]) {
      for (const k of Object.keys(cat)) {
        if (k.endsWith("_one")) expect(cat[k.replace(/_one$/, "_other")], k).toBeDefined();
        if (k.endsWith("_other")) expect(cat[k.replace(/_other$/, "_one")], k).toBeDefined();
      }
    }
  });

  it("les clés suivent la convention zone.nom (snake_case ; camelCase toléré pour les identifiants de raccourcis)", () => {
    for (const k of Object.keys(fr)) expect(k).toMatch(/^[a-z0-9_]+(\.[a-zA-Z0-9_]+)+$/);
  });
});

describe("traducteur", () => {
  const tr = (l: "fr" | "en") => createTranslator(l, catalogs);

  it("interpole les paramètres et laisse visible un paramètre manquant", () => {
    expect(interpolate("a {x} b {y}", { x: 1 })).toBe("a 1 b {y}");
    expect(tr("fr").t("replace.scanning", { done: 2, total: 5 })).toBe("Analyse… 2 / 5");
    expect(tr("en").t("replace.scanning", { done: 2, total: 5 })).toBe("Scanning… 2 / 5");
  });

  it("choisit le pluriel selon la langue (0 et 1 sont « un » en français)", () => {
    expect(tr("fr").tn("search.results", 0)).toBe("0 résultat");
    expect(tr("fr").tn("search.results", 1)).toBe("1 résultat");
    expect(tr("fr").tn("search.results", 2)).toBe("2 résultats");
    expect(tr("en").tn("search.results", 0)).toBe("0 results");
    expect(tr("en").tn("search.results", 1)).toBe("1 result");
    expect(pluralCategory("fr", 1000000)).toBe("many");
  });

  it("formate les grands nombres selon la langue", () => {
    expect(tr("fr").tn("search.results", 1234).replace(/\s| /g, " ")).toBe("1 234 résultats");
    expect(tr("en").tn("search.results", 1234)).toBe("1,234 results");
  });

  it("retombe sur le français puis sur la clé elle-même", () => {
    const cats = { fr: { a: "A fr", b: "B fr" }, en: { a: "A en" } };
    const t = createTranslator("en", cats);
    expect(t.t("a")).toBe("A en");
    expect(t.t("b")).toBe("B fr");
    expect(t.t("zzz")).toBe("zzz");
  });
});

describe("formats", () => {
  it("nombres, tailles et dates suivent la langue", () => {
    expect(formatNumber("en", 1234.5)).toBe("1,234.5");
    expect(formatBytes("fr", 1536)).toMatch(/^1,5\sKo$/);
    expect(formatBytes("en", 1536)).toBe("1.5 KB");
    expect(formatBytes("fr", 0)).toBe("0 o");
    expect(formatBytes("fr", -1)).toBe("—");
    const d = new Date(Date.UTC(2026, 9, 3, 12));
    expect(formatDate("fr", d, { dateStyle: "long", timeZone: "UTC" })).toBe("3 octobre 2026");
    expect(formatDate("en", d, { dateStyle: "long", timeZone: "UTC" })).toBe("3 October 2026");
    expect(formatDate("fr", "pas une date")).toBe("—");
  });

  it("dates relatives", () => {
    const now = new Date("2026-10-03T12:00:00Z");
    expect(formatRelative("fr", new Date("2026-10-01T12:00:00Z"), now)).toBe("avant-hier");
    expect(formatRelative("en", new Date("2026-10-02T12:00:00Z"), now)).toBe("yesterday");
  });
});
