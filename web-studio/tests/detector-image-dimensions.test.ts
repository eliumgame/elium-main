import { describe, expect, it } from "vitest";
import { readImageDimensions } from "../src/detector/ingest/imageDimensions";

function be16(n: number): number[] {
  return [(n >> 8) & 0xff, n & 0xff];
}
function ascii(s: string): number[] {
  return [...s].map((c) => c.charCodeAt(0));
}

function buildPng(width: number, height: number): Uint8Array {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const push32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const ihdrData = [...push32(width), ...push32(height), 8, 2, 0, 0, 0];
  const ihdr = [...push32(ihdrData.length), ...ascii("IHDR"), ...ihdrData, 0, 0, 0, 0];
  const iend = [...push32(0), ...ascii("IEND"), 0, 0, 0, 0];
  return new Uint8Array([...sig, ...ihdr, ...iend]);
}

function buildJpeg(width: number, height: number): Uint8Array {
  // SOI, then an APP0 filler segment (length computed from its own real byte
  // count, not hand-copied from the JFIF spec), then SOF0 carrying the real
  // dimensions, then EOI.
  const app0Data = [...ascii("JFIF"), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const app0 = [0xff, 0xe0, ...be16(app0Data.length + 2), ...app0Data];
  const sof0Data = [8 /* precision */, ...be16(height), ...be16(width), 1, 1, 0x11, 0];
  const sof0 = [0xff, 0xc0, ...be16(sof0Data.length + 2), ...sof0Data];
  return new Uint8Array([0xff, 0xd8, ...app0, ...sof0, 0xff, 0xd9]);
}

describe("detector — dimensions intrinsèques d'une image seule", () => {
  it("lit largeur/hauteur depuis l'IHDR d'un PNG", () => {
    expect(readImageDimensions(buildPng(800, 600))).toEqual({ width: 800, height: 600 });
  });

  it("lit largeur/hauteur depuis le marqueur SOF0 d'un JPEG", () => {
    expect(readImageDimensions(buildJpeg(1024, 768))).toEqual({ width: 1024, height: 768 });
  });

  it("renvoie {} pour des octets tronqués ou un format inconnu, sans jamais lever", () => {
    expect(readImageDimensions(new Uint8Array([0x89, 0x50, 0x4e]))).toEqual({});
    expect(readImageDimensions(new Uint8Array([1, 2, 3, 4]))).toEqual({});
    expect(readImageDimensions(new Uint8Array(0))).toEqual({});
  });
});
