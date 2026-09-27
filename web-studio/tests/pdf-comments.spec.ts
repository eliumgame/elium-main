import { test, expect, type Page } from "@playwright/test";
import { PDFArray, PDFDict, PDFDocument, PDFName } from "pdf-lib";

/**
 * Commenting in a real browser (projects « drive » and « desktop »): the
 * stamp library (a dynamic stamp placed and saved with Acrobat's /Name) and
 * the « Surface » measure drawn point by point.
 */

async function blankPdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.addPage([595, 842]);
  return Buffer.from(await doc.save());
}

async function open(page: Page, bytes: Buffer) {
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    delete w.showSaveFilePicker;
    delete w.showOpenFilePicker;
  });
  await page.goto("/");
  await page.getByRole("button", { name: /^PDF/ }).click();
  await page.setInputFiles('input[type="file"][accept*="pdf"]', {
    name: "vierge.pdf",
    mimeType: "application/pdf",
    buffer: bytes,
  });
  await expect(page.locator(".pdfx-canvas").first()).toBeVisible();
}

async function save(page: Page): Promise<PDFDocument> {
  const dl = page.waitForEvent("download");
  await page.keyboard.press("Control+s");
  const bytes = Buffer.concat(await (await (await dl).createReadStream()).toArray());
  return PDFDocument.load(bytes);
}

function annotDicts(doc: PDFDocument): PDFDict[] {
  const arr = doc.getPage(0).node.Annots();
  return arr instanceof PDFArray ? arr.asArray().map((r) => doc.context.lookup(r, PDFDict)) : [];
}

function health(page: Page) {
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !m.text().includes("ERR_CERT_AUTHORITY_INVALID")) problems.push(m.text());
  });
  return problems;
}

