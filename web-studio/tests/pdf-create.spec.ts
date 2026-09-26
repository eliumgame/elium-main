// Must be the very first import — see pdfjs-node-shim.ts for why.
import "./pdfjs-node-shim";
import { test, expect, type Page, type TestInfo } from "@playwright/test";
import { createRequire } from "node:module";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import { pathToFileURL } from "node:url";
import * as pdfjsLib from "pdfjs-dist";
import { PDFArray, PDFDict, PDFDocument, PDFName } from "pdf-lib";
import { docToDocx } from "../src/format/docx";
import { createEliumFile } from "../src/format/document";
import { writeEliumPackage } from "../src/format/elium-package";
import type { ProseMirrorNode } from "../src/format/types";
import { workbookToXlsx } from "../src/sheet/xlsx-export";
import { deckToPptx } from "../src/slides/pptx";
import type { Deck } from "../src/slides/model";

/**
 * « Créer un PDF depuis un fichier »: Word, HTML, Excel and PowerPoint files
 * laid out and drawn by the browser, with a searchable text layer.
 *
 *  - « drive »: the module is loaded from the dev server (`/src/…`).
 *  - « desktop »: the module is bundled on the fly and served from the SAME
 *    origin as the built app, whose pages carry the desktop CSP — the whole
 *    conversion (frame, adopted style sheet, fonts, SVG pictures) runs under
 *    the policy shipped to users, and no CSP violation may be reported.
 */

pdfjsLib.GlobalWorkerOptions.workerSrc = pathToFileURL(
  createRequire(import.meta.url).resolve("pdfjs-dist/build/pdf.worker.min.mjs"),
).href;

const A4 = { w: 595.28, h: 841.89 };
// An 8×8 red PNG.
const PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGO4o6aGFTEMLQkAF/tKAS/fz4YAAAAASUVORK5CYII=";

let harnessDir: string | null = null;

/** The module bundled as an ES library (desktop project), served under /__create/. */
async function bundleHarness(): Promise<string> {
  if (harnessDir) return harnessDir;
  const { build } = await import("vite");
  const react = (await import("@vitejs/plugin-react")).default;
  const out = await mkdtemp(join(tmpdir(), "elium-create-"));
  await build({
    configFile: false,
    root: process.cwd(),
    logLevel: "error",
    plugins: [react()],
    publicDir: false,
    // As the app's build does (React reads it).
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: {
      outDir: out,
      emptyOutDir: true,
      target: "esnext",
      minify: false,
      lib: { entry: "src/pdf/ops/create-from-file.ts", formats: ["es"], fileName: () => "entry.js" },
    },
  });
  harnessDir = out;
  return out;
}

async function openHarness(page: Page, info: TestInfo): Promise<string[]> {
  const violations: string[] = [];
  page.on("console", (m) => {
    if (/Content Security Policy|Refused to/i.test(m.text())) violations.push(m.text());
  });
  page.on("pageerror", (e) => violations.push(e.message));
  if (info.project.name === "desktop") {
    const dir = await bundleHarness();
    await page.route("**/__create/**", async (route) => {
      const rel = new URL(route.request().url()).pathname.replace(/^\/__create\//, "");
      const file = normalize(join(dir, rel));
      if (!file.startsWith(dir)) return route.fulfill({ status: 404 });
      try {
        await route.fulfill({ body: await readFile(file), contentType: "text/javascript" });
      } catch {
        await route.fulfill({ status: 404 });
      }
    });
  }
  await page.goto("/");
  return violations;
}

async function createPdf(
  page: Page,
  info: TestInfo,
  file: { name: string; bytes: Uint8Array; type?: string },
  opts: Record<string, unknown> = {},
): Promise<Uint8Array> {
  const url = info.project.name === "desktop" ? "/__create/entry.js" : "/src/pdf/ops/create-from-file.ts";
  const b64 = await page.evaluate(
    async ({ url, name, b64, type, opts }) => {
      const m = (await import(/* @vite-ignore */ url)) as typeof import("../src/pdf/ops/create-from-file");
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const r = await m.createPdfFromFile(new File([bytes], name, { type }), opts);
      let bin = "";
      for (let i = 0; i < r.bytes.length; i += 0x8000) bin += String.fromCharCode(...r.bytes.subarray(i, i + 0x8000));
      return btoa(bin);
    },
    { url, name: file.name, b64: Buffer.from(file.bytes).toString("base64"), type: file.type ?? "", opts },
  );
  return new Uint8Array(Buffer.from(b64, "base64"));
}

interface Item {
  str: string;
  transform: number[];
}

async function texts(bytes: Uint8Array): Promise<Item[][]> {
  const task = pdfjsLib.getDocument({ data: bytes.slice() });
  const pdf = await task.promise;
  const out: Item[][] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const tc = await (await pdf.getPage(i)).getTextContent();
    out.push((tc.items as Item[]).filter((it) => "str" in it));
  }
  await task.destroy();
  return out;
}

