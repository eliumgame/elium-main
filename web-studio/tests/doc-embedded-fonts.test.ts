import { describe, it, expect } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import {
  FONT_ACCEPT, FONT_MIME, fontExtension, fontFaceCss, fontNameFromFilename, fontResources,
  neededFontIds, syncEmbeddedFonts, usedFontFamilies,
} from "../src/format/embedded-fonts";
import { docToDocx } from "../src/format/docx";
import { createEliumFile } from "../src/format/document";
import { buildStandaloneHtml } from "../src/export/exporters";
import type { EliumFile, EliumResource, ProseMirrorNode } from "../src/format/types";

const styled = (text: string, family: string): ProseMirrorNode => ({
  type: "text",
  text,
  marks: [{ type: "textStyle", attrs: { fontFamily: family } }],
});
const doc = (...content: ProseMirrorNode[]): ProseMirrorNode => ({ type: "doc", content });
const para = (...content: ProseMirrorNode[]): ProseMirrorNode => ({ type: "paragraph", content });

/** A minimal but structurally plausible font blob (contents are irrelevant here). */
const fontBytes = (seed: number) => new Uint8Array(Array.from({ length: 64 }, (_, i) => (i * 7 + seed) & 0xff));

async function fileWith(node: ProseMirrorNode): Promise<EliumFile> {
  return createEliumFile({ title: "Doc polices", profile: "standard", doc: node });
}

describe("Polices embarquées — détection des familles utilisées", () => {
  it("relève la famille des marques textStyle", () => {
    expect(usedFontFamilies(doc(para(styled("a", "Fraunces"))))).toEqual(["Fraunces"]);
  });

  it("ne garde que la première famille d'une pile CSS, sans guillemets", () => {
    expect(usedFontFamilies(doc(para(styled("a", "'Ma Police', sans-serif"))))).toEqual(["Ma Police"]);
    expect(usedFontFamilies(doc(para(styled("a", '"Autre", serif'))))).toEqual(["Autre"]);
  });

  it("dédoublonne et descend dans l'arbre", () => {
    const nested = doc({
      type: "table",
      content: [
        {
          type: "tableRow",
          content: [{ type: "tableCell", content: [para(styled("x", "Fraunces"), styled("y", "Fraunces"))] }],
        },
      ],
    });
    expect(usedFontFamilies(nested)).toEqual(["Fraunces"]);
  });

  it("rend une liste vide sans mise en forme de police", () => {
    expect(usedFontFamilies(doc(para({ type: "text", text: "brut" })))).toEqual([]);
  });
});

describe("Polices embarquées — noms de fichiers", () => {
  it("reconnaît les formats acceptés", () => {
    expect(fontExtension("Ma.ttf")).toBe("ttf");
    expect(fontExtension("Ma.OTF")).toBe("otf");
    expect(fontExtension("Ma.woff2")).toBe("woff2");
    expect(fontExtension("Ma.exe")).toBeNull();
    for (const ext of Object.keys(FONT_MIME)) expect(FONT_ACCEPT).toContain(`.${ext}`);
  });

  it("déduit la famille du nom de fichier", () => {
    expect(fontNameFromFilename("Fraunces-Regular.ttf")).toBe("Fraunces-Regular");
    expect(fontNameFromFilename("Ma.WOFF2")).toBe("Ma");
    expect(fontNameFromFilename(".ttf")).toBe("Police importée");
  });
});

describe("Polices embarquées — synchronisation dans le paquet", () => {
  it("embarque la police que le texte utilise", async () => {
    const file = await fileWith(doc(para(styled("bonjour", "Fraunces"))));
    const out = await syncEmbeddedFonts(file, [
      { family: "Fraunces", filename: "Fraunces.ttf", bytes: fontBytes(1) },
    ]);
    const fonts = out.resourceIndex.filter((r) => r.kind === "font");
    expect(fonts).toHaveLength(1);
    expect(fonts[0]).toMatchObject({ name: "Fraunces.ttf", mime: "font/ttf", size: 64 });
    expect(out.resources.get(fonts[0]!.id)).toBeInstanceOf(Uint8Array);
  });

  it("n'embarque pas une police que le texte n'utilise pas", async () => {
    const file = await fileWith(doc(para({ type: "text", text: "brut" })));
    const out = await syncEmbeddedFonts(file, [
      { family: "Fraunces", filename: "Fraunces.ttf", bytes: fontBytes(1) },
    ]);
    expect(out.resourceIndex.filter((r) => r.kind === "font")).toHaveLength(0);
    expect(out).toBe(file); // rien à changer → même objet
  });

  it("est adressée par contenu : deux sauvegardes ne dupliquent pas", async () => {
    const file = await fileWith(doc(para(styled("a", "Fraunces"))));
    const once = await syncEmbeddedFonts(file, [{ family: "Fraunces", filename: "Fraunces.ttf", bytes: fontBytes(1) }]);
    const twice = await syncEmbeddedFonts(once, [{ family: "Fraunces", filename: "Fraunces.ttf", bytes: fontBytes(1) }]);
    expect(twice.resourceIndex.filter((r) => r.kind === "font")).toHaveLength(1);
    expect(twice).toBe(once); // stable → pas de perturbation de l'empreinte
  });

  it("retire la police quand le dernier texte qui l'utilise disparaît", async () => {
    const withFont = await syncEmbeddedFonts(await fileWith(doc(para(styled("a", "Fraunces")))), [
      { family: "Fraunces", filename: "Fraunces.ttf", bytes: fontBytes(1) },
    ]);
    const id = withFont.resourceIndex.find((r) => r.kind === "font")!.id;
    // Le texte est réécrit sans mise en forme de police.
    const stripped: EliumFile = { ...withFont, document: { ...withFont.document, doc: doc(para({ type: "text", text: "a" })) } };
    const out = await syncEmbeddedFonts(stripped, []);
    expect(out.resourceIndex.filter((r) => r.kind === "font")).toHaveLength(0);
    expect(out.resources.has(id)).toBe(false);
  });

  it("ne touche pas aux ressources qui ne sont pas des polices", async () => {
    const base = await fileWith(doc(para(styled("a", "Fraunces"))));
    const image: EliumResource = { id: "img1", name: "x.png", mime: "image/png", size: 3, kind: "image" };
    const file: EliumFile = {
      ...base,
      resourceIndex: [image],
      resources: new Map([["img1", new Uint8Array([1, 2, 3])]]),
    };
    const out = await syncEmbeddedFonts(file, [{ family: "Fraunces", filename: "Fraunces.ttf", bytes: fontBytes(2) }]);
    expect(out.resourceIndex.filter((r) => r.kind === "image")).toHaveLength(1);
    expect(out.resources.get("img1")).toBeInstanceOf(Uint8Array);
  });
});

