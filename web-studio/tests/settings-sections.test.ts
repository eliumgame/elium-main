import { describe, it, expect } from "vitest";
import { CATEGORIES, SECTIONS, searchSections, sectionsOf } from "../src/components/settings/sections";
import { catalogs } from "../src/i18n/catalog";
import { createTranslator } from "../src/i18n/core";
import type { MessageKey } from "../src/i18n";

const fr = createTranslator("fr", catalogs);
const en = createTranslator("en", catalogs);
const trFr = (k: MessageKey) => fr.t(k);
const trEn = (k: MessageKey) => en.t(k);

describe("plan des réglages", () => {
  it("chaque catégorie contient au moins une section et chaque section a ses textes dans les deux langues", () => {
    for (const c of CATEGORIES) expect(sectionsOf(c.id).length, c.id).toBeGreaterThan(0);
    for (const s of SECTIONS) {
      for (const key of [s.titleKey, s.keywordsKey]) {
        expect(catalogs.fr[key], `fr:${key}`).toBeTruthy();
        expect(catalogs.en[key], `en:${key}`).toBeTruthy();
      }
    }
    for (const c of CATEGORIES) expect(catalogs.fr[c.labelKey]).toBeTruthy();
  });

  it("les dix catégories demandées sont présentes", () => {
    expect(CATEGORIES.map((c) => c.id)).toEqual([
      "general", "appearance", "editing", "fonts", "shortcuts", "workspace", "security", "updates", "privacy", "about",
    ]);
  });
});

describe("recherche dans les réglages", () => {
  it("retrouve une section par son nom ou un synonyme, sans tenir compte des accents", () => {
    expect(searchSections("port", trFr)[0]!.id).toBe("upd_port");
    expect(searchSections("POLICES", trFr).map((s) => s.id)).toContain("fonts_manager");
    expect(searchSections("coffre", trFr)[0]!.id).toBe("sec_vault");
    expect(searchSections("sauvegarde", trFr).map((s) => s.id)).toEqual(expect.arrayContaining(["ws_backup", "ws_restore"]));
    expect(searchSections("francais", trFr).map((s) => s.id)).toContain("language"); // « français » sans accent
  });

  it("exige tous les mots et n'accroche pas des lettres éparpillées", () => {
    expect(searchSections("port", trFr).map((s) => s.id)).not.toContain("edit_defaults");
    expect(searchSections("coffre mot passe", trFr).map((s) => s.id)).toContain("sec_vault");
    expect(searchSections("zzzzqq", trFr)).toEqual([]);
    expect(searchSections("   ", trFr)).toEqual([]);
  });

  it("fonctionne dans la langue active", () => {
    expect(searchSections("shortcuts", trEn).map((s) => s.id)).toContain("shortcuts_list");
    expect(searchSections("backup", trEn).map((s) => s.id)).toContain("ws_backup");
  });
});
