import { test, expect } from "@playwright/test";

/**
 * The « Modifier le texte » engine, rendered by pdf.js in a real Chromium:
 * every paragraph of the corpus (tests/fixtures/textedit) is edited — a word
 * appended, a word changed — and the page rendered before and after. Nothing
 * outside the paragraph (and the room it may grow into) may change by a single
 * pixel, and the page must still render.
 *
 * The engine modules are loaded from the Vite dev server (the « drive »
 * server, also started for the « desktop » project): the production bundle
 * does not expose them one by one.
 */

const DEV = "http://localhost:3101";
const FIXTURES = ["letter", "slides", "form-xobject", "pdflib", "chromium", "chromium-a4"];

interface Outcome {
  where: string;
  outside: number;
  inside: number;
  skipped: number;
  rendered: boolean;
}

test.describe("PDF — moteur « Modifier le texte » (rendu)", () => {
  for (const name of FIXTURES) {
    test(`${name} : chaque paragraphe modifié, rien d'autre ne bouge`, async ({ page }) => {
      test.setTimeout(180_000);
      const problems: string[] = [];
      page.on("pageerror", (e) => problems.push(e.message));
      await page.goto(`${DEV}/`);
      const outcomes = (await page.evaluate(
        async ({ name }) => {
          const { PdfEngine } = await import(/* @vite-ignore */ `/src/pdf/core/engine.ts`);
          const { readTextBlocks } = await import(/* @vite-ignore */ `/src/pdf/ops/textblocks.ts`);
          const { rewrittenPage } = await import(/* @vite-ignore */ `/src/pdf/ops/editpreview.ts`);
          const { pdfjs } = await import(/* @vite-ignore */ `/src/pdf/core/pdfjs.ts`);
          const bytes = new Uint8Array(await (await fetch(`/tests/fixtures/textedit/${name}.pdf`)).arrayBuffer());
          const engine = await PdfEngine.open(bytes.slice());
          const SCALE = 1.5;

          /** Page 0 of `pdf` rendered unrotated, as RGBA, with its size in px. */
          const render = async (pdf: Uint8Array, index: number) => {
            const task = pdfjs.getDocument({ data: pdf.slice(), isEvalSupported: false });
            const doc = await task.promise;
            const p = await doc.getPage(index + 1);
            const vp = p.getViewport({ scale: SCALE, rotation: 0 });
            const canvas = document.createElement("canvas");
            canvas.width = Math.ceil(vp.width);
            canvas.height = Math.ceil(vp.height);
            const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
            await p.render({ canvasContext: ctx, viewport: vp, canvas }).promise;
            const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
            await task.destroy();
            return { data, w: canvas.width, h: canvas.height };
          };

          type Span = { text: string; style: Record<string, unknown> };
          const out: { where: string; outside: number; inside: number; skipped: number; rendered: boolean }[] = [];
          for (let pi = 0; pi < engine.pageCount; pi++) {
            const blocks = await readTextBlocks(engine, { bytes }, pi);
            const base = await render((await rewrittenPage(bytes, null, pi, [])).bytes, 0);
            // The page's text area (single lines may grow into it).
            const left = Math.min(...blocks.map((b: { rect: { x: number } }) => b.rect.x));
            const right = Math.max(...blocks.map((b: { rect: { x: number; w: number } }) => b.rect.x + b.rect.w));
            for (const b of blocks) {
              if (!/[\p{L}\p{N}]/u.test(b.text)) continue;
              const spans: Span[] = b.spans.map((s: Span) => ({ ...s }));
              const last = spans.length - 1;
              const appended = spans.map((s, i) => (i === last ? { ...s, text: s.text + " AJOUT" } : s));
              const m = /\p{L}{4,}/u.exec(spans[0].text);
              const variants: [string, Span[]][] = [["append", appended]];
              if (m)
                variants.push([
                  `change ${m[0]}`,
                  spans.map((s, i) => (i === 0 ? { ...s, text: s.text.replace(m[0], "REMPLACÉ") } : s)),
                ]);
              for (const [label, sp] of variants) {
                const edit = {
                  id: "e",
                  pageId: "p",
                  blockKey: b.key,
                  original: b.text,
                  text: sp.map((s) => s.text).join(""),
                  rect: b.rect,
                  fontSize: b.fontSize,
                  leading: b.leading,
                  align: b.align,
                  spans: sp,
                  indent: b.indent,
                };
                const r = await rewrittenPage(bytes, null, pi, [edit]);
                let rendered = true;
                let outside = 0;
                let inside = 0;
                try {
                  const img = await render(r.bytes, 0);
                  const single = b.lines.length === 1 || !b.text.includes(" ") || !(b.soft ?? []).some(Boolean);
                  const turned = Math.abs(b.lines[0].angle) > 0.01;
                  // Where the paragraph is and may grow: its box, sideways when it never wrapped,
                  // and two lines down (a longer paragraph reflows downward).
                  const x0 = (turned || single ? Math.min(left, b.rect.x) : b.rect.x) - 4;
                  const x1 = (turned || single ? Math.max(right, b.rect.x + b.rect.w) : b.rect.x + b.rect.w) + 4;
                  const y0 = b.rect.y - (turned ? b.rect.h : 4);
                  const y1 = b.rect.y + b.rect.h + 2.5 * b.leading + (turned ? b.rect.h : 4);
                  for (let y = 0; y < img.h; y++) {
                    const py = y / SCALE;
                    for (let x = 0; x < img.w; x++) {
                      const px = x / SCALE;
                      const k = (y * img.w + x) * 4;
                      const differs =
                        Math.abs(img.data[k] - base.data[k]) > 24 ||
                        Math.abs(img.data[k + 1] - base.data[k + 1]) > 24 ||
                        Math.abs(img.data[k + 2] - base.data[k + 2]) > 24;
                      if (!differs) continue;
                      if (px >= x0 && px <= x1 && py >= y0 && py <= y1) inside++;
                      else outside++;
                    }
                  }
                } catch {
                  rendered = false;
                }
                out.push({ where: `${name} p${pi} ${b.key} ${label}`, outside, inside, skipped: r.skipped, rendered });
              }
            }
          }
          return out;
        },
        { name },
      )) as Outcome[];
      expect(outcomes.length).toBeGreaterThan(2);
      for (const o of outcomes) {
        expect(o.rendered, o.where).toBe(true);
        expect(o.skipped, o.where).toBe(0);
        expect(o.outside, o.where).toBe(0);
        // The edit itself shows.
        expect(o.inside, o.where).toBeGreaterThan(20);
      }
      expect(problems).toEqual([]);
    });
  }
});