describe("Polices embarquées — lecture de l'index", () => {
  const index: EliumResource[] = [
    { id: "a1", name: "Fraunces.ttf", mime: "font/ttf", size: 10, kind: "font" },
    { id: "b2", name: "Autre.woff2", mime: "font/woff2", size: 10, kind: "font" },
    { id: "c3", name: "x.png", mime: "image/png", size: 10, kind: "image" },
  ];

  it("expose famille et extension des polices seulement", () => {
    expect(fontResources(index)).toEqual([
      { id: "a1", family: "Fraunces", ext: "ttf" },
      { id: "b2", family: "Autre", ext: "woff2" },
    ]);
  });

  it("dit quelles polices le document réclame encore", () => {
    const needed = neededFontIds(doc(para(styled("a", "Autre"))), index);
    expect([...needed]).toEqual(["b2"]);
  });
});

describe("Polices embarquées — CSS @font-face", () => {
  it("produit une règle autonome par police", () => {
    const css = fontFaceCss([{ family: "Fraunces", ext: "ttf", base64: "AAAA" }]);
    expect(css).toContain('font-family:"Fraunces"');
    expect(css).toContain("src:url(data:font/ttf;base64,AAAA)");
    expect(css).toContain('format("truetype")');
    expect(css).toContain("font-display:swap");
  });

  it("utilise le bon type et le bon format selon l'extension", () => {
    expect(fontFaceCss([{ family: "A", ext: "woff2", base64: "x" }])).toContain('format("woff2")');
    expect(fontFaceCss([{ family: "A", ext: "otf", base64: "x" }])).toContain("data:font/otf");
  });

  it("neutralise les guillemets dans le nom de famille", () => {
    expect(fontFaceCss([{ family: 'Ma"Police', ext: "ttf", base64: "x" }])).toContain('font-family:"MaPolice"');
  });
});

describe("Polices embarquées — exports", () => {
  it("inline les @font-face dans l'export HTML autonome", async () => {
    const file = await syncEmbeddedFonts(await fileWith(doc(para(styled("a", "Fraunces")))), [
      { family: "Fraunces", filename: "Fraunces.ttf", bytes: fontBytes(3) },
    ]);
    const html = buildStandaloneHtml(file);
    expect(html).toContain('@font-face{font-family:"Fraunces"');
    expect(html).toContain("data:font/ttf;base64,");
  });

  it("écrit un fontTable.xml et une part de police obfusquée en DOCX", async () => {
    const file = await syncEmbeddedFonts(await fileWith(doc(para(styled("a", "Fraunces")))), [
      { family: "Fraunces", filename: "Fraunces.ttf", bytes: fontBytes(4) },
    ]);
    const zip = unzipSync(docToDocx(file));
    expect(Object.keys(zip)).toContain("word/fontTable.xml");
    expect(Object.keys(zip)).toContain("word/fonts/font1.odttf");

    const table = strFromU8(zip["word/fontTable.xml"]!);
    expect(table).toContain('w:name="Fraunces"');
    expect(table).toMatch(/w:fontKey="\{[0-9A-F-]{36}\}"/);

    const rels = strFromU8(zip["word/_rels/document.xml.rels"]!);
    expect(rels).toContain("fontTable.xml");
    expect(rels).toContain("fonts/font1.odttf");

    const types = strFromU8(zip["[Content_Types].xml"]!);
    expect(types).toContain("obfuscatedFont");

    // Les 32 premiers octets sont brouillés, le reste est intact.
    const part = zip["word/fonts/font1.odttf"]!;
    const original = fontBytes(4);
    expect(part.slice(32)).toEqual(original.slice(32));
    expect(part.slice(0, 32)).not.toEqual(original.slice(0, 32));
  });

  it("n'ajoute aucune part de police quand il n'y en a pas", async () => {
    const zip = unzipSync(docToDocx(await fileWith(doc(para({ type: "text", text: "brut" })))));
    expect(Object.keys(zip)).not.toContain("word/fontTable.xml");
  });
});
