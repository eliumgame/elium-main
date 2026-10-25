import { test, expect, type Page } from "@playwright/test";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { strToU8, unzipSync, zipSync } from "fflate";
import { deflateSync } from "node:zlib";
import { readFileSync } from "node:fs";

/**
 * Détecteur dans un vrai navigateur : analyse de chaque format, rapport, aperçu, exports, lot,
 * réglages de sensibilité, fichiers illisibles/protégés, absence d'erreur console et de gel.
 */

const SENTENCES = [
  "Il est important de noter que la transformation numérique constitue un enjeu majeur pour les organisations.",
  "En outre, il convient de souligner que cette démarche permet d'améliorer significativement la productivité.",
  "Par ailleurs, la mise en place d'une stratégie claire — fondée sur des indicateurs précis — reste essentielle.",
  "En conclusion, il apparaît clairement que ces leviers offrent des perspectives prometteuses pour l'avenir.",
];
const LONG_TEXT = Array.from({ length: 24 }, (_, i) => SENTENCES[i % 4] + " " + SENTENCES[(i + 1) % 4]);

async function textPdf(pages = 2): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.setTitle("Rapport test");
  doc.setAuthor("Testeur");
  for (let p = 0; p < pages; p++) {
    const page = doc.addPage([595, 842]);
    let y = 800;
    for (const para of LONG_TEXT.slice(0, 8)) {
      for (let i = 0; i < para.length; i += 85) {
        page.drawText(para.slice(i, i + 85), { x: 40, y, size: 10, font });
        y -= 13;
      }
      y -= 10;
    }
  }
  return Buffer.from(await doc.save());
}