const joined = (items: Item[]) => items.map((i) => i.str).join(" ");

const t = (s: string, marks?: ProseMirrorNode["marks"]): ProseMirrorNode =>
  marks ? { type: "text", text: s, marks } : { type: "text", text: s };
const p = (...c: ProseMirrorNode[]): ProseMirrorNode => ({ type: "paragraph", content: c });
const cell = (type: string, s: string): ProseMirrorNode => ({ type, content: [p(t(s))] });
const LOREM =
  "Le conseil a examiné les comptes de l'exercice et constaté une progression régulière des recettes, " +
  "une maîtrise des dépenses de fonctionnement et un niveau d'investissement conforme au budget voté.";

async function wordDocx(): Promise<Uint8Array> {
  const content: ProseMirrorNode[] = [
    { type: "heading", attrs: { level: 1 }, content: [t("Introduction")] },
    p(t("Voir le "), t("site officiel", [{ type: "link", attrs: { href: "https://example.org/rapport" } }]), t(".")),
  ];
  for (let i = 1; i <= 36; i++) {
    if (i % 12 === 0) content.push({ type: "heading", attrs: { level: 2 }, content: [t(`Chapitre ${i / 12}`)] });
    content.push(p(t(`Paragraphe ${i}. ${LOREM}`)));
  }
  content.push({
    type: "table",
    content: [
      { type: "tableRow", content: [cell("tableHeader", "Poste"), cell("tableHeader", "Montant")] },
      { type: "tableRow", content: [cell("tableCell", "Fournitures"), cell("tableCell", "1250")] },
    ],
  });
  content.push({ type: "image", attrs: { src: PNG_DATA_URL, alt: "carré rouge", width: "" } });
  content.push({ type: "heading", attrs: { level: 2 }, content: [t("Conclusion")] });
  content.push(p(t("Dernière phrase du rapport.")));
  const file = await createEliumFile({ title: "Rapport annuel", doc: { type: "doc", content } });
  return docToDocx(file);
}

