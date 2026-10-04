import { describe, it, expect } from "vitest";
import { isBlankPixels, ocrWorkerCount } from "../src/pdf/ops/ocr";

describe("OCR : dimensionnement du pool", () => {
  it("un worker par cœur libre, plafonné, jamais plus que de pages", () => {
    expect(ocrWorkerCount(100, 1)).toBe(1);
    expect(ocrWorkerCount(100, 4)).toBe(3);
    expect(ocrWorkerCount(100, 32)).toBe(4);
    expect(ocrWorkerCount(2, 32)).toBe(2);
    expect(ocrWorkerCount(1, 32)).toBe(1);
    expect(ocrWorkerCount(100, 16, 4)).toBe(2); // peu de mémoire
  });
});

describe("OCR : détection des pages blanches", () => {
  const page = (w: number, h: number, paint: (set: (x: number, y: number) => void) => void) => {
    const px = new Uint8ClampedArray(w * h * 4).fill(255);
    paint((x, y) => {
      const i = (y * w + x) * 4;
      px[i] = px[i + 1] = px[i + 2] = 10;
    });
    return px;
  };
  it("une page blanche (ou presque) est ignorée, une page de texte non", () => {
    const w = 800;
    const h = 1000;
    expect(isBlankPixels(page(w, h, () => {}), w, h)).toBe(true);
    const text = page(w, h, (set) => {
      for (let y = 100; y < 900; y += 20) for (let x = 80; x < 700; x++) for (let k = 0; k < 4; k++) set(x, y + k);
    });
    expect(isBlankPixels(text, w, h)).toBe(false);
  });
});
