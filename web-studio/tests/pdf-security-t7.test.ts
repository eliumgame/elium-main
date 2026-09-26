import { describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { search } from "../src/pdf/core/search";
import { REDACT_PATTERNS, ibanValid, luhn, nirValid } from "../src/pdf/ops/redactpatterns";
import {
  ALL_PERMISSIONS,
  inspectProtection,
  permissionsToP,
  protectDocument,
  removeProtection,
} from "../src/pdf/ops/security";
import { acrobatPermissions } from "../src/pdf/ui/dialogs";

/** Protection (permissions, owner password) and the search-and-redact patterns. */

function find(id: string, text: string): string[] {
  const p = REDACT_PATTERNS.find((x) => x.id === id)!;
  return search([text], p.pattern, {
    caseSensitive: !!p.caseSensitive,
    wholeWord: false,
    regex: true,
    ignoreDiacritics: true,
  }).flatMap((h) => {
    const m = text.slice(h.start, h.end);
    const n = p.valid ? p.valid(m) : m.length;
    return n ? [m.slice(0, n)] : [];
  });
}

/** A valid NIR for `body` (13 characters, 2A/2B allowed). */
const nirFor = (body: string) =>
  `${body}${String(97 - Number(BigInt(body.replace("2A", "19").replace("2B", "18")) % 97n)).padStart(2, "0")}`;

describe("redaction patterns", () => {
  it("IBAN: the whole number, last group included, checked by its key", () => {
    expect(find("iban", "Virement FR76 3000 6000 0112 3456 7890 189 reçu")).toEqual([
      "FR76 3000 6000 0112 3456 7890 189",
    ]);
    expect(find("iban", "IBAN DE89 3704 0044 0532 0130 00 CHEZ")).toEqual(["DE89 3704 0044 0532 0130 00"]);
    expect(find("iban", "FR76 3000 6000 0112 3456 7890 188")).toEqual([]);
    expect(ibanValid("GB82WEST12345698765432")).toBe(true);
  });

  it("NIR: Corsica (2A/2B) and the 3/4/7/8 prefixes, checked by the key", () => {
    const a = nirFor("2690599123456");
    const b = nirFor("1850392A12345".slice(0, 5) + "2A" + "123456");
    const c = nirFor("7850399123456");
    for (const n of [a, b, c]) expect(nirValid(n)).toBe(true);
    const spaced = `${b.slice(0, 1)} ${b.slice(1, 3)} ${b.slice(3, 5)} ${b.slice(5, 7)} ${b.slice(7, 10)} ${b.slice(10, 13)} ${b.slice(13)}`;
    expect(find("nir", `Assuré : ${spaced}.`)).toEqual([spaced]);
    expect(find("nir", "1 69 05 99 123 456 00")).toEqual([]);
  });

  it("phones: French with +33 (0), and international", () => {
    expect(find("phone", "Tél. +33 (0)1 23 45 67 89 ou 06.12.34.56.78")).toEqual([
      "+33 (0)1 23 45 67 89",
      "06.12.34.56.78",
    ]);
    expect(find("phone", "Call +1 415 555 0132 now")).toEqual(["+1 415 555 0132"]);
  });

  it("cards (Luhn), SIRET/SIREN (Luhn), dates", () => {
    expect(find("card", "Carte 4111 1111 1111 1111 exp")).toEqual(["4111 1111 1111 1111"]);
    expect(find("card", "Carte 4111 1111 1111 1112 exp")).toEqual([]);
    expect(luhn("732 829 320")).toBe(true);
    expect(find("siret", "SIREN 732 829 320, autre 732 829 321")).toEqual(["732 829 320"]);
    expect(find("date", "né le 12/03/1985 et le 1er février 2024")).toEqual(["12/03/1985", "1er février 2024"]);
  });
});

describe("permissions", () => {
  it("/P: bits 1-2 clear, 7-8 and 13-32 set", () => {
    expect(permissionsToP(ALL_PERMISSIONS)).toBe(-4);
    const none = Object.fromEntries(Object.keys(ALL_PERMISSIONS).map((k) => [k, false])) as typeof ALL_PERMISSIONS;
    expect(permissionsToP(none) >>> 0).toBe(0xfffff0c0);
  });

  it("Acrobat's choices map to the right bits", () => {
    expect(acrobatPermissions("low", "comments", false, true)).toEqual({
      print: true,
      printHighRes: false,
      modify: false,
      assemble: false,
      fillForms: true,
      annotate: true,
      copy: false,
      extractForAccessibility: true,
    });
  });

  it("tells the owner password from the user's; accents match composed or not", async () => {
    const make = async (user: string, owner: string) => {
      const doc = await PDFDocument.create();
      const font = await doc.embedFont(StandardFonts.Helvetica);
      doc.addPage().drawText("x", { font, x: 10, y: 10 });
      return protectDocument(doc, {
        userPassword: user,
        ownerPassword: owner,
        permissions: { ...ALL_PERMISSIONS, print: false },
      });
    };
    const bytes = await make("lecteur", "proprio");
    expect((await inspectProtection(bytes, "lecteur"))?.owner).toBe(false);
    expect((await inspectProtection(bytes, "proprio"))?.owner).toBe(true);
    expect((await inspectProtection(bytes, "lecteur"))?.permissions.print).toBe(false);
    // « é » typed composed (NFC) when protecting, decomposed (NFD) when opening.
    const accented = await make("clé", "propriété");
    await expect(removeProtection(accented, "clé")).resolves.toBeTruthy();
    expect((await inspectProtection(accented, "propriété"))?.owner).toBe(true);
  });
});
