/**
 * WOFF 1.0 → sfnt (TrueType/OpenType). pdf-lib/fontkit sait lire un TTF de façon fiable (et le sous-ensembler) ;
 * les polices Carlito sont embarquées en WOFF (22 Ko chacune), on les décompresse ici avec fflate.
 */
import { unzlibSync } from "fflate";

export function woffToSfnt(woff: Uint8Array): Uint8Array {
  const dv = new DataView(woff.buffer, woff.byteOffset, woff.byteLength);
  if (dv.getUint32(0) !== 0x774f4646) throw new Error("Police WOFF invalide.");
  const flavor = dv.getUint32(4);
  const numTables = dv.getUint16(12);
  interface Tab {
    tag: number;
    data: Uint8Array;
    checksum: number;
  }
  const tabs: Tab[] = [];
  for (let i = 0; i < numTables; i++) {
    const o = 44 + i * 20;
    const offset = dv.getUint32(o + 4);
    const comp = dv.getUint32(o + 8);
    const orig = dv.getUint32(o + 12);
    const raw = woff.subarray(offset, offset + comp);
    tabs.push({
      tag: dv.getUint32(o),
      data: comp < orig ? unzlibSync(raw) : raw.slice(),
      checksum: dv.getUint32(o + 16),
    });
  }
  tabs.sort((a, b) => a.tag - b.tag);
  const dirLen = 12 + 16 * numTables;
  let total = dirLen;
  const offsets = tabs.map((t) => {
    const o = total;
    total += (t.data.length + 3) & ~3;
    return o;
  });
  const out = new Uint8Array(total);
  const ov = new DataView(out.buffer);
  ov.setUint32(0, flavor);
  ov.setUint16(4, numTables);
  let pow = 1;
  let log = 0;
  while (pow * 2 <= numTables) {
    pow *= 2;
    log++;
  }
  ov.setUint16(6, pow * 16);
  ov.setUint16(8, log);
  ov.setUint16(10, numTables * 16 - pow * 16);
  tabs.forEach((t, i) => {
    const r = 12 + i * 16;
    ov.setUint32(r, t.tag);
    ov.setUint32(r + 4, t.checksum);
    ov.setUint32(r + 8, offsets[i]);
    ov.setUint32(r + 12, t.data.length);
    out.set(t.data, offsets[i]);
  });
  return out;
}
