import { describe, expect, it } from "vitest";
import { md5 } from "@noble/hashes/legacy.js";
import { PDFDocument, PDFHexString, StandardFonts } from "pdf-lib";
import { search } from "../src/pdf/core/search";
import { REDACT_PATTERNS, ibanValid, luhn, nirValid } from "../src/pdf/ops/redactpatterns";
import {
  ALL_PERMISSIONS,
  inspectProtection,
  openCrypt,
  permissionsToP,
  rc4,
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
    const r = p.validRange ? p.validRange(m) : { start: 0, length: m.length };
    return r ? [m.slice(r.start, r.start + r.length)] : [];
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

  it("a number run into the card's first group does not hide it", () => {
    expect(find("card", "Commande 12 4111 1111 1111 1111 expire")).toEqual(["4111 1111 1111 1111"]);
    expect(find("iban", "Réf 12 FR76 3000 6000 0112 3456 7890 189")).toEqual(["FR76 3000 6000 0112 3456 7890 189"]);
    // `valid` (its start kept) still answers for the prefix alone.
    const card = REDACT_PATTERNS.find((x) => x.id === "card")!;
    expect(card.valid!("4111 1111 1111 1111 12")).toBe("4111 1111 1111 1111".length);
    expect(card.validRange!("12 4111 1111 1111 1111")).toEqual({ start: 3, length: 19 });
  });

  it("e-mail addresses, found quickly in a long run without « @ »", () => {
    expect(find("email", "Écrire à jean.dupont+pdf@exemple.fr ou a@b.co.")).toEqual([
      "jean.dupont+pdf@exemple.fr",
      "a@b.co",
    ]);
    const t0 = performance.now();
    expect(find("email", "a".repeat(180_000) + " b")).toEqual([]);
    expect(find("email", "a.".repeat(90_000))).toEqual([]);
    expect(performance.now() - t0).toBeLessThan(200);
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

  it("revisions 2–4: a decomposed accent opens a password set composed (Latin-1)", async () => {
    // RC4 40-bit (R2), user « clé » and owner « propriété » in Latin-1, as Acrobat writes them.
    const PAD = Uint8Array.from("28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a".match(/../g)!, (h) =>
      parseInt(h, 16),
    );
    const user = "cl\u00e9";
    const owner = "propri\u00e9t\u00e9";
    const pad = (pw: string) => {
      const out = new Uint8Array(32);
      const raw = Uint8Array.from(pw, (ch) => ch.charCodeAt(0) & 0xff).subarray(0, 32);
      out.set(raw);
      out.set(PAD.subarray(0, 32 - raw.length), raw.length);
      return out;
    };
    const id0 = new Uint8Array(16).map((_, i) => 0x10 + i);
    const p = -44;
    const o = rc4(md5(pad(owner)).subarray(0, 5), pad(user));
    const pb = new Uint8Array(4);
    new DataView(pb.buffer).setInt32(0, p, true);
    const key = md5(Uint8Array.from([...pad(user), ...o, ...pb, ...id0])).subarray(0, 5);
    const u = rc4(key, PAD);
    const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
    const doc = await PDFDocument.create();
    doc.addPage();
    const ctx = doc.context;
    ctx.trailerInfo.ID = ctx.obj([PDFHexString.of(hex(id0)), PDFHexString.of(hex(id0))]);
    ctx.trailerInfo.Encrypt = ctx.register(
      ctx.obj({
        Filter: "Standard",
        V: 1,
        R: 2,
        Length: 40,
        P: p,
        O: PDFHexString.of(hex(o)),
        U: PDFHexString.of(hex(u)),
      }),
    );
    expect(openCrypt(doc, user.normalize("NFD"))).toBeTruthy();
    expect(openCrypt(doc, owner.normalize("NFD"))).toBeTruthy();
    expect(() => openCrypt(doc, "cle")).toThrow();
  });
});
