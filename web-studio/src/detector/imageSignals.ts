/**
 * Détecteur — signaux "image" : cherche des marqueurs de provenance IA dans
 * les octets bruts des images (JPEG/PNG), sans dépendance externe. Ordre de
 * priorité (le plus fiable en premier) :
 *   1. C2PA/IPTC `digitalSourceType` (XMP APP1 ou JUMBF APP11 en JPEG, chunk
 *      `caBX` en PNG) — une déclaration de provenance embarquée et souvent
 *      signée par l'outil de création lui-même (ex. Google Gemini/Imagen).
 *   2. Métadonnées PNG de génération (chunk tEXt/zTXt/iTXt "parameters" ou
 *      "Software"), convention Stable Diffusion WebUI (AUTOMATIC1111).
 *   3. Balises EXIF Make/Model/Software nommant un générateur connu.
 *   4. Signal faible : aucune EXIF appareil + résolution typique d'un
 *      générateur — jamais une preuve à lui seul, seulement complémentaire.
 * Le parsing binaire est volontairement défensif : toute image malformée ou
 * tronquée est ignorée (try/catch par image), jamais une exception qui
 * interromprait l'analyse du document entier.
 */
import { unzlibSync } from "fflate";
import type { Finding, ImageModel, SignalSeverity } from "./types";

const KNOWN_AI_GENERATORS = [
  "Midjourney",
  "DALL·E",
  "DALL-E",
  "Stable Diffusion",
  "NightCafe",
  "Adobe Firefly",
  "Leonardo.Ai",
  "Bing Image Creator",
  "Playground AI",
  "Ideogram",
];

function matchKnownGenerator(value: string): string | undefined {
  const lower = value.toLowerCase();
  for (const name of KNOWN_AI_GENERATORS) {
    if (lower.includes(name.toLowerCase())) return name;
  }
  return undefined;
}

const AI_TYPICAL_RESOLUTIONS: ReadonlyArray<readonly [number, number]> = [
  [512, 512],
  [768, 768],
  [1024, 1024],
  [1024, 1536],
  [1536, 1024],
  [1024, 1792],
  [1792, 1024],
  [1152, 896],
  [896, 1152],
];

function isAiTypicalResolution(width: number | undefined, height: number | undefined): boolean {
  if (width == null || height == null) return false;
  return AI_TYPICAL_RESOLUTIONS.some(([w, h]) => w === width && h === height);
}

/** Byte-for-byte string (1 char per byte) — used to scan ASCII markers inside
 * binary segments without pulling in a full decoder; never throws. */
function bytesToLatin1(bytes: Uint8Array): string {
  let out = "";
  const CHUNK = 0x2000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return out;
}

function utf8Decode(bytes: Uint8Array): string {
  try {
    return new TextDecoder().decode(bytes);
  } catch {
    return bytesToLatin1(bytes);
  }
}

function excerpt(text: string, max = 180): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

function makeFinding(
  image: ImageModel,
  signal: string,
  label: string,
  explanation: string,
  severity: SignalSeverity,
  weight: number,
  evidence?: string,
): Finding {
  return {
    id: `img-${image.index}-${signal}`,
    category: "image",
    signal,
    label,
    explanation,
    severity,
    weight,
    location: { imageIndex: image.index, label: `Image ${image.index + 1}` },
    evidence,
  };
}

// ---- JPEG segment walking --------------------------------------------------

interface JpegSegment {
  marker: number;
  data: Uint8Array;
}

/** Markers with no length field: TEM (0x01), RSTn/EOI (0xD0-0xD9). */
function isLengthlessMarker(marker: number): boolean {
  return marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9);
}

