import { describe, it, expect } from "vitest";
import { bytesToBase64, base64ToBytes, serializePdfDoc, type Anno, type PageRef } from "../src/pdf/model";

describe("PDF persistence — base64 round-trip", () => {
  it("round-trips arbitrary bytes including the 0x8000 chunk boundary", () => {
    const bytes = new Uint8Array(0x8000 * 2 + 123);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) & 0xff;
    const back = base64ToBytes(bytesToBase64(bytes));
    expect(back.length).toBe(bytes.length);
    expect(Array.from(back)).toEqual(Array.from(bytes));
  });

  it("preserves a fake %PDF header verbatim", () => {
    const pdf = new TextEncoder().encode("%PDF-1.7\n%âãÏÓ\n1 0 obj\n");
    expect(Array.from(base64ToBytes(bytesToBase64(pdf)))).toEqual(Array.from(pdf));
  });
});

describe("PDF persistence — serialize/deserialize a document", () => {
  it("survives JSON and reconstructs bytes, pages and annotations", () => {
    const pdfBytes = new Uint8Array([37, 80, 68, 70, 1, 2, 3, 250, 0, 255]); // %PDF…
    const pages: PageRef[] = [
      { id: "pg-1", from: 0 },
      { id: "pg-2", from: null }, // inserted blank
      { id: "pg-3", from: 1 },
    ];
    const annos: Record<string, Anno[]> = {
      "pg-1": [{ id: "an-1", type: "text", x: 10, y: 20, w: 100, h: 24, color: "#e11d48", strokeWidth: 2, fontSize: 16, text: "Bonjour" }],
      "pg-3": [{ id: "an-2", type: "rect", x: 5, y: 5, w: 50, h: 40, color: "#2563eb", strokeWidth: 3, fontSize: 16 }],
    };

    const doc = serializePdfDoc("rapport.pdf", pdfBytes, pages, annos);
    const round = JSON.parse(JSON.stringify(doc)) as typeof doc;

    expect(round.v).toBe(1);
    expect(round.name).toBe("rapport.pdf");
    expect(Array.from(base64ToBytes(round.pdf))).toEqual(Array.from(pdfBytes));
    expect(round.pages).toEqual(pages);
    expect(round.annos).toEqual(annos);
  });
});