test.describe("PDF — créer depuis un fichier", () => {
  test.describe.configure({ timeout: 120_000 });
  // The built app's service worker would answer the harness requests before page.route.
  test.use({ serviceWorkers: "block" });

  test("un document Word donne des pages A4, un texte cherchable et ses liens", async ({ page }, info) => {
    const problems = await openHarness(page, info);
    const pdf = await createPdf(page, info, { name: "Rapport annuel.docx", bytes: await wordDocx() });
    const doc = await PDFDocument.load(pdf);
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(2);
    for (const pg of doc.getPages()) {
      expect(pg.getWidth()).toBeCloseTo(A4.w, 1);
      expect(pg.getHeight()).toBeCloseTo(A4.h, 1);
    }
    expect(doc.getTitle()).toBe("Rapport annuel");
    const pages = await texts(pdf);
    const first = joined(pages[0]);
    expect(first).toContain("Introduction");
    expect(first).toContain("Paragraphe 1.");
    const all = pages.map(joined).join(" ");
    for (const w of ["Chapitre 2", "Fournitures", "1250", "Conclusion", "Dernière phrase du rapport."])
      expect(all).toContain(w);
    // The export writes the title as the first heading: it starts page 1 at the
    // top margin (25 mm), at the left margin (20 mm).
    const heading = pages[0].find((i) => i.str.includes("Rapport"))!;
    expect(heading.transform[4]).toBeCloseTo(20 * (72 / 25.4), -1);
    expect(heading.transform[5]).toBeGreaterThan(A4.h - 25 * (72 / 25.4) - 60);
    expect(heading.transform[5]).toBeLessThan(A4.h - 25 * (72 / 25.4));
    // No line is cut: every paragraph number is found exactly once, whole.
    for (let i = 1; i <= 36; i++) expect(all.split(`Paragraphe ${i}.`).length - 1).toBe(1);
    // The hyperlink is a Link annotation.
    const uris: string[] = [];
    for (const pg of doc.getPages()) {
      const annots = pg.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
      for (let i = 0; i < (annots?.size() ?? 0); i++) {
        const a = annots!.lookup(i, PDFDict).lookupMaybe(PDFName.of("A"), PDFDict);
        const uri = a?.get(PDFName.of("URI"));
        if (uri) uris.push(uri.toString());
      }
    }
    expect(uris.join(" ")).toContain("example.org/rapport");
    expect(problems).toEqual([]);
  });

  test("une page HTML : scripts inertes, images externes non chargées, texte cherchable", async ({ page }, info) => {
    const problems = await openHarness(page, info);
    const external: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("tracker.invalid")) external.push(r.url());
    });
    const sections = Array.from({ length: 30 }, (_, i) => `<p>Section numéro ${i + 1} : ${LOREM}</p>`).join("");
    const html = `<!doctype html><html lang="fr"><head><title>Page de test</title>
      <style>h1{color:#1d4ed8} .note{border:1px solid #999;padding:6px}</style>
      <script>window.parent.__ran = true;</script></head>
      <body><h1>Bienvenue sur la page</h1>
      <p class="note">Aller à la <a href="#fin">fin du document</a>.</p>
      <img src="https://tracker.invalid/pixel.gif" alt="pixel distant" onerror="window.parent.__ran = true">
      <img src="${PNG_DATA_URL}" alt="" width="40" height="40">
      ${sections}<h2 id="fin">Fin du document</h2><p>Merci de votre lecture.</p></body></html>`;
    const pdf = await createPdf(page, info, {
      name: "page.html",
      bytes: new TextEncoder().encode(html),
      type: "text/html",
    });
    const doc = await PDFDocument.load(pdf);
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(2);
    expect(doc.getPage(0).getWidth()).toBeCloseTo(A4.w, 1);
    expect(doc.getPage(0).getHeight()).toBeCloseTo(A4.h, 1);
    expect(doc.getTitle()).toBe("Page de test");
    const all = (await texts(pdf)).map(joined).join(" ");
    for (const w of ["Bienvenue sur la page", "Section numéro 30", "Fin du document", "Merci de votre lecture."])
      expect(all).toContain(w);
    expect(all).toContain("pixel distant");
    expect(await page.evaluate(() => (window as unknown as { __ran?: boolean }).__ran)).toBeUndefined();
    expect(external).toEqual([]);
    // The in-page link goes to the page where « Fin du document » is.
    const last = doc.getPageCount() - 1;
    const annots = doc.getPage(0).node.lookup(PDFName.of("Annots"), PDFArray);
    const dest = annots.lookup(0, PDFDict).lookup(PDFName.of("Dest"), PDFArray);
    expect(dest.get(0)).toBe(doc.getPage(last).ref);
    expect(problems).toEqual([]);
  });

  test("un classeur Excel et une présentation PowerPoint", async ({ page }, info) => {
    const problems = await openHarness(page, info);
    const xlsx = workbookToXlsx({
      active: 0,
      sheets: [
        {
          name: "Budget",
          rows: 10,
          cols: 4,
          cells: { A1: "Poste", B1: "Montant", A2: "Loyer", B2: "1200", A3: "Total", B3: "=B2*12" },
          styles: { A1: { bold: true }, B1: { bold: true } },
        },
        { name: "Annexe", rows: 5, cols: 2, cells: { A1: "Remarques diverses" } },
      ],
    });
    const sheetPdf = await PDFDocument.load(await createPdf(page, info, { name: "budget.xlsx", bytes: xlsx }));
    expect(sheetPdf.getPageCount()).toBe(2);
    const sheetText = (await texts(await sheetPdf.save())).map(joined);
    expect(sheetText[0]).toContain("Loyer");
    expect(sheetText[0]).toContain("14400");
    expect(sheetText[1]).toContain("Remarques diverses");

    const deck: Deck = {
      active: 0,
      theme: "light",
      slides: [
        {
          id: "s1",
          title: "",
          body: "",
          layout: "blank",
          elements: [
            {
              id: "e1",
              type: "text",
              x: 10,
              y: 10,
              w: 80,
              h: 20,
              html: "<p>Présentation trimestrielle</p>",
              fontSize: 48,
              color: "#0f172a",
            },
            { id: "e2", type: "shape", x: 10, y: 50, w: 30, h: 30, shape: "ellipse", text: "Cercle" },
          ],
        },
        {
          id: "s2",
          title: "",
          body: "",
          layout: "blank",
          elements: [
            { id: "e3", type: "text", x: 10, y: 10, w: 80, h: 20, html: "<p>Deuxième diapositive</p>", fontSize: 40 },
          ],
        },
      ],
    };
    const pptxPdf = await createPdf(page, info, { name: "deck.pptx", bytes: deckToPptx(deck) });
    const slides = await PDFDocument.load(pptxPdf);
    expect(slides.getPageCount()).toBe(2);
    expect(slides.getPage(0).getWidth()).toBeCloseTo(960, 0);
    expect(slides.getPage(0).getHeight()).toBeCloseTo(540, 0);
    const slideText = (await texts(pptxPdf)).map(joined);
    expect(slideText[0]).toContain("Présentation trimestrielle");
    expect(slideText[1]).toContain("Deuxième diapositive");
    expect(problems).toEqual([]);
  });

  test("Markdown, texte brut et document Elium (en-tête, pied de page, numéros)", async ({ page }, info) => {
    const problems = await openHarness(page, info);
    const md = await createPdf(page, info, {
      name: "notes.md",
      bytes: new TextEncoder().encode(
        "# Compte rendu\n\nDécisions **importantes** :\n\n- budget adopté\n- prochaine séance\n",
      ),
    });
    const mdDoc = await PDFDocument.load(md);
    expect(mdDoc.getTitle()).toBe("Compte rendu");
    expect(joined((await texts(md))[0])).toContain("budget adopté");

    const txt = await createPdf(
      page,
      info,
      { name: "lisez-moi.txt", bytes: new TextEncoder().encode("Ligne un\nLigne deux") },
      { orientation: "landscape" },
    );
    const txtDoc = await PDFDocument.load(txt);
    expect(txtDoc.getPage(0).getWidth()).toBeCloseTo(A4.h, 1);
    expect(joined((await texts(txt))[0])).toContain("Ligne deux");

    const file = await createEliumFile({
      title: "Contrat",
      doc: { type: "doc", content: Array.from({ length: 40 }, (_, i) => p(t(`Clause ${i + 1}. ${LOREM}`))) },
    });
    file.document.page = { ...file.document.page, header: "{titre}", footer: "Confidentiel", showPageNumbers: true };
    const elium = await createPdf(page, info, { name: "contrat.elium", bytes: await writeEliumPackage(file) });
    const eliumDoc = await PDFDocument.load(elium);
    const n = eliumDoc.getPageCount();
    expect(n).toBeGreaterThanOrEqual(2);
    const pages = (await texts(elium)).map(joined);
    expect(pages[0]).toContain("Contrat");
    expect(pages[0]).toContain("Confidentiel");
    expect(pages[n - 1]).toContain(`Page ${n} / ${n}`);
    expect(pages.join(" ")).toContain("Clause 40.");
    expect(problems).toEqual([]);
  });

  test("depuis l'écran d'accueil du module PDF", async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as unknown as Record<string, unknown>;
      delete w.showSaveFilePicker;
      delete w.showOpenFilePicker;
    });
    await page.goto("/");
    await page.getByRole("button", { name: /^PDF/ }).click();
    const button = page.getByRole("button", { name: /Créer depuis un fichier/ });
    const chooser = page.waitForEvent("filechooser");
    await button.click();
    await (
      await chooser
    ).setFiles({ name: "Rapport annuel.docx", mimeType: "", buffer: Buffer.from(await wordDocx()) });
    await expect(page.locator(".pdfx-canvas").first()).toBeVisible({ timeout: 60_000 });
  });
});
