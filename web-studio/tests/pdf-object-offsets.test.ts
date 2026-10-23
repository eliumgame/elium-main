import { describe, expect, it } from "vitest";
import { objectOffsets } from "../src/pdf/ops/security";

/** Référence : l'implémentation d'origine (chaîne latin1 + expression régulière). */
function reference(bytes: Uint8Array): Map<string, number> {
  const out = new Map<string, number>();
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const re = /(?:^|[\s>\]])(\d{1,10})\s+(\d{1,5})\s+obj\b/g;
  for (let m: RegExpExecArray | null; (m = re.exec(text));) out.set(`${+m[1]!} ${+m[2]!} R`, m.index);
  return out;
}
const enc = (s: string) => new TextEncoder().encode(s);

describe("objectOffsets sans conversion du fichier en chaîne", () => {
  it("donne les mêmes positions que l'expression d'origine", () => {
    const samples = [
      "%PDF-1.7\n1 0 obj\n<< /A 2 0 R >>\nendobj\n12 3 obj\n<<>>\nendobj\r\n7 0 obj<</K[1 2 0 R]>>endobj",
      "3 0 obj\nx\nendobj 4 0 obj\ny\nendobj\n99999 65535 obj\n1234567890123 0 obj\n5 0 objx\n6 0 obj\n",
      "<</Length 5>>stream\n1 0 obj inside\nendstream\n>>8 0 obj\n]9 1 obj\nobj\n 10 0 obj",
      "",
    ];
    for (const s of samples) expect(objectOffsets(enc(s))).toEqual(reference(enc(s)));
  });
  it("même résultat sur un contenu binaire pseudo-aléatoire parsemé d'objets", () => {
    let x = 12345;
    const chunks: number[] = [];
    for (let i = 0; i < 20000; i++) {
      x = (x * 1103515245 + 12345) & 0x7fffffff;
      chunks.push(x & 0xff);
      if (i % 700 === 0) chunks.push(...enc(`\n${(i / 700) | 0} 0 obj\n`));
    }
    const bytes = new Uint8Array(chunks);
    expect(objectOffsets(bytes)).toEqual(reference(bytes));
  });
});
