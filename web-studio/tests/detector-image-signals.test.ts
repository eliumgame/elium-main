import { describe, it, expect } from "vitest";
import { zlibSync, strToU8 } from "fflate";
import { analyzeImageSignals } from "../src/detector/imageSignals";
import type { ImageModel } from "../src/detector/types";

// ---- Binary fixture builders -----------------------------------------------
// Hand-rolled, spec-accurate JPEG/PNG fragments — no real photos needed, just
// enough structure for our own parser to walk.

function le16(n: number): number[] {
  return [n & 0xff, (n >> 8) & 0xff];
}
function le32(n: number): number[] {
  return [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
}
function ascii(s: string): number[] {
  return [...s].map((c) => c.charCodeAt(0));
}

function buildTiffAscii(entries: { tag: number; value: string }[]): Uint8Array {
  const ifd0Offset = 8;
  const entriesStart = ifd0Offset + 2;
  const afterEntries = entriesStart + entries.length * 12;
  const dataAreaStart = afterEntries + 4;

  const strList = entries.map((e) => [...ascii(e.value), 0]);
  const entryBytes: number[] = [];
  const extraData: number[] = [];
  let cursor = dataAreaStart;
  entries.forEach((e, idx) => {
    const strBytes = strList[idx]!;
    const count = strBytes.length;
    let valueField: number[];
    if (count <= 4) {
      valueField = [...strBytes, ...new Array(4 - count).fill(0)];
    } else {
      valueField = le32(cursor);
      extraData.push(...strBytes);
      cursor += count;
    }
    entryBytes.push(...le16(e.tag), ...le16(2 /* ASCII */), ...le32(count), ...valueField);
  });

  return new Uint8Array([
    0x49,
    0x49,
    0x2a,
    0x00, // "II" little-endian + TIFF magic 42
    ...le32(ifd0Offset),
    ...le16(entries.length),
    ...entryBytes,
    ...le32(0), // next IFD offset
    ...extraData,
  ]);
}

function exifApp1(entries: { tag: number; value: string }[]): Uint8Array {
  return new Uint8Array([...ascii("Exif"), 0, 0, ...buildTiffAscii(entries)]);
}

const TAG_MAKE = 0x010f;
const TAG_MODEL = 0x0110;
const TAG_SOFTWARE = 0x0131;

function xmpApp1(xml: string): Uint8Array {
  return new Uint8Array([...ascii("http://ns.adobe.com/xap/1.0/"), 0, ...ascii(xml)]);
}

function buildJpeg(segments: { marker: number; data: Uint8Array }[]): Uint8Array {
  const parts: number[] = [0xff, 0xd8];
  for (const seg of segments) {
    const len = seg.data.length + 2;
    parts.push(0xff, seg.marker, (len >> 8) & 0xff, len & 0xff, ...Array.from(seg.data));
  }
  parts.push(0xff, 0xd9);
  return new Uint8Array(parts);
}

function pngChunk(type: string, data: number[]): number[] {
  const len = data.length;
  return [
    (len >>> 24) & 0xff,
    (len >>> 16) & 0xff,
    (len >>> 8) & 0xff,
    len & 0xff,
    ...ascii(type),
    ...data,
    0,
    0,
    0,
    0,
  ];
}

function buildPng(extraChunks: number[][]): Uint8Array {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const ihdr = pngChunk("IHDR", [0, 0, 1, 0, 0, 0, 1, 0, 8, 2, 0, 0, 0]);
  const iend = pngChunk("IEND", []);
  return new Uint8Array([...sig, ...ihdr, ...extraChunks.flat(), ...iend]);
}

function tEXtChunk(keyword: string, text: string): number[] {
  return pngChunk("tEXt", [...ascii(keyword), 0, ...ascii(text)]);
}

function iTXtChunk(keyword: string, text: string, compress: boolean): number[] {
  const textBytes = compress ? Array.from(zlibSync(strToU8(text))) : Array.from(strToU8(text));
  return pngChunk("iTXt", [...ascii(keyword), 0, compress ? 1 : 0, 0, 0, 0, ...textBytes]);
}

function image(bytes: Uint8Array, overrides: Partial<ImageModel> = {}): ImageModel {
  return { index: 0, bytes, mime: "image/jpeg", ...overrides };
}

// ---- Tests ------------------------------------------------------------------

describe("Détecteur — signaux image", () => {
  it("ne signale rien pour une vraie photo, à part le rappel que l'absence de C2PA n'est pas une preuve", () => {
    const bytes = buildJpeg([
      {
        marker: 0xe1,
        data: exifApp1([
          { tag: TAG_MAKE, value: "Canon" },
          { tag: TAG_MODEL, value: "Canon EOS 5D Mark IV" },
          { tag: TAG_SOFTWARE, value: "Adobe Lightroom 13.2" },
        ]),
      },
    ]);
    const findings = analyzeImageSignals([image(bytes, { width: 6000, height: 4000 })]);
    // Aucun signal à charge — seul le rappel informatif (poids 0) que l'absence de
    // déclaration C2PA est une vérification non concluante, pas une preuve de propreté.
    expect(findings).toHaveLength(1);
    expect(findings[0]!.signal).toBe("image_c2pa_verification_status");
    expect(findings[0]!.severity).toBe("info");
    expect(findings[0]!.weight).toBe(0);
  });

  it("détecte digitalSourceType=trainedAlgorithmicMedia dans le XMP (C2PA/IPTC)", () => {
    const xml =
      '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF><rdf:Description ' +
      'plus:digitalSourceType="http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia"/>' +
      "</rdf:RDF></x:xmpmeta>";
    const bytes = buildJpeg([{ marker: 0xe1, data: xmpApp1(xml) }]);
    const findings = analyzeImageSignals([image(bytes, { index: 4 })]);

    // Déclaré => pas de finding de couverture C2PA en plus (voir test ci-dessus).
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.category).toBe("image");
    expect(f.signal).toBe("image_c2pa_ai_source");
    // Signal spoofable (simple sous-chaîne, aucune vérification cryptographique) :
    // ni le plus sévère, ni le plus lourd du catalogue (voir image_png_generation_parameters à 0.93).
    expect(f.severity).toBe("moyen");
    expect(f.weight).toBeLessThan(0.6);
    expect(f.weight).toBeGreaterThan(0);
    expect(f.location).toEqual({ imageIndex: 4, label: "Image 5" });
    expect(f.evidence).toContain("trainedAlgorithmicMedia");
    expect(f.explanation).toContain("trainedAlgorithmicMedia");
    expect(f.explanation).toMatch(/non authentifiée/);
    expect(f.explanation).not.toMatch(/plus fiable/);
  });

  it("détecte aussi la variante compositeWithTrainedAlgorithmicMedia", () => {
    const xml =
      'plus:digitalSourceType="http://cv.iptc.org/newscodes/digitalsourcetype/compositeWithTrainedAlgorithmicMedia"';
    const bytes = buildJpeg([{ marker: 0xe1, data: xmpApp1(xml) }]);
    const findings = analyzeImageSignals([image(bytes)]);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.signal).toBe("image_c2pa_ai_source");
    expect(findings[0]!.evidence).toContain("compositeWithTrainedAlgorithmicMedia");
  });

  it("détecte un JUMBF/C2PA en APP11 quand le XMP est absent", () => {
    const jumbfText = "some_binary_prefix trainedAlgorithmicMedia trailing";
    const bytes = buildJpeg([{ marker: 0xeb, data: new Uint8Array(ascii(jumbfText)) }]);
    const findings = analyzeImageSignals([image(bytes)]);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.evidence).toContain("trainedAlgorithmicMedia");
  });

  it("détecte un C2PA embarqué dans le chunk PNG « caBX » (Google Gemini/Imagen)", () => {
    // Motif confirmé sur une vraie image générée par Gemini : le chunk caBX
    // embarque un manifeste JUMBF/CBOR binaire, mais la valeur digitalSourceType
    // y reste lisible en clair au milieu des octets binaires — exactement comme
    // pour le JUMBF en APP11 JPEG (voir le test ci-dessus).
    const cabxData = [
      ...ascii("\x00\x00=3jumb\x00\x00\x00\x1ejumdc2pa"),
      ...ascii(
        'Google Generative AI".qdigitalSourceTypexFhttp://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia END',
      ),
    ];
    const bytes = buildPng([pngChunk("caBX", cabxData)]);
    const findings = analyzeImageSignals([image(bytes, { mime: "image/png" })]);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.signal).toBe("image_c2pa_ai_source");
    // La citation doit être l'URI IPTC propre, sans le bruit binaire CBOR/JUMBF
    // ("Google Generative AI".qdigitalSourceTypex...) qui la précède dans les
    // octets bruts — motif réel observé sur une vraie image Gemini.
    expect(findings[0]!.evidence).toBe("http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia");
    expect(findings[0]!.explanation).toContain("caBX");
  });

  it("ignore un chunk caBX sans digitalSourceType IA (ex. juste une signature C2PA générique)", () => {
    const bytes = buildPng([pngChunk("caBX", ascii("jumb jumd c2pa some_other_unrelated_manifest_content"))]);
    const findings = analyzeImageSignals([image(bytes, { mime: "image/png" })]);
    expect(findings.some((f) => f.signal === "image_c2pa_ai_source")).toBe(false);
  });

  it("détecte une balise EXIF Software nommant un générateur connu", () => {
    const bytes = buildJpeg([{ marker: 0xe1, data: exifApp1([{ tag: TAG_SOFTWARE, value: "Midjourney 6.1" }]) }]);
    const findings = analyzeImageSignals([image(bytes, { width: 1024, height: 1024 })]);

    // EXIF present => the weak "no EXIF" heuristic must NOT also fire, even at an AI-typical resolution.
    // No C2PA declaration => the coverage reminder finding is also present alongside it.
    expect(findings).toHaveLength(2);
    const f = findings.find((x) => x.signal === "image_exif_generator_tag")!;
    expect(f.severity).toBe("moyen");
    expect(f.evidence).toBe("Midjourney 6.1");
    expect(f.explanation).toContain("Midjourney 6.1");
  });

  it("détecte une balise EXIF Make nommant un générateur connu", () => {
    const bytes = buildJpeg([{ marker: 0xe1, data: exifApp1([{ tag: TAG_MAKE, value: "Stable Diffusion" }]) }]);
    const findings = analyzeImageSignals([image(bytes)]);
    expect(findings).toHaveLength(2);
    const f = findings.find((x) => x.signal === "image_exif_generator_tag")!;
    expect(f.label).toContain("Fabricant");
  });

  it("détecte un chunk PNG tEXt « parameters » (Stable Diffusion WebUI)", () => {
    const prompt =
      "a cinematic photo of a red fox in a forest, masterpiece, highly detailed\n" +
      "Negative prompt: blurry, low quality\n" +
      "Steps: 24, Sampler: DPM++ 2M Karras, CFG scale: 7, Seed: 918273645, Size: 512x512, Model: v1-5-pruned-emaonly";
    const bytes = buildPng([tEXtChunk("parameters", prompt)]);
    const findings = analyzeImageSignals([image(bytes, { mime: "image/png" })]);

    expect(findings).toHaveLength(2);
    const f = findings.find((x) => x.signal === "image_png_generation_parameters")!;
    expect(f.category).toBe("image");
    expect(f.severity).toBe("eleve");
    expect(f.evidence).toContain("Steps: 24");
    expect(f.explanation).toContain("AUTOMATIC1111");
  });

  it("détecte un chunk PNG iTXt compressé « parameters »", () => {
    const prompt = "un chat astronaute, style aquarelle, Steps: 30, Seed: 42";
    const bytes = buildPng([iTXtChunk("parameters", prompt, true)]);
    const findings = analyzeImageSignals([image(bytes, { mime: "image/png" })]);
    expect(findings).toHaveLength(2);
    const f = findings.find((x) => x.signal === "image_png_generation_parameters")!;
    expect(f.evidence).toContain("Seed: 42");
  });

  it("détecte un chunk PNG « Software » nommant un générateur connu", () => {
    const bytes = buildPng([tEXtChunk("Software", "NightCafe Creator")]);
    const findings = analyzeImageSignals([image(bytes, { mime: "image/png" })]);
    expect(findings).toHaveLength(2);
    const f = findings.find((x) => x.signal === "image_png_generation_software")!;
    expect(f.evidence).toContain("NightCafe Creator");
  });

  it("ne signale rien pour un PNG sans chunk texte pertinent, à part le rappel de couverture C2PA", () => {
    const bytes = buildPng([tEXtChunk("Comment", "Créé avec GIMP")]);
    const findings = analyzeImageSignals([image(bytes, { mime: "image/png", width: 3000, height: 2000 })]);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.signal).toBe("image_c2pa_verification_status");
  });

  it("signal faible : résolution typique d'un générateur, sans aucune EXIF", () => {
    const bytes = buildJpeg([]); // SOI+EOI only, no APP1 at all
    const findings = analyzeImageSignals([image(bytes, { width: 1024, height: 1792 })]);

    expect(findings).toHaveLength(2);
    const f = findings.find((x) => x.signal === "image_no_exif_generator_resolution")!;
    expect(f.severity).toBe("faible");
    expect(f.weight).toBeLessThan(0.3);
    expect(f.evidence).toBe("1024×1792");
    expect(f.explanation).toMatch(/ne prouve rien/);
  });

  it("ne signale rien sans EXIF si la résolution n'est pas typique d'un générateur, à part le rappel de couverture C2PA", () => {
    const bytes = buildJpeg([]);
    const findings = analyzeImageSignals([image(bytes, { width: 4032, height: 3024 })]);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.signal).toBe("image_c2pa_verification_status");
  });

  it("cumule plusieurs signaux distincts sur une même image quand ils sont tous présents", () => {
    const xml = 'plus:digitalSourceType="http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia"';
    const bytes = buildJpeg([
      { marker: 0xe1, data: xmpApp1(xml) },
      { marker: 0xe1, data: exifApp1([{ tag: TAG_SOFTWARE, value: "DALL-E 3" }]) },
    ]);
    const findings = analyzeImageSignals([image(bytes)]);
    const signals = findings.map((f) => f.signal).sort();
    expect(signals).toEqual(["image_c2pa_ai_source", "image_exif_generator_tag"]);
  });

  it("indexe correctement plusieurs images d'un document (utilise ImageModel.index, pas la position)", () => {
    const bytes = buildJpeg([]);
    const images: ImageModel[] = [
      image(bytes, { index: 0, width: 100, height: 100 }),
      image(bytes, { index: 2, width: 1024, height: 1024 }),
    ];
    const findings = analyzeImageSignals(images);
    // 1 finding per image (the 100×100 one isn't AI-typical) + 1 coverage reminder.
    expect(findings).toHaveLength(2);
    const f = findings.find((x) => x.signal === "image_no_exif_generator_resolution")!;
    expect(f.location).toEqual({ imageIndex: 2, label: "Image 3" });
  });

  it("ne lève jamais d'exception sur des octets malformés/tronqués et ignore simplement l'image", () => {
    const garbage = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff, 0x00, 0x01, 0x02]);
    expect(() => analyzeImageSignals([image(garbage)])).not.toThrow();

    const truncatedPng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00]);
    expect(() => analyzeImageSignals([image(truncatedPng, { mime: "image/png" })])).not.toThrow();

    const empty = new Uint8Array([]);
    expect(analyzeImageSignals([image(empty)])).toEqual([]);
  });

  it("retourne un tableau vide pour un document sans image", () => {
    expect(analyzeImageSignals([])).toEqual([]);
  });
});