function readJpegSegments(bytes: Uint8Array): JpegSegment[] {
  const segments: JpegSegment[] = [];
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return segments;
  let i = 2;
  while (i + 1 < bytes.length) {
    if (bytes[i] !== 0xff) {
      i++;
      continue;
    }
    let j = i + 1;
    while (bytes[j] === 0xff && j + 1 < bytes.length) j++; // skip fill bytes
    const marker = bytes[j]!;
    if (isLengthlessMarker(marker)) {
      i = j + 1;
      if (marker === 0xd9) break; // EOI
      continue;
    }
    const lenOffset = j + 1;
    if (lenOffset + 1 >= bytes.length) break;
    const len = ((bytes[lenOffset]! << 8) | bytes[lenOffset + 1]!) >>> 0;
    if (len < 2) break;
    const dataStart = lenOffset + 2;
    const dataEnd = lenOffset + len;
    if (dataEnd > bytes.length) break;
    segments.push({ marker, data: bytes.subarray(dataStart, dataEnd) });
    if (marker === 0xda) break; // SOS: entropy-coded data follows, no more markers to trust
    i = dataEnd;
  }
  return segments;
}

const XMP_STANDARD_ID = "http://ns.adobe.com/xap/1.0/";
const XMP_EXTENSION_ID = "http://ns.adobe.com/xmp/extension/";

function extractXmpText(app1Data: Uint8Array): string | undefined {
  const text = bytesToLatin1(app1Data);
  if (text.startsWith(XMP_STANDARD_ID)) return text.slice(XMP_STANDARD_ID.length + 1);
  if (text.startsWith(XMP_EXTENSION_ID)) return text.slice(XMP_EXTENSION_ID.length + 1);
  return undefined;
}

/** IPTC PlusVocabulary digitalSourceType URIs naming AI/algorithmic authorship,
 * e.g. ".../trainedAlgorithmicMedia" and ".../compositeWithTrainedAlgorithmicMedia"
 * (the latter contains the former as a substring, so one pattern covers both).
 * Tried first: anchored on "http(s)://" for a clean, exact URI — the value IPTC
 * actually standardizes and what a real CBOR/JUMBF manifest encodes as one
 * contiguous run of bytes (confirmed on a real Google Gemini PNG: the raw
 * bytes read literally `http://cv.iptc.org/.../trainedAlgorithmicMedia` with
 * no separator, so a bare charset sweep pulls in whatever CBOR/binary noise
 * happens to sit right before "http" too). Falls back to the loose sweep
 * (no scheme required) for a manifest that only carries the bare keyword. */
const C2PA_AI_SOURCE_URL_RE = /https?:\/\/[a-z0-9:/_.-]*trainedalgorithmicmedia[a-z0-9:/_.-]*/i;
const C2PA_AI_SOURCE_LOOSE_RE = /[a-z0-9:/_.-]*trainedalgorithmicmedia[a-z0-9:/_.-]*/i;

function matchC2paAiSource(text: string): string | undefined {
  return C2PA_AI_SOURCE_URL_RE.exec(text)?.[0] ?? C2PA_AI_SOURCE_LOOSE_RE.exec(text)?.[0];
}

interface C2paHit {
  source: string;
  value: string;
}

function findC2paAiSource(xmpTexts: string[], jumbfTexts: string[]): C2paHit | undefined {
  for (const t of xmpTexts) {
    const m = matchC2paAiSource(t);
    if (m) return { source: "XMP", value: m };
  }
  for (const t of jumbfTexts) {
    const m = matchC2paAiSource(t);
    if (m) return { source: "C2PA/JUMBF", value: m };
  }
  return undefined;
}

// ---- EXIF (Make/Model/Software, IFD0 only) --------------------------------

interface ExifTags {
  make?: string;
  model?: string;
  software?: string;
}

const EXIF_ID = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]; // "Exif\0\0"
const TAG_MAKE = 0x010f;
const TAG_MODEL = 0x0110;
const TAG_SOFTWARE = 0x0131;
const TYPE_ASCII = 2;

