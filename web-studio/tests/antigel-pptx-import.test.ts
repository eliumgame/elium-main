import { describe, it, expect } from "vitest";
import { unzipSync, zipSync } from "fflate";
import { deckToPptx } from "../src/slides/pptx";
import { importPptx, importPptxAsync, PptxImportError, PPTX_MAX_FILE_BYTES } from "../src/slides/pptx-import";
import { MAX_MEDIA_BYTES } from "../src/slides/media";
import type { Deck, Slide } from "../src/slides/model";

const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMCAQCB4+O0AAAAAElFTkSuQmCC";

function deckOf(n: number): Deck {
  const slides: Slide[] = Array.from({ length: n }, (_, i) => ({
    id: `s${i}`,
    title: `Diapo ${i}`,
    body: "",
    bodyHtml: "",
    layout: "blank" as const,
    elements: [
      { id: `i${i}`, type: "image" as const, x: 10, y: 10, w: 40, h: 40, src: PNG },
      { id: `t${i}`, type: "text" as const, x: 5, y: 60, w: 80, h: 10, html: `<p>Texte ${i}</p>`, fontSize: 24 },
    ],
  }));
  return { slides, active: 0, theme: "light", transition: "fade" };
}

describe("import pptx : médias paresseux, dédoublonnés, plafonnés", () => {
  it("conserve les images et le texte d'un deck de 40 diapositives", () => {
    const d = importPptx(deckToPptx(deckOf(40)));
    expect(d.slides).toHaveLength(40);
    const imgs = d.slides.flatMap((s) => s.elements ?? []).filter((e) => e.type === "image");
    expect(imgs).toHaveLength(40);
    expect(imgs.every((e) => e.src?.startsWith("data:image/png;base64,"))).toBe(true);
    expect(d.slides[7].elements?.some((e) => e.type === "text" && e.html?.includes("Texte 7"))).toBe(true);
  });

  it("la version asynchrone donne le même deck et rend la main (timers)", async () => {
    const bytes = deckToPptx(deckOf(25));
    const sync = importPptx(bytes);
    let ticks = 0;
    const t = setInterval(() => ticks++, 0);
    const asyncDeck = await importPptxAsync(bytes);
    clearInterval(t);
    expect(asyncDeck.slides.map((s) => s.title)).toEqual(sync.slides.map((s) => s.title));
    expect(asyncDeck.slides[3].elements?.[0].src).toBe(sync.slides[3].elements?.[0].src);
  });

  it("ignore un média trop gros avec un message, sans bloquer le reste", () => {
    const files = unzipSync(deckToPptx(deckOf(3)));
    const media = Object.keys(files).filter((k) => k.startsWith("ppt/media/"));
    expect(media.length).toBeGreaterThan(0);
    for (const k of media) files[k] = new Uint8Array(MAX_MEDIA_BYTES + 1024); // zéros : se compresse très bien
    const msgs: string[] = [];
    const d = importPptx(zipSync(files), undefined, { onSkipped: (m) => msgs.push(m) });
    expect(d.slides).toHaveLength(3);
    expect(d.slides[0].elements?.some((e) => e.type === "image")).toBe(false);
    expect(d.slides[0].elements?.some((e) => e.type === "text")).toBe(true);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatch(/dépassent 40 Mo/);
  });

  it("refuse un fichier hors plafond ou illisible avec un message clair", () => {
    expect(() => importPptx(new Uint8Array(10))).toThrow(PptxImportError);
    expect(() => importPptx(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow(/PowerPoint/);
    const big = { length: PPTX_MAX_FILE_BYTES + 1 } as unknown as Uint8Array;
    expect(() => importPptx(big)).toThrow(/refusé/);
  });
});