test.describe("PDF — commentaires", () => {
  test("bibliothèque de tampons : un tampon dynamique", async ({ page }) => {
    const problems = health(page);
    await open(page, await blankPdf());
    await page.getByRole("tab", { name: "Commenter" }).click();
    await page.getByRole("button", { name: "Tampon" }).click();
    const menu = page.getByRole("menu", { name: "Tampons" });
    await expect(menu).toBeVisible();
    await menu.getByRole("menuitem", { name: /Reçu/ }).click();
    await expect(menu).toBeHidden();
    const canvas = (await page.locator(".pdfx-canvas").first().boundingBox())!;
    await page.mouse.click(canvas.x + 120, canvas.y + 150);
    const stamp = page.locator(".pdfx-stamp.has-sub").first();
    await expect(stamp).toContainText("Reçu");
    await expect(stamp).toContainText(/le \d\d\/\d\d\/\d{4}/);
    const doc = await save(page);
    const stamps = annotDicts(doc).filter((d) => d.lookup(PDFName.of("Subtype"), PDFName).decodeText() === "Stamp");
    expect(stamps).toHaveLength(1);
    expect(stamps[0].lookup(PDFName.of("Name"), PDFName).decodeText()).toBe("#DReceived");
    expect(problems).toEqual([]);
  });

  test("mesure de surface dessinée point par point", async ({ page }) => {
    const problems = health(page);
    await open(page, await blankPdf());
    await page.getByRole("tab", { name: "Affichage" }).click();
    await page.getByRole("button", { name: "Surface" }).click();
    const c = (await page.locator(".pdfx-canvas").first().boundingBox())!;
    const pts = [
      [100, 100],
      [300, 100],
      [300, 250],
    ];
    for (const [x, y] of pts) await page.mouse.click(c.x + x, c.y + y);
    await page.mouse.dblclick(c.x + 100, c.y + 250);
    const doc = await save(page);
    const polys = annotDicts(doc).filter((d) => d.lookup(PDFName.of("Subtype"), PDFName).decodeText() === "Polygon");
    expect(polys).toHaveLength(1);
    expect(polys[0].lookup(PDFName.of("IT"), PDFName).decodeText()).toBe("PolygonDimension");
    expect(polys[0].lookup(PDFName.of("Vertices"), PDFArray).size()).toBeGreaterThanOrEqual(8);
    expect(problems).toEqual([]);
  });

  test("exporter puis importer les commentaires en FDF", async ({ page }) => {
    const problems = health(page);
    await open(page, await blankPdf());
    await page.getByRole("tab", { name: "Commenter" }).click();
    await page.getByRole("button", { name: "Tampon" }).click();
    await page
      .getByRole("menu", { name: "Tampons" })
      .getByRole("menuitem", { name: /Confidentiel/ })
      .first()
      .click();
    const c = (await page.locator(".pdfx-canvas").first().boundingBox())!;
    await page.mouse.click(c.x + 150, c.y + 200);
    await expect(page.locator(".pdfx-stamp").first()).toContainText("Confidentiel");
    const dl = page.waitForEvent("download");
    await page.getByRole("button", { name: "Exporter FDF" }).click();
    const fdf = Buffer.concat(await (await (await dl).createReadStream()).toArray());
    expect(fdf.subarray(0, 8).toString("latin1")).toBe("%FDF-1.2");

    // A fresh copy of the document, then « Importer » the FDF.
    await open(page, await blankPdf());
    await expect(page.locator(".pdfx-stamp")).toHaveCount(0);
    await page.setInputFiles('input[type="file"][accept*=".fdf"]', {
      name: "vierge-commentaires.fdf",
      mimeType: "application/vnd.fdf",
      buffer: fdf,
    });
    await expect(page.locator(".pdfx-stamp").first()).toContainText("Confidentiel");
    expect(problems).toEqual([]);
  });

  test("panneau : coche, réponse modifiée puis supprimée", async ({ page }) => {
    const problems = health(page);
    await open(page, await blankPdf());
    await page.getByRole("tab", { name: "Commenter" }).click();
    await page.getByRole("button", { name: "Note autocollante" }).first().click();
    const c = (await page.locator(".pdfx-canvas").first().boundingBox())!;
    await page.mouse.click(c.x + 200, c.y + 200);
    await expect(page.locator(".pdfx-note")).toHaveCount(1);
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("textbox", { name: "Commentaire" }).fill("À vérifier");
    await dialog.getByRole("button", { name: "Valider" }).click();
    await expect(page.locator(".pdfx-note .pdfx-note__icon")).toBeVisible();
    await page.locator('.pdfx-rail__btn[title="Commentaires"]').click();
    const card = page.locator(".pdfx-comment").first();
    await expect(card).toBeVisible();
    await card.getByRole("checkbox").check();
    await card.getByRole("button", { name: "Répondre" }).click();
    await card.locator("textarea").fill("Première réponse");
    await page.keyboard.press("Control+Enter");
    await expect(card.locator(".pdfx-reply")).toContainText("Première réponse");
    await card.locator(".pdfx-reply p").dblclick();
    await card.locator(".pdfx-reply textarea").fill("Réponse corrigée");
    await card.locator(".pdfx-comment__head").click();
    await expect(card.locator(".pdfx-reply")).toContainText("Réponse corrigée");
    const saved = await save(page);
    const dicts = annotDicts(saved);
    const texts = dicts.map((d) => d.lookup(PDFName.of("Contents"))?.toString() ?? "");
    expect(texts.some((t) => t.includes("corrig") || t.startsWith("<FEFF"))).toBe(true);
    expect(dicts.some((d) => d.lookup(PDFName.of("StateModel"))?.toString() === "(Marked)")).toBe(true);
    await card.locator(".pdfx-reply").hover();
    await card.getByRole("button", { name: "Supprimer la réponse" }).click();
    await expect(card.locator(".pdfx-reply")).toHaveCount(0);
    await expect(card.getByRole("checkbox")).toBeChecked();
    expect(problems).toEqual([]);
  });

  test("auteur des commentaires et propriétés mémorisées par outil", async ({ page }) => {
    const problems = health(page);
    await open(page, await blankPdf());
    await page.getByRole("tab", { name: "Commenter" }).click();
    await page.getByRole("button", { name: "Auteur" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("textbox").fill("Marie Curie");
    await dialog.getByRole("button", { name: "Valider" }).click();

    // A colour set with the Rectangle tool in hand stays with that tool.
    await page.getByRole("button", { name: "Rectangle" }).click();
    await page.locator('.pdfx-optionbar [title="#2563eb"]').click();
    await page.getByRole("button", { name: "Nuage" }).click();
    await page.getByRole("button", { name: "Rectangle" }).click();
    await expect(page.locator('.pdfx-optionbar [title="#2563eb"]')).toHaveClass(/is-active/);
    const c = (await page.locator(".pdfx-canvas").first().boundingBox())!;
    await page.mouse.move(c.x + 100, c.y + 100);
    await page.mouse.down();
    await page.mouse.move(c.x + 220, c.y + 180, { steps: 4 });
    await page.mouse.up();

    const doc = await save(page);
    const sq = annotDicts(doc).find((d) => d.lookup(PDFName.of("Subtype"), PDFName).decodeText() === "Square")!;
    expect(sq.lookup(PDFName.of("T"))?.toString()).toContain("Marie Curie");
    expect(sq.lookup(PDFName.of("C"))?.toString()).toBe("[ 0.1451 0.3882 0.9216 ]");

    // Both survive a new document (this browser's preferences).
    await open(page, await blankPdf());
    await page.getByRole("tab", { name: "Commenter" }).click();
    await page.getByRole("button", { name: "Rectangle" }).click();
    await expect(page.locator('.pdfx-optionbar [title="#2563eb"]')).toHaveClass(/is-active/);
    expect(problems).toEqual([]);
  });

  test("modifications de texte : remplacer et insérer", async ({ page, context }) => {
    const problems = health(page);
    const maker = await context.newPage();
    await maker.setContent(
      `<html><body style="font-family:Arial;margin:60px"><p style="font-size:18px">Le rapport annuel est prêt.</p></body></html>`,
    );
    await open(page, await maker.pdf({ format: "A4" }));
    await page.getByRole("tab", { name: "Commenter" }).click();
    const word = page.locator(".textLayer span", { hasText: "rapport" }).first();
    await expect(word).toBeVisible();

    // Replace « annuel »: select it (double-click), then « Remplacer le texte ».
    await page
      .locator(".textLayer")
      .first()
      .evaluate((layer) => {
        const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          const i = n.textContent!.indexOf("annuel");
          if (i < 0) continue;
          const r = document.createRange();
          r.setStart(n, i);
          r.setEnd(n, i + "annuel".length);
          const sel = window.getSelection()!;
          sel.removeAllRanges();
          sel.addRange(r);
          return;
        }
      });
    await page.getByRole("button", { name: "Remplacer le texte sélectionné" }).click();
    let dialog = page.getByRole("dialog");
    await dialog.getByRole("textbox").fill("mensuel");
    await dialog.getByRole("button", { name: "Valider" }).click();

    // Insert after « prêt »: a caret in the text, then « Insérer du texte ».
    await page
      .locator(".textLayer")
      .first()
      .evaluate((layer) => {
        const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          const i = n.textContent!.indexOf("prêt");
          if (i < 0) continue;
          const r = document.createRange();
          r.setStart(n, i + 4);
          r.collapse(true);
          const sel = window.getSelection()!;
          sel.removeAllRanges();
          sel.addRange(r);
          return;
        }
      });
    await page.getByRole("button", { name: "Insérer du texte au curseur (cliquez d'abord dans le texte)" }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByRole("textbox").fill(" à relire");
    await dialog.getByRole("button", { name: "Valider" }).click();

    const doc = await save(page);
    const dicts = annotDicts(doc);
    const sub = (d: PDFDict) => d.lookup(PDFName.of("Subtype"), PDFName).decodeText();
    const carets = dicts.filter((d) => sub(d) === "Caret");
    expect(carets).toHaveLength(2);
    const strike = dicts.find((d) => sub(d) === "StrikeOut")!;
    expect(strike.lookup(PDFName.of("RT"), PDFName).decodeText()).toBe("Group");
    // The replacement Caret sits right after « annuel », on the same line as the struck text.
    const sr = strike
      .lookup(PDFName.of("Rect"), PDFArray)
      .asArray()
      .map((v) => Number(v.toString()));
    const replace = carets.find((d) => (d.lookup(PDFName.of("Contents"))?.toString() ?? "").includes("mensuel"))!;
    const cr = replace
      .lookup(PDFName.of("Rect"), PDFArray)
      .asArray()
      .map((v) => Number(v.toString()));
    const qp = strike
      .lookup(PDFName.of("QuadPoints"), PDFArray)
      .asArray()
      .map((v) => Number(v.toString()));
    expect(Math.abs((cr[0] + cr[2]) / 2 - qp[2])).toBeLessThan(1);
    expect(cr[1]).toBeLessThan(qp[5] + 1);
    // The struck text's /Rect is its words (plus a hair), not 8 pt wider on each side.
    expect(qp[0] - sr[0]).toBeLessThan(3);
    expect(problems).toEqual([]);
  });

  test("joindre un fichier", async ({ page }) => {
    const problems = health(page);
    await open(page, await blankPdf());
    await page.getByRole("tab", { name: "Commenter" }).click();
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Joindre un fichier" }).click();
    await (await chooser).setFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("Bonjour Łódź") });
    const c = (await page.locator(".pdfx-canvas").first().boundingBox())!;
    await page.mouse.click(c.x + 250, c.y + 250);
    await expect(page.getByRole("button", { name: "Pièce jointe : notes.txt" })).toBeVisible();
    const doc = await save(page);
    const att = annotDicts(doc).find(
      (d) => d.lookup(PDFName.of("Subtype"), PDFName).decodeText() === "FileAttachment",
    )!;
    const fs = att.lookup(PDFName.of("FS"), PDFDict);
    const ef = fs.lookup(PDFName.of("EF"), PDFDict);
    const { decodePDFRawStream } = await import("pdf-lib");
    const stream = ef.lookup(PDFName.of("F")) as Parameters<typeof decodePDFRawStream>[0];
    expect(Buffer.from(decodePDFRawStream(stream).decode()).toString("utf8")).toBe("Bonjour Łódź");
    expect(problems).toEqual([]);
  });
});