function docx(paragraphs: string[]): Buffer {
  const body = paragraphs
    .map((t) => `<w:p><w:r><w:t xml:space="preserve">${t.replace(/&/g, "&amp;")}</w:t></w:r></w:p>`)
    .join("");
  const files = {
    "[Content_Types].xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    ),
    "_rels/.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    ),
    "word/document.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
    ),
    "docProps/core.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/"><dc:creator>Testeur</dc:creator><dcterms:created>2026-01-01T10:00:00Z</dcterms:created><dcterms:modified>2026-01-01T10:05:00Z</dcterms:modified><cp:revision>1</cp:revision></cp:coreProperties>`,
    ),
  };
  return Buffer.from(zipSync(files));
}

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function png(w = 64, h = 48): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w * 3; x++) raw[y * (w * 3 + 1) + 1 + x] = (x * 5 + y * 3) & 255;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
// JPEG 1x1 et WebP 1x1 minimaux
const JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=",
  "base64",
);
const WEBP = Buffer.from("UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==", "base64");
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

async function openDetector(page: Page) {
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push("pageerror: " + e.message));
  page.on("console", (m) => {
    const t = m.text();
    if (m.type() === "error" && !/ERR_CERT|api\/|Failed to load resource/.test(t)) problems.push("console: " + t);
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
  await page
    .getByRole("button", { name: /Détecteur/ })
    .first()
    .click();
  await expect(page.getByRole("heading", { name: "Détecteur", level: 1 })).toBeVisible();
  return problems;
}

async function analyse(page: Page, name: string, mimeType: string, buffer: Buffer) {
  await page.getByLabel("Choisir un ou plusieurs fichiers à analyser").setInputFiles({ name, mimeType, buffer });
}

test.describe("Détecteur", () => {
  test("PDF : analyse, rapport, onglets, aperçu annoté, exports .docx et PDF", async ({ page }) => {
    const problems = await openDetector(page);
    await analyse(page, "rapport.pdf", "application/pdf", await textPdf());
    await expect(page.getByText("rapport.pdf", { exact: true })).toBeVisible();
    await expect(page.getByText(/paragraphe\(s\)/)).toBeVisible();
    await page.getByRole("button", { name: "Analyser le document" }).click();
    await expect(page.locator(".det-score__value")).toBeVisible({ timeout: 60_000 });
    const score = Number((await page.locator(".det-score__value").innerText()).split("/")[0]!.replace(/\D+/g, ""));
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
    await expect(page.locator(".det-score__confidence-note")).not.toBeEmpty();
    for (const name of [/Texte/, /Mise en forme/, /Métadonnées/, /Images/]) {
      await page.getByRole("tab", { name }).click();
      await expect(page.locator(".det-tabpanel")).toBeVisible();
    }
    await page.getByRole("tab", { name: /Texte/ }).click();
    const see = page.getByRole("button", { name: "Voir dans le document" }).first();
    if (await see.count()) {
      await see.click();
      await expect(page.getByLabel("Aperçu du document")).toBeVisible();
    }
    const dl = page.waitForEvent("download");
    await page.getByRole("button", { name: "Exporter en .docx" }).click();
    const file = await dl;
    const zip = unzipSync(new Uint8Array(readFileSync((await file.path())!)));
    expect(Object.keys(zip)).toContain("word/document.xml");
    expect(Buffer.from(zip["word/document.xml"]!).toString("utf8")).toContain("Document analysé");
    await page.evaluate(() => {
      (window as unknown as { print: () => void }).print = () => undefined;
    });
    await page.getByRole("button", { name: "Exporter en PDF" }).click();
    await page.waitForTimeout(1500);
    expect(problems).toEqual([]);
  });

  test("formats : .docx, .png, .jpg, .webp", async ({ page }) => {
    const problems = await openDetector(page);
    const cases: [string, string, Buffer, RegExp][] = [
      ["note.docx", DOCX_MIME, docx(LONG_TEXT), /paragraphe\(s\)/],
      ["image.png", "image/png", png(), /Image seule/],
      ["photo.jpg", "image/jpeg", JPEG, /Image seule/],
      ["vignette.webp", "image/webp", WEBP, /Image seule/],
    ];
    for (const [name, mime, buf, meta] of cases) {
      await analyse(page, name, mime, buf);
      await expect(page.getByText(meta)).toBeVisible({ timeout: 30_000 });
      await page.getByRole("button", { name: "Analyser le document" }).click();
      await expect(page.locator(".det-score__value")).toBeVisible({ timeout: 60_000 });
      await page.getByRole("button", { name: "Nouvelle analyse" }).click();
    }
    expect(problems).toEqual([]);
  });

  test("fichier illisible ou format non pris en charge : message clair, pas de plantage", async ({ page }) => {
    const problems = await openDetector(page);
    await analyse(page, "casse.pdf", "application/pdf", Buffer.from("ceci n'est pas un pdf"));
    await expect(page.locator("[role=alert], .alert").first()).toBeVisible({ timeout: 30_000 });
    await analyse(page, "notes.txt", "text/plain", Buffer.from("bonjour"));
    await page.waitForTimeout(800);
    await expect(page.getByRole("heading", { name: "Détecteur", level: 1 })).toBeVisible();
    expect(problems.filter((p) => !/pdf|PDF|Invalid/.test(p))).toEqual([]);
  });

  test("réglages de sensibilité : désactiver un signal, préréglage, mémorisation après rechargement", async ({
    page,
  }) => {
    await openDetector(page);
    await analyse(page, "rapport.pdf", "application/pdf", await textPdf());
    await page.getByRole("button", { name: "Analyser le document" }).waitFor();
    await page.getByRole("button", { name: /Réglages de sensibilité/ }).click();
    const boxes = page.locator(".det-sensitivity input[type=checkbox]");
    expect(await boxes.count()).toBeGreaterThan(3);
    await boxes.first().uncheck();
    await page.getByRole("button", { name: /Appliquer le préréglage/ }).click();
    const states = await boxes.evaluateAll((els) => els.map((e) => (e as HTMLInputElement).checked));
    expect(states.some((s) => !s)).toBe(true);
    await page.reload();
    await page
      .getByRole("button", { name: /Détecteur/ })
      .first()
      .click();
    await analyse(page, "rapport.pdf", "application/pdf", await textPdf());
    await page.getByRole("button", { name: /Réglages de sensibilité/ }).click();
    const after = await page
      .locator(".det-sensitivity input[type=checkbox]")
      .evaluateAll((els) => els.map((e) => (e as HTMLInputElement).checked));
    expect(after).toEqual(states);
  });

  test("lot : plusieurs fichiers dont un illisible, exports CSV (anti-injection) et JSON", async ({ page }) => {
    const problems = await openDetector(page);
    await page.getByLabel("Choisir un ou plusieurs fichiers à analyser").setInputFiles([
      { name: "=cmd.pdf", mimeType: "application/pdf", buffer: await textPdf() },
      { name: "a.docx", mimeType: DOCX_MIME, buffer: docx(LONG_TEXT) },
      { name: "casse.pdf", mimeType: "application/pdf", buffer: Buffer.from("xx") },
      { name: "img.png", mimeType: "image/png", buffer: png() },
    ]);
    const table = page.locator("table");
    await expect(table).toBeVisible({ timeout: 30_000 });
    await expect(table.locator("tbody tr")).toHaveCount(4, { timeout: 120_000 });
    await expect(page.getByRole("button", { name: /Exporter CSV/ })).toBeEnabled({ timeout: 120_000 });
    const csvDl = page.waitForEvent("download");
    await page.getByRole("button", { name: /Exporter CSV/ }).click();
    const csv = readFileSync((await (await csvDl).path())!, "utf8");
    expect(csv).toContain(";");
    expect(csv).not.toMatch(/(^|;|\n)"?=cmd/);
    const jsonDl = page.waitForEvent("download");
    await page.getByRole("button", { name: /Exporter JSON/ }).click();
    const json = JSON.parse(readFileSync((await (await jsonDl).path())!, "utf8").replace(/^﻿/, ""));
    expect(JSON.stringify(json)).toContain("casse.pdf");
    expect(problems).toEqual([]);
  });

  test("gros PDF (600 pages) : aucune tâche longue > 300 ms pendant l'analyse", async ({ page }) => {
    test.setTimeout(240_000);
    await openDetector(page);
    await analyse(page, "gros.pdf", "application/pdf", await textPdf(600));
    await page.getByRole("button", { name: "Analyser le document" }).waitFor({ timeout: 120_000 });
    await page.evaluate(() => ((window as unknown as { __long: number[] }).__long.length = 0));
    await page.getByRole("button", { name: "Analyser le document" }).click();
    await expect(page.locator(".det-score__value")).toBeVisible({ timeout: 180_000 });
    // Des milliers de constats : une page à la fois dans l'onglet, jamais tout le DOM d'un coup.
    expect(await page.locator(".det-finding").count()).toBeLessThanOrEqual(100);
    const more = page.getByRole("button", { name: /constats de plus/ });
    if (await more.count()) {
      await more.click();
      expect(await page.locator(".det-finding").count()).toBeGreaterThan(100);
    }
    const long = await page.evaluate(() => (window as unknown as { __long: number[] }).__long);
    console.log("tâches longues analyse 600 pages:", JSON.stringify(long));
    expect(Math.max(0, ...long)).toBeLessThan(300);
  });
});
