import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
  StandardFonts,
  cmyk,
  decodePDFRawStream,
  rgb,
} from "pdf-lib";
import { zlibSync } from "fflate";
import { checkPdfA, convertToPdfA, srgbProfile } from "../src/pdf/ops/pdfa";

/**
 * PDF/A-2b / 3b conversion. veraPDF (the reference validator, Java) is used
 * when VERAPDF_JAR points at its greenfield-apps jar; the structural checks
 * run everywhere.
 */

const ICC = new Uint8Array(
  readFileSync(new URL("../node_modules/pdfjs-dist/iccs/CGATS001Compat-v2-micro.icc", import.meta.url)),
);
const VERAPDF =
  process.env.VERAPDF_JAR ??
  "/tmp/claude-0/-home-user/c05fc523-b909-5103-991d-7dcab269304e/scratchpad/vera/greenfield-apps.jar";

function verapdf(bytes: Uint8Array, flavour: string): string {
  const dir = mkdtempSync(join(tmpdir(), "pdfa-"));
  const file = join(dir, "doc.pdf");
  writeFileSync(file, bytes);
  let out: string;
  try {
    out = execFileSync(
      "java",
      ["-cp", VERAPDF, "org.verapdf.apps.GreenfieldCliWrapper", "-f", flavour, "--format", "text", "-v", file],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
  } catch (e) {
    // veraPDF exits non-zero when the file fails: its report is still on stdout.
    out = String((e as { stdout?: string }).stdout ?? e);
  }
  return out
    .split("\n")
    .filter((l) => /PASS|FAIL/.test(l))
    .join("\n");
}

async function sample(): Promise<PDFDocument> {
  const doc = await PDFDocument.create();
  doc.setTitle("Rapport annuel");
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const times = await doc.embedFont(StandardFonts.TimesRomanBold);
  const p = doc.addPage([595, 842]);
  p.drawText("Rapport annuel — été 2026", { x: 60, y: 760, size: 20, font: helv, color: rgb(0.1, 0.2, 0.6) });
  p.drawText("Chiffres clés", { x: 60, y: 720, size: 14, font: times, color: cmyk(0, 0.5, 1, 0) });
  doc.getForm().createTextField("nom").addToPage(p, { x: 60, y: 600, width: 200, height: 20 });
  return doc;
}

describe("PDF/A", () => {
  it("the sRGB profile is a well-formed ICC v2 display profile", () => {
    const icc = srgbProfile();
    const v = new DataView(icc.buffer);
    expect(v.getUint32(0)).toBe(icc.length);
    expect(new TextDecoder().decode(icc.subarray(12, 24))).toBe("mntrRGB XYZ ");
    expect(new TextDecoder().decode(icc.subarray(36, 40))).toBe("acsp");
  });

  it("a plain document fails the checks; converted, it passes them", async () => {
    const doc = await sample();
    await doc.flush();
    expect(checkPdfA(doc).length).toBeGreaterThan(0);
    const r = await convertToPdfA(doc, { part: 2, cmykProfile: ICC });
    expect(r.remaining).toEqual([]);
    expect(r.fixed).toContain("polices incorporées (substituts Liberation)");
    expect(checkPdfA(doc)).toEqual([]);
    const reread = await PDFDocument.load(await doc.save({ useObjectStreams: false }));
    const meta = reread.catalog.lookup(PDFName.of("Metadata")) as PDFRawStream;
    expect(new TextDecoder().decode(meta.contents)).toContain("<pdfaid:part>2</pdfaid:part>");
    expect(reread.catalog.lookup(PDFName.of("OutputIntents"))).toBeTruthy();
    expect(checkPdfA(reread)).toEqual([]);
  });

  it("removes what PDF/A forbids: JavaScript, launch actions, signatures", async () => {
    const doc = await sample();
    doc.catalog.set(PDFName.of("OpenAction"), doc.context.obj({ S: "JavaScript", JS: "app.alert(1)" }) as PDFDict);
    const r = await convertToPdfA(doc, { part: 3 });
    expect(doc.catalog.has(PDFName.of("OpenAction"))).toBe(false);
    expect(r.fixed.join(" ")).toContain("action à l'ouverture supprimée");
  });

  it.skipIf(!existsSync(VERAPDF))(
    "veraPDF: PDF/A-2b and PDF/A-3b pass",
    async () => {
      for (const part of [2, 3] as const) {
        const doc = await sample();
        await convertToPdfA(doc, { part, cmykProfile: ICC });
        expect(verapdf(await doc.save({ useObjectStreams: false }), `${part}b`)).toMatch(/^PASS/);
      }
    },
    120_000,
  );

  // -------------------------------------------------------------------------
  // Regressions (review 9)
  // -------------------------------------------------------------------------

  const hasVera = existsSync(VERAPDF);
  const expectPass = async (doc: PDFDocument, flavour = "2b") => {
    if (hasVera) expect(verapdf(await doc.save({ useObjectStreams: false }), flavour)).toMatch(/^PASS/);
  };
  const N = PDFName.of;
  /** A page drawing `content` with the given /Resources. */
  const pageWith = (doc: PDFDocument, content: string, resources: Record<string, unknown>) => {
    const p = doc.addPage([400, 300]);
    p.node.set(N("Contents"), doc.context.register(doc.context.flateStream(content)));
    p.node.set(N("Resources"), doc.context.obj(resources as never));
    return p;
  };
  const toUnicode = (doc: PDFDocument, pairs: [number, string][]) => {
    const hex = (s: string) =>
      [...s]
        .flatMap((ch) => {
          const cp = ch.codePointAt(0)!;
          if (cp < 0x10000) return [cp];
          return [0xd800 + ((cp - 0x10000) >> 10), 0xdc00 + ((cp - 0x10000) & 0x3ff)];
        })
        .map((u) => u.toString(16).padStart(4, "0"))
        .join("");
    const body =
      `/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /T def /CMapType 2 def\n` +
      `1 begincodespacerange <0000> <FFFF> endcodespacerange\n${pairs.length} beginbfchar\n` +
      pairs.map(([c, t]) => `<${c.toString(16).padStart(4, "0")}> <${hex(t)}>`).join("\n") +
      `\nendbfchar endcmap CMapName currentdict /CMap defineresource pop end end`;
    return doc.context.register(doc.context.flateStream(body));
  };
  const cidFont = (doc: PDFDocument, base: string, withToUnicode: [number, string][] | null) => {
    const descriptor = doc.context.register(
      doc.context.obj({
        Type: "FontDescriptor",
        FontName: base,
        Flags: 4,
        FontBBox: [0, -200, 1000, 900],
        ItalicAngle: 0,
        Ascent: 900,
        Descent: -200,
        CapHeight: 700,
        StemV: 80,
      }),
    );
    const cid = doc.context.register(
      doc.context.obj({
        Type: "Font",
        Subtype: "CIDFontType0",
        BaseFont: base,
        CIDSystemInfo: { Registry: PDFString.of("Adobe"), Ordering: PDFString.of("Identity"), Supplement: 0 },
        FontDescriptor: descriptor,
        DW: 1000,
      }),
    );
    const t0 = doc.context.obj({
      Type: "Font",
      Subtype: "Type0",
      BaseFont: base,
      Encoding: "Identity-H",
      DescendantFonts: [cid],
    }) as PDFDict;
    if (withToUnicode) t0.set(N("ToUnicode"), toUnicode(doc, withToUnicode));
    return { t0: doc.context.register(t0), cid };
  };

  it("CID fonts not embedded: a Liberation CIDFontType2 when ToUnicode maps the CIDs", async () => {
    const doc = await PDFDocument.create();
    const { t0, cid } = cidFont(doc, "ArialUnicode", [
      [1, "A"],
      [2, "é"],
      [3, "€"],
      [7, "Ж"],
    ]);
    pageWith(doc, "BT /F1 20 Tf 50 150 Td <0001000200030007> Tj ET", { Font: { F1: t0 } });
    expect(checkPdfA(doc).join(" ")).toContain("Police non incorporée : CID ArialUnicode");
    const r = await convertToPdfA(doc, { part: 2, cmykProfile: ICC });
    expect(r.remaining).toEqual([]);
    const d = doc.context.lookup(cid) as PDFDict;
    expect(d.get(N("Subtype"))).toEqual(N("CIDFontType2"));
    const fd = d.lookup(N("FontDescriptor")) as PDFDict;
    expect(fd.has(N("FontFile2"))).toBe(true);
    const map = d.lookup(N("CIDToGIDMap"));
    expect(map).toBeInstanceOf(PDFRawStream);
    const gids = decodePDFRawStream(map as PDFRawStream).decode();
    expect(gids.length).toBe(16);
    for (const c of [1, 2, 3, 7]) expect((gids[c * 2]! << 8) | gids[c * 2 + 1]!).toBeGreaterThan(0);
    const w = d.lookup(N("W")) as PDFArray;
    // [1 [wA wé w€] 7 [wЖ]], widths of Liberation Sans.
    expect(w.size()).toBe(4);
    expect((w.lookup(1) as PDFArray).lookup(0)).toEqual(PDFNumber.of(667));
    expect((doc.context.lookup(t0) as PDFDict).get(N("Encoding"))).toEqual(N("Identity-H"));
    expect(checkPdfA(doc)).toEqual([]);
    await expectPass(doc);
  }, 60_000);

  it("CID fonts not embedded and not mappable are reported, not rewritten", async () => {
    const doc = await PDFDocument.create();
    const { t0, cid } = cidFont(doc, "MS-Mincho", null);
    pageWith(doc, "BT /F1 20 Tf 50 150 Td <00410042> Tj ET", { Font: { F1: t0 } });
    const r = await convertToPdfA(doc, { part: 2, cmykProfile: ICC });
    expect(r.remaining.join(" ")).toContain("police CID non incorporée");
    const d = doc.context.lookup(cid) as PDFDict;
    expect(d.get(N("Subtype"))).toEqual(N("CIDFontType0"));
    expect(d.has(N("Widths"))).toBe(false);
    expect(checkPdfA(doc).join(" ")).toContain("Police non incorporée : CID MS-Mincho");
  });

  it("simple fonts: widths follow /Differences, MacRoman and StandardEncoding", async () => {
    const doc = await PDFDocument.create();
    const ctx = doc.context;
    const f1 = ctx.register(
      ctx.obj({
        Type: "Font",
        Subtype: "Type1",
        BaseFont: "Helvetica",
        Encoding: {
          Type: "Encoding",
          BaseEncoding: "WinAnsiEncoding",
          Differences: [1, "eacute", "agrave", "uni0141"],
        },
      }),
    );
    const f2 = ctx.register(
      ctx.obj({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica", Encoding: "MacRomanEncoding" }),
    );
    const f3 = ctx.register(ctx.obj({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica" }));
    const f4 = ctx.register(
      ctx.obj({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica", Encoding: "WinAnsiEncoding" }),
    );
    pageWith(
      doc,
      "BT /F1 20 Tf 50 250 Td <010203> Tj ET BT /F2 20 Tf 50 200 Td <8E88A5> Tj ET " +
        "BT /F3 20 Tf 50 150 Td <27606162A4E8> Tj ET BT /F4 20 Tf 50 100 Td <27E9> Tj ET",
      { Font: { F1: f1, F2: f2, F3: f3, F4: f4 } },
    );
    const r = await convertToPdfA(doc, { part: 2, cmykProfile: ICC });
    expect(r.remaining).toEqual([]);
    const width = (f: PDFRef, code: number) => {
      const d = ctx.lookup(f) as PDFDict;
      const first = (d.lookup(N("FirstChar")) as PDFNumber).asNumber();
      return ((d.lookup(N("Widths")) as PDFArray).lookup(code - first) as PDFNumber).asNumber();
    };
    // Liberation Sans: é à 556, Ł 556, bullet 350, quoteright 222, quotesingle 191, fraction 167.
    expect([width(f1, 1), width(f1, 2), width(f1, 3)]).toEqual([556, 556, 556]);
    expect([width(f2, 0x8e), width(f2, 0x88), width(f2, 0xa5)]).toEqual([556, 556, 350]);
    expect([width(f3, 0x27), width(f3, 0x60), width(f3, 0xa4), width(f3, 0xe8)]).toEqual([222, 222, 167, 556]);
    expect([width(f4, 0x27), width(f4, 0xe9)]).toEqual([191, 556]);
    // Non-symbolic TrueType: WinAnsi-based encodings only.
    const enc = (ctx.lookup(f2) as PDFDict).lookup(N("Encoding")) as PDFDict;
    expect(enc.get(N("BaseEncoding"))).toEqual(N("WinAnsiEncoding"));
    expect((ctx.lookup(f4) as PDFDict).get(N("Encoding"))).toEqual(N("WinAnsiEncoding"));
    await expectPass(doc);
  }, 60_000);

  it("direct font and graphics-state dictionaries in /Resources are fixed", async () => {
    const doc = await PDFDocument.create();
    const p = pageWith(doc, "/GS1 gs BT /F1 20 Tf 50 150 Td (Hello) Tj ET", {
      Font: { F1: { Type: "Font", Subtype: "Type1", BaseFont: "Helvetica" } },
      ExtGState: { GS1: { TR: "Identity" } },
    });
    // The same inside a form XObject drawn by the page.
    const form = doc.context.register(
      doc.context.flateStream("/GS2 gs BT /F2 12 Tf 0 0 Td (Form) Tj ET", {
        Type: "XObject",
        Subtype: "Form",
        BBox: [0, 0, 100, 50],
        Resources: {
          Font: { F2: { Type: "Font", Subtype: "Type1", BaseFont: "Times-Bold" } },
          ExtGState: { GS2: { Type: "ExtGState", TR2: "Identity" } },
        },
      }),
    );
    (p.node.lookup(N("Resources")) as PDFDict).set(N("XObject"), doc.context.obj({ X1: form }));
    const c = doc.context.flateStream("/GS1 gs BT /F1 20 Tf 50 150 Td (Hello) Tj ET q 1 0 0 1 50 50 cm /X1 Do Q");
    p.node.set(N("Contents"), doc.context.register(c));
    expect(checkPdfA(doc).join(" ")).toContain("Police non incorporée : Helvetica");
    expect(checkPdfA(doc)).toContain("Fonctions de transfert présentes.");
    await convertToPdfA(doc, { part: 2, cmykProfile: ICC });
    const res = p.node.lookup(N("Resources")) as PDFDict;
    const font = (res.lookup(N("Font")) as PDFDict).lookup(N("F1")) as PDFDict;
    expect((font.lookup(N("FontDescriptor")) as PDFDict).has(N("FontFile2"))).toBe(true);
    expect(((res.lookup(N("ExtGState")) as PDFDict).lookup(N("GS1")) as PDFDict).has(N("TR"))).toBe(false);
    expect(checkPdfA(doc)).toEqual([]);
    await expectPass(doc);
  }, 60_000);

  it("fields and comments without appearance are kept and given one", async () => {
    const src = await PDFDocument.create();
    const pg = src.addPage([400, 300]);
    const form = src.getForm();
    const tf = form.createTextField("name");
    tf.setText("Jean Dupont");
    tf.addToPage(pg, { x: 50, y: 150, width: 200, height: 24 });
    form.createCheckBox("ok").addToPage(pg, { x: 50, y: 100, width: 14, height: 14 });
    const doc = await PDFDocument.load(await src.save({ updateFieldAppearances: false }));
    const f = doc.getForm();
    for (const w of f.getTextField("name").acroField.getWidgets()) w.dict.delete(N("AP"));
    for (const w of f.getCheckBox("ok").acroField.getWidgets()) w.dict.delete(N("AP"));
    f.acroForm.dict.set(N("NeedAppearances"), doc.context.obj(true));
    const ctx = doc.context;
    const annots = doc.getPage(0).node.lookup(N("Annots")) as PDFArray;
    annots.push(
      ctx.register(
        ctx.obj({
          Type: "Annot",
          Subtype: "Text",
          Rect: [300, 250, 320, 270],
          Contents: PDFString.of("Remarque"),
          F: 4,
        }),
      ),
    );
    annots.push(
      ctx.register(ctx.obj({ Type: "Annot", Subtype: "Square", Rect: [200, 20, 300, 80], C: [1, 0, 0], F: 4 })),
    );
    annots.push(
      ctx.register(
        ctx.obj({
          Type: "Annot",
          Subtype: "Ink",
          Rect: [20, 20, 120, 80],
          InkList: [[30, 30, 60, 70, 110, 30]],
          C: [0, 0, 1],
          F: 4,
        }),
      ),
    );
    const before = annots.size();
    expect(checkPdfA(doc)).toContain("Annotations sans apparence.");
    const r = await convertToPdfA(doc, { part: 2, cmykProfile: ICC });
    expect(r.remaining).toEqual([]);
    const after = doc.getPage(0).node.lookup(N("Annots")) as PDFArray;
    expect(after.size()).toBe(before);
    for (let i = 0; i < after.size(); i++) {
      const an = after.lookup(i) as PDFDict;
      const ap = an.lookup(N("AP")) as PDFDict;
      expect(ap.keys().map(String)).toEqual(["/N"]);
      const parent = an.lookup(N("Parent"));
      const ft = an.lookup(N("FT")) ?? (parent instanceof PDFDict ? parent.lookup(N("FT")) : undefined);
      const isBtn = ft?.toString() === "/Btn";
      expect(ap.lookup(N("N"))).toBeInstanceOf(isBtn ? PDFDict : PDFStream);
    }
    expect(f.acroForm.dict.has(N("NeedAppearances"))).toBe(false);
    expect(checkPdfA(doc)).toEqual([]);
    await expectPass(doc);
  }, 60_000);

  it("optional content configurations get a /Name", async () => {
    const doc = await sample();
    const ctx = doc.context;
    const ocg = ctx.register(ctx.obj({ Type: "OCG", Name: PDFString.of("L1") }));
    doc.catalog.set(
      N("OCProperties"),
      ctx.obj({
        OCGs: [ocg],
        D: { ON: [ocg], Order: [ocg] },
        Configs: [{ OFF: [ocg] }, { Name: PDFString.of("Par défaut"), ON: [ocg] }],
      }),
    );
    await convertToPdfA(doc, { part: 2, cmykProfile: ICC });
    const oc = doc.catalog.lookup(N("OCProperties")) as PDFDict;
    const configs = oc.lookup(N("Configs")) as PDFArray;
    const nameOf = (d: PDFDict) => (d.lookup(N("Name")) as PDFString | PDFHexString).decodeText();
    const all = [oc.lookup(N("D")) as PDFDict, configs.lookup(0) as PDFDict, configs.lookup(1) as PDFDict].map(nameOf);
    expect(all.every(Boolean)).toBe(true);
    expect(new Set(all).size).toBe(3);
    await expectPass(doc);
  }, 60_000);

  it("PDF/A-3: embedded files are associated (/AF), typed and given a relationship; PDF/A-2 drops them", async () => {
    const make = async () => {
      const d = await sample();
      await d.attach(new TextEncoder().encode("a,b\n1,2"), "data.csv", { description: "données" });
      await d.attach(new TextEncoder().encode("<x/>"), "facture.xml", { mimeType: "text/xml" });
      return d;
    };
    const doc = await make();
    const r = await convertToPdfA(doc, { part: 3, cmykProfile: ICC });
    expect(r.remaining).toEqual([]);
    const af = doc.catalog.lookup(N("AF")) as PDFArray;
    expect(af.size()).toBe(2);
    const mimes: string[] = [];
    for (let i = 0; i < af.size(); i++) {
      expect(af.get(i)).toBeInstanceOf(PDFRef);
      const fs = af.lookup(i) as PDFDict;
      expect(fs.lookup(N("AFRelationship"))).toBeInstanceOf(PDFName);
      expect(fs.has(N("UF")) && fs.has(N("F"))).toBe(true);
      const ef = (fs.lookup(N("EF")) as PDFDict).lookup(N("F")) as PDFStream;
      mimes.push(decodeURIComponent((ef.dict.lookup(N("Subtype")) as PDFName).asString().slice(1).replace(/#/g, "%")));
    }
    expect(mimes.sort()).toEqual(["text/csv", "text/xml"]);
    await expectPass(doc, "3b");

    const two = await make();
    await convertToPdfA(two, { part: 2, cmykProfile: ICC });
    expect((two.catalog.lookup(N("Names")) as PDFDict | undefined)?.has(N("EmbeddedFiles")) ?? false).toBe(false);
    expect(two.catalog.has(N("AF"))).toBe(false);
    await expectPass(two, "2b");
  }, 60_000);

  it("checkPdfA reads Flate-compressed XMP metadata", async () => {
    const doc = await sample();
    await convertToPdfA(doc, { part: 2, cmykProfile: ICC });
    const meta = doc.catalog.lookup(N("Metadata")) as PDFStream;
    const xml =
      (meta as unknown as { getUnencodedContents(): Uint8Array }).getUnencodedContents?.() ??
      (meta as PDFRawStream).contents;
    const packed = zlibSync(xml);
    const compress = (bytes: Uint8Array) =>
      doc.catalog.set(
        N("Metadata"),
        doc.context.register(
          PDFRawStream.of(
            doc.context.obj({
              Type: "Metadata",
              Subtype: "XML",
              Filter: "FlateDecode",
              Length: bytes.length,
            }) as PDFDict,
            bytes,
          ),
        ),
      );
    compress(packed);
    expect(checkPdfA(doc)).toEqual([]);
    const reread = await PDFDocument.load(await doc.save({ useObjectStreams: false }));
    expect(checkPdfA(reread)).toEqual([]);
    compress(zlibSync(new TextEncoder().encode("<x:xmpmeta xmlns:x='adobe:ns:meta/'/>")));
    expect(checkPdfA(doc)).toContain("Les métadonnées ne déclarent pas la conformité PDF/A.");
  });
});