function readExif(app1Data: Uint8Array): ExifTags | undefined {
  if (app1Data.length < EXIF_ID.length + 8) return undefined;
  for (let k = 0; k < EXIF_ID.length; k++) {
    if (app1Data[k] !== EXIF_ID[k]) return undefined;
  }
  const tiff = app1Data.subarray(EXIF_ID.length);
  if (tiff.length < 8) return undefined;
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  let little: boolean;
  if (tiff[0] === 0x49 && tiff[1] === 0x49) little = true;
  else if (tiff[0] === 0x4d && tiff[1] === 0x4d) little = false;
  else return undefined;
  if (view.getUint16(2, little) !== 42) return undefined;
  const ifd0Offset = view.getUint32(4, little);
  if (ifd0Offset + 2 > tiff.length) return undefined;
  const entryCount = view.getUint16(ifd0Offset, little);
  const tags: ExifTags = {};
  for (let e = 0; e < entryCount; e++) {
    const entryOffset = ifd0Offset + 2 + e * 12;
    if (entryOffset + 12 > tiff.length) break;
    const tag = view.getUint16(entryOffset, little);
    const type = view.getUint16(entryOffset + 2, little);
    const count = view.getUint32(entryOffset + 4, little);
    let key: keyof ExifTags | undefined;
    if (tag === TAG_MAKE) key = "make";
    else if (tag === TAG_MODEL) key = "model";
    else if (tag === TAG_SOFTWARE) key = "software";
    if (!key || type !== TYPE_ASCII) continue;
    let strBytes: Uint8Array;
    if (count <= 4) {
      strBytes = tiff.subarray(entryOffset + 8, entryOffset + 8 + count);
    } else {
      const dataOffset = view.getUint32(entryOffset + 8, little);
      if (dataOffset + count > tiff.length) continue;
      strBytes = tiff.subarray(dataOffset, dataOffset + count);
    }
    // ASCII EXIF strings are NUL-terminated; the trailing NUL counts toward `count`.
    const str = bytesToLatin1(strBytes)
      .replace(/\0+$/, "")
      .trim();
    if (str) tags[key] = str;
  }
  return Object.keys(tags).length ? tags : undefined;
}

const EXIF_FIELD_LABELS: Record<keyof ExifTags, string> = {
  software: "Software",
  make: "Fabricant (Make)",
  model: "Modèle (Model)",
};

interface ExifGeneratorHit {
  field: string;
  value: string;
  generator: string;
}

function matchExifGenerator(tags: ExifTags): ExifGeneratorHit | undefined {
  for (const key of ["software", "make", "model"] as const) {
    const value = tags[key];
    if (!value) continue;
    const generator = matchKnownGenerator(value);
    if (generator) return { field: EXIF_FIELD_LABELS[key], value, generator };
  }
  return undefined;
}

// ---- PNG chunk walking ------------------------------------------------------

interface PngChunk {
  type: string;
  data: Uint8Array;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function isPng(bytes: Uint8Array): boolean {
  if (bytes.length < PNG_SIGNATURE.length) return false;
  return PNG_SIGNATURE.every((b, i) => bytes[i] === b);
}

function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8;
}

function readPngChunks(bytes: Uint8Array): PngChunk[] {
  const chunks: PngChunk[] = [];
  let i = 8;
  while (i + 8 <= bytes.length) {
    const len = ((bytes[i]! << 24) | (bytes[i + 1]! << 16) | (bytes[i + 2]! << 8) | bytes[i + 3]!) >>> 0;
    const type = String.fromCharCode(bytes[i + 4]!, bytes[i + 5]!, bytes[i + 6]!, bytes[i + 7]!);
    const dataStart = i + 8;
    const dataEnd = dataStart + len;
    if (dataEnd + 4 > bytes.length) break;
    chunks.push({ type, data: bytes.subarray(dataStart, dataEnd) });
    if (type === "IEND") break;
    i = dataEnd + 4; // skip the 4-byte CRC, not verified here
  }
  return chunks;
}