// ---- WebP fixtures (basic RIFF chunk builder) -------------------------------

function webpChunk(fourCC: string, data: number[]): number[] {
  const chunk = [...ascii(fourCC), ...le32(data.length), ...data];
  if (data.length % 2 === 1) chunk.push(0); // RIFF pads odd-sized chunks
  return chunk;
}

function buildWebp(chunks: number[][]): Uint8Array {
  const payload = chunks.flat();
  return new Uint8Array([...ascii("RIFF"), ...le32(4 + payload.length), ...ascii("WEBP"), ...payload]);
}

describe("Détecteur — signaux image (WebP)", () => {
  it("détecte une balise EXIF d'un générateur connu dans le chunk RIFF EXIF ; sans déclaration C2PA, le rappel de couverture s'ajoute (WebP est désormais checkable comme JPEG/PNG)", () => {
    const exifData = Array.from(buildTiffAscii([{ tag: TAG_SOFTWARE, value: "Midjourney 6.1" }]));
    const bytes = buildWebp([webpChunk("EXIF", exifData)]);
    const findings = analyzeImageSignals([image(bytes, { mime: "image/webp" })]);

    const signals = findings.map((f) => f.signal).sort();
    expect(signals).toEqual(["image_c2pa_verification_status", "image_exif_generator_tag"]);
    expect(findings.find((f) => f.signal === "image_exif_generator_tag")!.evidence).toBe("Midjourney 6.1");
  });

  it("détecte une déclaration C2PA dans le chunk RIFF XMP d'un WebP", () => {
    const xml = 'plus:digitalSourceType="http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia"';
    const bytes = buildWebp([webpChunk("XMP ", ascii(xml))]);
    const findings = analyzeImageSignals([image(bytes, { mime: "image/webp" })]);

    expect(findings.some((f) => f.signal === "image_c2pa_ai_source")).toBe(true);
    // Déclaré => WebP compte comme "checkable" ET "déclaré" (voir isC2paCheckable),
    // donc pas de finding de couverture C2PA en plus — même logique que JPEG/PNG.
    expect(findings.some((f) => f.signal === "image_c2pa_verification_status")).toBe(false);
  });

  // Non-régression : avant ce correctif, aucun équivalent structuré de JUMBF/caBX
  // n'était recherché pour WebP — ce test échouait (0 finding image_c2pa_ai_source)
  // car seul le XMP RIFF était lu. La spec C2PA standardise pourtant, pour les
  // conteneurs RIFF, un chunk top-level nommé `C2PA` portant le même manifeste
  // JUMBF que JUMBF/APP11 (JPEG) ou `caBX` (PNG) — confirmé dans l'implémentation
  // de référence du consortium (c2pa-rs, asset_handlers::riff_io::C2PA_CHUNK_ID).
  it("détecte un C2PA embarqué dans le chunk RIFF « C2PA » d'un WebP (mécanisme standardisé par la spec, absent du XMP)", () => {
    // Même motif que le test caBX PNG ci-dessus : un manifeste JUMBF/CBOR binaire
    // dans lequel la valeur digitalSourceType reste lisible en clair au milieu
    // d'octets non-imprimables.
    const c2paData = [
      ...ascii("\x00\x00=3jumb\x00\x00\x00\x1ejumdc2pa"),
      ...ascii(
        'Some AI Generator".qdigitalSourceTypexFhttp://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia END',
      ),
    ];
    const bytes = buildWebp([webpChunk("C2PA", c2paData)]);
    const findings = analyzeImageSignals([image(bytes, { mime: "image/webp" })]);

    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.signal).toBe("image_c2pa_ai_source");
    // Citation nettoyée du bruit binaire CBOR/JUMBF qui la précède, comme pour caBX.
    expect(f.evidence).toBe("http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia");
    expect(f.explanation).toContain("C2PA");
    expect(f.explanation).toMatch(/non authentifiée/);
  });

  it("ignore un chunk RIFF « C2PA » sans digitalSourceType IA (ex. juste une signature C2PA générique)", () => {
    const bytes = buildWebp([webpChunk("C2PA", ascii("jumb jumd c2pa some_other_unrelated_manifest_content"))]);
    const findings = analyzeImageSignals([image(bytes, { mime: "image/webp" })]);
    expect(findings.some((f) => f.signal === "image_c2pa_ai_source")).toBe(false);
    // Chunk présent mais non déclarant => toujours "checkable", toujours "non déclaré".
    expect(findings.some((f) => f.signal === "image_c2pa_verification_status")).toBe(true);
  });

  it("un WebP sans aucun chunk (EXIF/XMP/C2PA) ne produit que le rappel de couverture C2PA", () => {
    const bytes = buildWebp([]);
    const findings = analyzeImageSignals([image(bytes, { mime: "image/webp" })]);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.signal).toBe("image_c2pa_verification_status");
  });
});

// ---- Constat détecteur : images PDF non-JPEG ignorées à l'ingestion --------

describe("Détecteur — avertissement images non-JPEG ignorées (PDF)", () => {
  it("ajoute un finding informatif quand l'ingestion PDF signale des images non-JPEG ignorées", () => {
    const findings = analyzeImageSignals([], { sourceFormat: "pdf", skippedNonJpegImages: 2 });
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.signal).toBe("image_pdf_non_jpeg_skipped");
    expect(f.severity).toBe("info");
    expect(f.weight).toBe(0);
    expect(f.explanation).toContain("2 image");
  });

  it("n'ajoute rien si aucune image n'a été ignorée", () => {
    expect(analyzeImageSignals([], { sourceFormat: "pdf" })).toEqual([]);
  });
});
