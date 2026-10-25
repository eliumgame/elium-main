import { test, expect, type Page } from "@playwright/test";
import { PDFDocument, PDFName, PDFString, StandardFonts, PDFRawStream, decodePDFRawStream, PDFArray } from "pdf-lib";
import { readFileSync } from "node:fs";
import { createCrypt, writeEncrypted } from "../src/pdf/ops/security";

/**
 * Module PDF : parcours que les autres spécifications ne couvrent pas — enregistrement d'un gros PDF (Worker
 * pdf-lib, enregistrement incrémental répété), recherche par expression régulière catastrophique, caviardage
 * réellement destructif, ouverture d'un PDF protégé par mot de passe.
 */

async function openPdf(page: Page, name: string, buffer: Buffer) {
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push("pageerror: " + e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !/ERR_CERT|Failed to load resource/.test(m.text()))
      problems.push("console: " + m.text());
  });
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    delete w.showSaveFilePicker;
    delete w.showOpenFilePicker;
    w.__long = [];
    try {
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) (w.__long as number[]).push(Math.round(e.duration));
      }).observe({ entryTypes: ["longtask"] });
    } catch {
      /* API absente */
    }
  });
  await page.goto("/");
  await page.getByRole("button", { name: /^PDF/ }).click();
  await page.setInputFiles('input[type="file"][accept*="pdf"]', { name, mimeType: "application/pdf", buffer });
  return problems;
}

async function bigPdf(pages: number): Promise<Buffer> {
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const p = d.addPage([595, 842]);
    for (let l = 0; l < 30; l++)
      p.drawText(`Page ${i + 1} ligne ${l} lorem ipsum dolor sit amet consectetur`, {
        x: 40,
        y: 800 - l * 18,
        size: 10,
        font: f,
      });
    if (i % 10 === 0) {
      const a = d.context.obj({
        Type: "Annot",
        Subtype: "Text",
        Rect: [60, 60, 80, 80],
        Contents: PDFString.of("note " + i),
        Name: "Comment",
        T: PDFString.of("Auteur"),
      });
      p.node.set(PDFName.of("Annots"), d.context.obj([d.context.register(a)]));
    }
  }
  return Buffer.from(await d.save({ useObjectStreams: false }));
}

function countAnnots(doc: PDFDocument): number {
  let n = 0;
  for (const p of doc.getPages()) {
    const a = p.node.Annots();
    if (a instanceof PDFArray) n += a.size();
  }
  return n;
}

/** Tout le texte lisible d'un PDF : flux décompressés et octets bruts (pour prouver qu'un mot a disparu). */
function allStreamsText(doc: PDFDocument, raw: Buffer): string {
  let out = raw.toString("latin1");
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream) {
      try {
        out += Buffer.from(decodePDFRawStream(obj).decode()).toString("latin1");
      } catch {
        /* flux non décodable */
      }
    }
  }
  // Chaînes hexadécimales et tableaux TJ (« (Te) -20 (xte) ») : on les remet bout à bout pour chercher un mot.
  const hex = [...out.matchAll(/<([0-9A-Fa-f\s]{4,})>/g)].map((m) =>
    Buffer.from(m[1]!.replace(/\s+/g, ""), "hex").toString("latin1"),
  );
  return out.replace(/\)\s*-?[\d.]+\s*\(/g, "") + "\n" + hex.join("\n");
}

async function pressSave(page: Page) {
  const dl = page.waitForEvent("download", { timeout: 90_000 });
  await page.keyboard.press("Control+s");
  const file = await dl;
  return readFileSync((await file.path())!);
}

