/**
 * Dimensions intrinsèques d'une image à partir de ses octets bruts — utilisé
 * uniquement pour un fichier image ouvert seul (sans document conteneur), où
 * personne d'autre ne les fournit déjà. Best effort : jamais d'exception,
 * `{}` quand le format n'est pas reconnu ou que les octets sont tronqués —
 * seul le signal faible "résolution typique d'un générateur" (imageSignals.ts)
 * en dépend, ce n'est jamais bloquant pour le reste de l'analyse.
 */

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function isPng(bytes: Uint8Array): boolean {
  return bytes.length >= PNG_SIGNATURE.length && PNG_SIGNATURE.every((b, i) => bytes[i] === b);
}

function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8;
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset]! << 24) | (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>> 0;
}

function readPngDimensions(bytes: Uint8Array): { width?: number; height?: number } {
  // Signature(8) + longueur IHDR(4) + "IHDR"(4) + largeur(4) + hauteur(4) —
  // l'IHDR est toujours le tout premier chunk d'un PNG valide, à position fixe.
  if (bytes.length < 24) return {};
  return { width: readUint32BE(bytes, 16), height: readUint32BE(bytes, 20) };
}

// Marqueurs "Start Of Frame" portant les dimensions — exclut DHT/JPG/DAC qui
// partagent la même plage 0xC0-0xCF sans être des SOF.
const SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function readJpegDimensions(bytes: Uint8Array): { width?: number; height?: number } {
  let offset = 2; // après les deux octets SOI (0xFFD8)
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = bytes[offset + 1]!;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2; // marqueurs sans segment de longueur
      continue;
    }
    if (marker === 0xd9) break; // EOI
    const length = ((bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>> 0;
    if (SOF_MARKERS.has(marker)) {
      if (offset + 9 > bytes.length) return {};
      const height = (bytes[offset + 5]! << 8) | bytes[offset + 6]!;
      const width = (bytes[offset + 7]! << 8) | bytes[offset + 8]!;
      return { width, height };
    }
    offset += 2 + length;
  }
  return {};
}

export function readImageDimensions(bytes: Uint8Array): { width?: number; height?: number } {
  try {
    if (isPng(bytes)) return readPngDimensions(bytes);
    if (isJpeg(bytes)) return readJpegDimensions(bytes);
    return {};
  } catch {
    return {};
  }
}