function decodePngTextChunk(chunk: PngChunk): { keyword: string; text: string } | undefined {
  if (chunk.type === "tEXt") {
    const nul = chunk.data.indexOf(0);
    if (nul < 0) return undefined;
    return {
      keyword: bytesToLatin1(chunk.data.subarray(0, nul)),
      text: bytesToLatin1(chunk.data.subarray(nul + 1)),
    };
  }
  if (chunk.type === "zTXt") {
    const nul = chunk.data.indexOf(0);
    if (nul < 0 || nul + 2 > chunk.data.length) return undefined;
    const keyword = bytesToLatin1(chunk.data.subarray(0, nul));
    try {
      return { keyword, text: bytesToLatin1(unzlibSync(chunk.data.subarray(nul + 2))) };
    } catch {
      return undefined;
    }
  }
  if (chunk.type === "iTXt") {
    const kwEnd = chunk.data.indexOf(0);
    if (kwEnd < 0 || kwEnd + 3 > chunk.data.length) return undefined;
    const keyword = bytesToLatin1(chunk.data.subarray(0, kwEnd));
    const compressionFlag = chunk.data[kwEnd + 1];
    const langEnd = chunk.data.indexOf(0, kwEnd + 3);
    if (langEnd < 0) return undefined;
    const translatedEnd = chunk.data.indexOf(0, langEnd + 1);
    if (translatedEnd < 0) return undefined;
    const rest = chunk.data.subarray(translatedEnd + 1);
    try {
      const raw = compressionFlag === 1 ? unzlibSync(rest) : rest;
      return { keyword, text: utf8Decode(raw) };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

interface PngHit {
  kind: "parameters" | "software";
  text: string;
  generator?: string;
}

function findPngGenerationMetadata(chunks: PngChunk[]): PngHit | undefined {
  for (const chunk of chunks) {
    const parsed = decodePngTextChunk(chunk);
    if (parsed && parsed.keyword.toLowerCase() === "parameters" && parsed.text.trim()) {
      return { kind: "parameters", text: parsed.text };
    }
  }
  for (const chunk of chunks) {
    const parsed = decodePngTextChunk(chunk);
    if (parsed && parsed.keyword.toLowerCase() === "software") {
      const generator = matchKnownGenerator(parsed.text);
      if (generator) return { kind: "software", text: parsed.text, generator };
    }
  }
  return undefined;
}

// ---- Per-image analysis ------------------------------------------------------

function analyzeOneImage(image: ImageModel): Finding[] {
  const findings: Finding[] = [];
  const bytes = image.bytes;
  let hasCameraExif = false;

  if (isJpeg(bytes)) {
    const segments = readJpegSegments(bytes);
    let exifTags: ExifTags | undefined;
    const xmpTexts: string[] = [];
    const jumbfTexts: string[] = [];
    for (const seg of segments) {
      if (seg.marker === 0xe1) {
        if (!exifTags) exifTags = readExif(seg.data);
        const xmp = extractXmpText(seg.data);
        if (xmp) xmpTexts.push(xmp);
      } else if (seg.marker === 0xeb) {
        jumbfTexts.push(bytesToLatin1(seg.data));
      }
    }

    const c2paHit = findC2paAiSource(xmpTexts, jumbfTexts);
    if (c2paHit) {
      findings.push(
        makeFinding(
          image,
          "image_c2pa_ai_source",
          "Métadonnées C2PA/IPTC : source déclarée générée par IA",
          `Les métadonnées ${c2paHit.source} intégrées dans ce JPEG déclarent un « digitalSourceType » IPTC valant « ${c2paHit.value} », une valeur normalisée réservée aux contenus produits ou composés par un algorithme entraîné (IA générative). C'est le signal le plus fiable de ce détecteur : cette déclaration de provenance est embarquée directement par l'outil de création (Adobe Firefly, Bing Image Creator, ou tout autre logiciel conforme C2PA), et non déduite statistiquement.`,
          "eleve",
          0.97,
          c2paHit.value,
        ),
      );
    }

    if (exifTags) {
      hasCameraExif = true;
      const hit = matchExifGenerator(exifTags);
      if (hit) {
        findings.push(
          makeFinding(
            image,
            "image_exif_generator_tag",
            `Balise EXIF « ${hit.field} » : outil de génération IA connu`,
            `La balise EXIF ${hit.field} de cette image vaut « ${hit.value} », qui correspond au nom d'un outil de génération d'image par IA connu (${hit.generator}). Ce champ est écrit directement par le logiciel qui a produit ou exporté l'image.`,
            "moyen",
            0.6,
            hit.value,
          ),
        );
      }
    }
  } else if (isPng(bytes)) {
    const chunks = readPngChunks(bytes);

    // `caBX` est le chunk PNG standardisé par C2PA pour embarquer le même
    // manifeste JUMBF que celui utilisé dans les JPEG (APP11) — Google
    // Gemini/Imagen, entre autres, l'utilise pour signer ses images avec un
    // `digitalSourceType` IPTC (confirmé en pratique sur une vraie image
    // Gemini : chunk `caBX` contenant literallement la chaîne
    // ".../digitalsourcetype/trainedAlgorithmicMedia" signée par un
    // certificat Google C2PA Media Services).
    const cabxTexts = chunks.filter((c) => c.type === "caBX").map((c) => bytesToLatin1(c.data));
    const pngC2paHit = findC2paAiSource([], cabxTexts);
    if (pngC2paHit) {
      findings.push(
        makeFinding(
          image,
          "image_c2pa_ai_source",
          "Métadonnées C2PA/IPTC : source déclarée générée par IA",
          `Le chunk PNG « caBX » de cette image contient un manifeste C2PA déclarant un « digitalSourceType » IPTC valant « ${pngC2paHit.value} », une valeur normalisée réservée aux contenus produits ou composés par un algorithme entraîné (IA générative). C'est le signal le plus fiable de ce détecteur : cette déclaration de provenance est embarquée et signée directement par l'outil de création (Google Gemini/Imagen, Adobe Firefly, ou tout autre logiciel conforme C2PA), et non déduite statistiquement.`,
          "eleve",
          0.97,
          pngC2paHit.value,
        ),
      );
    }

    const hit = findPngGenerationMetadata(chunks);
    if (hit) {
      const isParameters = hit.kind === "parameters";
      findings.push(
        makeFinding(
          image,
          isParameters ? "image_png_generation_parameters" : "image_png_generation_software",
          isParameters
            ? "Métadonnées PNG de génération d'image (Stable Diffusion)"
            : "Métadonnées PNG « Software » : outil de génération IA connu",
          isParameters
            ? `Ce PNG contient un bloc de métadonnées texte nommé « parameters » — la convention utilisée par Stable Diffusion WebUI (AUTOMATIC1111) et les outils compatibles pour enregistrer le prompt et les réglages de génération directement dans le fichier image. Extrait : « ${excerpt(hit.text)} ».`
            : `Le champ de métadonnées PNG « Software » vaut « ${hit.text} », qui correspond au nom d'un outil de génération d'image par IA connu (${hit.generator}).`,
          "eleve",
          0.93,
          excerpt(hit.text),
        ),
      );
    }
  }

  if (!hasCameraExif && isAiTypicalResolution(image.width, image.height)) {
    findings.push(
      makeFinding(
        image,
        "image_no_exif_generator_resolution",
        "Résolution typique d'un générateur d'image IA, sans métadonnée EXIF",
        `Cette image mesure ${image.width}×${image.height} pixels, une résolution parmi celles produites par défaut par plusieurs générateurs d'image IA (par exemple 512×512, 1024×1024 ou 1024×1792), et ne comporte aucune métadonnée EXIF d'appareil (Make/Model/Software) — signe habituellement laissé par une vraie prise de vue. Ce signal, pris seul, ne prouve rien : le recadrage, l'export web ou la compression suppriment eux aussi couramment les métadonnées EXIF d'une photo authentique. Il ne s'agit que d'un indice faible et complémentaire.`,
        "faible",
        0.15,
        `${image.width}×${image.height}`,
      ),
    );
  }

  return findings;
}

export function analyzeImageSignals(images: ImageModel[]): Finding[] {
  const findings: Finding[] = [];
  for (const image of images) {
    try {
      findings.push(...analyzeOneImage(image));
    } catch {
      // Malformed/truncated image bytes: skip this image, keep analyzing the rest.
    }
  }
  return findings;
}