test.describe("PDF — parcours complémentaires", () => {
  test("gros PDF : enregistrer deux fois (Worker pdf-lib, incrémental), annotations conservées, pas de gel", async ({
    page,
  }) => {
    test.setTimeout(240_000);
    const problems = await openPdf(page, "gros.pdf", await bigPdf(180));
    await expect(page.locator(".pdfx-canvas").first()).toBeVisible({ timeout: 90_000 });
    await page.evaluate(() => ((window as unknown as { __long: number[] }).__long.length = 0));
    // 1re modification : une note sur la page 1
    await page.getByRole("tab", { name: "Commenter" }).click();
    await page.getByRole("button", { name: /Note/ }).first().click();
    const box = (await page.locator(".pdfx-canvas").first().boundingBox())!;
    await page.mouse.click(box.x + 200, box.y + 200);
    await page.getByRole("button", { name: "Valider" }).click();
    await page.waitForTimeout(800);
    const first = await pressSave(page);
    const doc1 = await PDFDocument.load(first);
    expect(doc1.getPageCount()).toBe(180);
    expect(countAnnots(doc1)).toBe(18 + 1);
    // 2e modification, 2e enregistrement : l'état du fichier est gardé par le Worker
    await page.getByRole("tab", { name: "Commenter" }).click();
    await page.getByRole("button", { name: /Note/ }).first().click();
    await page.mouse.click(box.x + 300, box.y + 300);
    await page.getByRole("button", { name: "Valider" }).click();
    await page.waitForTimeout(800);
    const second = await pressSave(page);
    const doc2 = await PDFDocument.load(second);
    expect(doc2.getPageCount()).toBe(180);
    expect(countAnnots(doc2)).toBeGreaterThanOrEqual(18 + 2);
    expect(second.length).toBeGreaterThan(first.length - 1); // append-only : ne rétrécit pas
    expect(second.subarray(0, 1000).equals(first.subarray(0, 1000))).toBe(true); // octets d'origine intacts
    const long = await page.evaluate(() => (window as unknown as { __long: number[] }).__long);
    console.log("tâches longues (2 enregistrements, 180 pages) :", JSON.stringify(long));
    expect(Math.max(0, ...long)).toBeLessThan(400);
    expect(problems).toEqual([]);
  });

  test("recherche par expression régulière catastrophique : message clair, onglet réactif", async ({ page }) => {
    const d = await PDFDocument.create();
    const f = await d.embedFont(StandardFonts.Helvetica);
    d.addPage([595, 842]).drawText("a".repeat(40) + "!", { x: 20, y: 700, size: 8, font: f });
    const problems = await openPdf(page, "regex.pdf", Buffer.from(await d.save()));
    await expect(page.locator(".pdfx-canvas").first()).toBeVisible();
    await page.keyboard.press("Control+f");
    await page.getByRole("button", { name: ".*" }).click();
    await page.getByPlaceholder("Rechercher dans le document…").fill("(a+)+$");
    await expect(page.getByText(/trop complexe/)).toBeVisible({ timeout: 15_000 });
    // l'interface répond encore : une recherche simple fonctionne ensuite
    await page.getByRole("button", { name: ".*" }).click();
    await page.getByPlaceholder("Rechercher dans le document…").fill("aaaa");
    await expect(page.locator(".pdfx-rail__dot, .pdfx-find__count").first()).toBeVisible({ timeout: 10_000 });
    const long = await page.evaluate(() => (window as unknown as { __long: number[] }).__long);
    expect(Math.max(0, ...long)).toBeLessThan(400);
    expect(problems).toEqual([]);
  });

  test("caviardage : la zone noircie est détruite dans le fichier enregistré", async ({ page }) => {
    test.setTimeout(120_000);
    const d = await PDFDocument.create();
    const f = await d.embedFont(StandardFonts.Helvetica);
    const p = d.addPage([595, 842]);
    p.drawText("CONFIDENTIEL-IBAN-FR7612345", { x: 60, y: 700, size: 18, font: f });
    p.drawText("Texte public conserve", { x: 60, y: 650, size: 18, font: f });
    const problems = await openPdf(page, "caviard.pdf", Buffer.from(await d.save()));
    await expect(page.locator(".pdfx-canvas").first()).toBeVisible();
    await page.getByRole("tab", { name: "Protéger" }).click();
    await page.getByRole("button", { name: "Marquer" }).first().click();
    const box = (await page.locator(".pdfx-canvas").first().boundingBox())!;
    const k = box.width / 595;
    const y = box.y + (842 - 700) * k;
    await page.mouse.move(box.x + 50 * k, y - 8 * k);
    await page.mouse.down();
    await page.mouse.move(box.x + 330 * k, y + 22 * k, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(500);
    const dl = page.waitForEvent("download", { timeout: 60_000 });
    await page.keyboard.press("Control+s");
    await page.getByRole("button", { name: "Caviarder et enregistrer" }).click();
    const out = readFileSync((await (await dl).path())!);
    const doc = await PDFDocument.load(out);
    const text = allStreamsText(doc, out);
    expect(text).not.toContain("CONFIDENTIEL");
    expect(text).not.toContain("FR7612345");
    expect(text).toContain("Texte public"); // le reste du texte survit
    expect(problems).toEqual([]);
  });

  test("PDF protégé : mot de passe demandé, mauvais mot de passe refusé, bon mot de passe ouvre", async ({ page }) => {
    const plain = await PDFDocument.create();
    const f = await plain.embedFont(StandardFonts.Helvetica);
    plain.addPage([595, 842]).drawText("Contenu secret", { x: 60, y: 700, size: 18, font: f });
    const crypt = createCrypt({ userPassword: "ouvre-moi", ownerPassword: "proprio" } as never);
    const encrypted = Buffer.from(await writeEncrypted(plain, crypt));
    const problems = await openPdf(page, "protege.pdf", encrypted);
    const pw = page.locator('input[type="password"]').first();
    await expect(pw).toBeVisible({ timeout: 30_000 });
    await pw.fill("mauvais");
    await pw.press("Enter");
    await expect(page.getByText(/incorrect/i).first()).toBeVisible({ timeout: 15_000 });
    await page.locator('input[type="password"]').first().fill("ouvre-moi");
    await page.locator('input[type="password"]').first().press("Enter");
    await expect(page.locator(".pdfx-canvas").first()).toBeVisible({ timeout: 30_000 });
    expect(problems.filter((p) => !/password|mot de passe/i.test(p))).toEqual([]);
  });
});
