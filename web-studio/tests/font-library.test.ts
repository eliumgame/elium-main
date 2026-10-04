import { describe, it, expect } from "vitest";
import { cleanFontName, fontDisplayName, readFontMeta, sniffFontKind } from "../src/ui/font-meta";
import { prepareFont } from "../src/ui/font-library";

/** Construit un TTF minimal (en-tête + table `name` seule) — suffisant pour lire les noms. */
function buildTtf(names: Record<number, string>, sfnt: "ttf" | "otf" = "ttf"): Uint8Array {
  const entries = Object.entries(names).map(([id, text]) => ({ id: Number(id), text }));
  const utf16 = (t: string) => {
    const b = new Uint8Array(t.length * 2);
    for (let i = 0; i < t.length; i++) {
      b[i * 2] = t.charCodeAt(i) >> 8;
      b[i * 2 + 1] = t.charCodeAt(i) & 0xff;
    }
    return b;
  };
  const strs = entries.map((e) => utf16(e.text));
  const stringsLen = strs.reduce((n, s) => n + s.length, 0);
  const nameLen = 6 + entries.length * 12 + stringsLen;
  const out = new Uint8Array(12 + 16 + nameLen);
  const dv = new DataView(out.buffer);
  if (sfnt === "otf")
    out.set([0x4f, 0x54, 0x54, 0x4f]); // OTTO
  else dv.setUint32(0, 0x00010000);
  dv.setUint16(4, 1); // numTables
  const nameOff = 28;
  out.set([0x6e, 0x61, 0x6d, 0x65], 12); // "name"
  dv.setUint32(12 + 8, nameOff);
  dv.setUint32(12 + 12, nameLen);
  dv.setUint16(nameOff, 0);
  dv.setUint16(nameOff + 2, entries.length);
  dv.setUint16(nameOff + 4, 6 + entries.length * 12);
  let strOff = 0;
  entries.forEach((e, i) => {
    const r = nameOff + 6 + i * 12;
    dv.setUint16(r, 3); // Windows
    dv.setUint16(r + 2, 1);
    dv.setUint16(r + 4, 0x409);
    dv.setUint16(r + 6, e.id);
    dv.setUint16(r + 8, strs[i]!.length);
    dv.setUint16(r + 10, strOff);
    out.set(strs[i]!, nameOff + 6 + entries.length * 12 + strOff);
    strOff += strs[i]!.length;
  });
  return out;
}

describe("sniffFontKind", () => {
  it("reconnaît les signatures, pas les extensions", () => {
    expect(sniffFontKind(buildTtf({ 1: "A" }))).toBe("ttf");
    expect(sniffFontKind(buildTtf({ 1: "A" }, "otf"))).toBe("otf");
    expect(sniffFontKind(new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe("woff2");
    expect(sniffFontKind(new Uint8Array([0x77, 0x4f, 0x46, 0x46, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe("woff");
    expect(sniffFontKind(new TextEncoder().encode("<html>not a font at all</html>"))).toBeNull();
    expect(sniffFontKind(new Uint8Array(4))).toBeNull();
  });
});

describe("readFontMeta / fontDisplayName", () => {
  it("lit le nom complet dans la table name", () => {
    const meta = readFontMeta(buildTtf({ 1: "Roboto", 2: "Bold", 4: "Roboto Bold" }));
    expect(meta?.fullName).toBe("Roboto Bold");
    expect(meta?.family).toBe("Roboto");
    expect(fontDisplayName(meta, "x.ttf")).toBe("Roboto Bold");
  });

  it("préfère la famille typographique (ID 16/17) à la famille Windows (ID 1/2)", () => {
    const meta = readFontMeta(buildTtf({ 1: "Foo Light", 2: "Regular", 16: "Foo", 17: "Light" }));
    expect(meta?.family).toBe("Foo");
    expect(meta?.subfamily).toBe("Light");
    expect(fontDisplayName(meta, "f.ttf")).toBe("Foo Light");
  });

  it("retombe sur le nom du fichier quand la table name est absente ou la police WOFF", () => {
    expect(
      fontDisplayName(
        readFontMeta(new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0, 0, 0, 0, 0, 0, 0, 0])),
        "Mon_Beau-Titre.woff2",
      ),
    ).toBe("Mon Beau-Titre");
  });

  it("ne plante pas sur un fichier tronqué", () => {
    const ttf = buildTtf({ 1: "Trunc", 4: "Trunc Regular" });
    expect(() => readFontMeta(ttf.subarray(0, 40))).not.toThrow();
  });
});

describe("cleanFontName", () => {
  it("retire ce qui casserait une pile CSS", () => {
    expect(cleanFontName(`Ev"il', Font; {x}`)).toBe("Evil Font x");
    expect(cleanFontName("   ")).toBe("Police importée");
    expect(cleanFontName("x".repeat(200)).length).toBe(64);
  });
});

describe("prepareFont", () => {
  const reserved = new Set(["Arial", "Inter"]);
  const bytes = buildTtf({ 1: "Lobster Two", 2: "Regular", 4: "Lobster Two" });

  it("accepte une police valide et fixe le nom de fichier d'incorporation", () => {
    const r = prepareFont(bytes, "lt.ttf", new Map(), reserved);
    expect(r).toMatchObject({ ok: true, font: { name: "Lobster Two", filename: "Lobster Two.ttf" } });
  });

  it("rejette ce qui n'est pas une police, quelle que soit l'extension", () => {
    const r = prepareFont(new TextEncoder().encode("MZ not a font ........"), "evil.ttf", new Map(), reserved);
    expect(r).toMatchObject({ ok: false });
  });

  it("rejette un fichier trop volumineux", () => {
    const r = prepareFont(new Uint8Array(26 * 1024 * 1024), "big.ttf", new Map(), reserved);
    expect(r).toMatchObject({ ok: false });
  });

  it("n'écrase jamais une police intégrée à l'application", () => {
    const r = prepareFont(buildTtf({ 4: "Inter" }), "inter.ttf", new Map(), reserved);
    expect(r).toMatchObject({ ok: true, font: { name: "Inter (importée)" } });
  });

  it("détecte le doublon exact et suffixe un homonyme différent", () => {
    const existing = new Map([["Lobster Two", bytes]]);
    expect(prepareFont(bytes, "again.ttf", existing, reserved)).toMatchObject({ ok: true, duplicateOf: "Lobster Two" });
    const other = buildTtf({ 4: "Lobster Two" }, "otf");
    expect(prepareFont(other, "o.otf", existing, reserved)).toMatchObject({
      ok: true,
      font: { name: "Lobster Two 2", filename: "Lobster Two 2.otf" },
    });
  });
});
