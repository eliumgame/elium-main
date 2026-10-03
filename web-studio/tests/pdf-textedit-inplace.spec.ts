import { test, expect, type Page } from "@playwright/test";
import { PDFDocument, StandardFonts, degrees } from "pdf-lib";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

/**
 * « Modifier le texte » as Acrobat does it (projects « drive » and « desktop »): the paragraph is
 * edited on the page itself — no window over it, no text box in another font — its original glyphs
 * are gone while it is typed in, formatting is in the side panel, and what is typed ends up once in
 * the saved file.
 */

async function chromePdf(page: Page): Promise<Buffer> {
  await page.setContent(`<html><body style="font-family:Arial,sans-serif;margin:40px">
    <h1 style="font-size:22px;margin:0 0 6px">Rapport annuel 2025</h1>
    <p style="font-size:12px;line-height:1.4;margin:0 0 12px">Premier paragraphe du rapport, sur plusieurs lignes pour vérifier le reflux du texte modifié dans sa zone et sa largeur d'origine, avec encore quelques mots pour faire trois lignes complètes.</p>
    <p style="font-size:12px;line-height:1.4;margin:0">Second paragraphe, plus court.</p></body></html>`);
  return page.pdf({ format: "A4" });
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
    name: "rapport.pdf",
    mimeType: "application/pdf",
    buffer: bytes,
  });
  await expect(page.locator(".pdfx-canvas").first()).toBeVisible();
}

async function save(page: Page): Promise<Uint8Array> {
  const dl = page.waitForEvent("download");
  await page.keyboard.press("Control+s");
  return new Uint8Array(Buffer.concat(await (await (await dl).createReadStream()).toArray()));
}

async function pageText(bytes: Uint8Array): Promise<string> {
  const doc = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
  const tc = await (await doc.getPage(1)).getTextContent();
  return (tc.items as { str: string }[]).map((i) => i.str).join(" ");
}

function health(page: Page) {
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !m.text().includes("ERR_CERT_AUTHORITY_INVALID")) problems.push(m.text());
  });
  return problems;
}

test.describe("PDF — modifier le texte, sur la page", () => {
  test("le paragraphe s'édite en place : zoom stable, curseur où l'on clique, l'original ne reste pas sous le texte", async ({
    page,
    context,
  }) => {
    const problems = health(page);
    await open(page, await chromePdf(await context.newPage()));
    await page.getByRole("button", { name: "Modifier le texte" }).first().click();
    const hit = page.getByRole("button", { name: /Modifier : Premier paragraphe/ });
    await expect(hit).toBeVisible();
    const slot = page.locator(".pdfx-slot").first();
    await expect(page.getByLabel("Format du texte").first()).toBeVisible(); // space kept from the start
    const before = (await slot.boundingBox())!;
    const box = (await hit.boundingBox())!;

    // Click in the first line: the editor opens right there, the page does not move or change size.
    await page.mouse.click(box.x + 40, box.y + 6);
    const editor = page.locator(".pdfx-editblock__editor");
    await expect(editor).toBeVisible();
    await expect(editor).toHaveAttribute("contenteditable", "true");
    await expect(page.locator("textarea")).toHaveCount(0);
    const after = (await slot.boundingBox())!;
    expect(Math.abs(after.width - before.width)).toBeLessThan(1);
    // The editor's text sits on the original line (same place, within a couple of pixels).
    const ed = (await editor.boundingBox())!;
    expect(Math.abs(ed.x - box.x)).toBeLessThan(6);
    expect(Math.abs(ed.y - box.y)).toBeLessThan(8);
    // The caret is where the click was: typing lands in the first words.
    await page.keyboard.type("XYZ");
    const typed = await editor.innerText();
    expect(typed.indexOf("XYZ")).toBeGreaterThan(0);
    expect(typed.indexOf("XYZ")).toBeLessThan(25);
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Backspace");
    expect(await editor.innerText()).not.toContain("XYZ");

    // Add words at the end, then click on the empty page: the change is kept.
    await page.keyboard.press("Control+End");
    await page.keyboard.type(" Fin ajoutée.");
    await page.mouse.click(box.x + 60, box.y + 420);
    await expect(editor).toHaveCount(0);
    await expect(page.locator("img.pdfx-editpreview__raster")).toHaveCount(1);

    const text = await pageText(await save(page));
    // The paragraph is there once, with its new ending, and the other one is untouched.
    expect(text.match(/Premier paragraphe/g)?.length).toBe(1);
    expect(text).toContain("Fin ajoutée.");
    expect(text).toContain("Second paragraphe, plus court.");
    expect(problems).toEqual([]);
  });

  test("mise en forme dans le panneau : un mot en gras, Échap garde le changement, Ctrl+Z l'annule", async ({
    page,
    context,
  }) => {
    const problems = health(page);
    await open(page, await chromePdf(await context.newPage()));
    await page.getByRole("button", { name: "Modifier le texte" }).first().click();
    await page.getByRole("button", { name: /Modifier : Second paragraphe/ }).click();
    const editor = page.locator(".pdfx-editblock__editor");
    await expect(editor).toBeVisible();
    // Select the word « court » and make it bold with the panel: only that word changes.
    await editor.evaluate((el) => {
      const text = el.firstChild!.firstChild as Text;
      const at = text.data.indexOf("court");
      const r = document.createRange();
      r.setStart(text, at);
      r.setEnd(text, at + 5);
      const sel = getSelection()!;
      sel.removeAllRanges();
      sel.addRange(r);
    });
    await page.getByRole("button", { name: "Gras" }).click();
    await expect(page.getByRole("button", { name: "Gras" })).toHaveAttribute("aria-pressed", "true");
    const bold = await editor.evaluate((el) =>
      Array.from(el.querySelectorAll("span"))
        .filter((s) => (s as HTMLElement).style.fontWeight === "700")
        .map((s) => s.textContent),
    );
    expect(bold).toEqual(["court"]);
    // Ctrl+B on the selection toggles it back; the shortcut works from the keyboard too.
    await page.keyboard.press("Control+b");
    await expect(page.getByRole("button", { name: "Gras" })).toHaveAttribute("aria-pressed", "false");
    await page.keyboard.press("Control+b");

    // Esc keeps the change and leaves the paragraph.
    await page.keyboard.press("Escape");
    await expect(editor).toHaveCount(0);
    await expect(page.locator("img.pdfx-editpreview__raster")).toHaveCount(1);
    await expect(page.locator(".pdfx-status")).toContainText("1 paragraphe(s) modifié(s)");

    // One undo step brings the original back.
    await page
      .locator(".pdfx-canvas")
      .first()
      .click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("Control+z");
    await expect(page.locator("img.pdfx-editpreview__raster")).toHaveCount(0);
    expect(problems).toEqual([]);
  });

  test("un clic sans rien changer n'ajoute ni modification ni étape d'annulation", async ({ page, context }) => {
    const problems = health(page);
    await open(page, await chromePdf(await context.newPage()));
    await page.getByRole("button", { name: "Modifier le texte" }).first().click();
    await page.getByRole("button", { name: /Modifier : Second paragraphe/ }).click();
    await expect(page.locator(".pdfx-editblock__editor")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".pdfx-editblock__editor")).toHaveCount(0);
    await expect(page.locator("img.pdfx-editpreview__raster")).toHaveCount(0);
    await expect(page.locator(".pdfx-status")).not.toContainText("modifié(s)");
    expect(problems).toEqual([]);
  });

  test("page pivotée : le texte s'édite dans le sens de la page, et le fichier le garde", async ({ page }) => {
    const problems = health(page);
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const p = doc.addPage([595, 842]);
    p.setRotation(degrees(90));
    p.drawText("Texte sur une page pivotée", { x: 80, y: 700, size: 16, font });
    await open(page, Buffer.from(await doc.save()));
    await page.getByRole("button", { name: "Modifier le texte" }).first().click();
    await page.getByRole("button", { name: /Modifier : Texte sur une page/ }).click();
    const editor = page.locator(".pdfx-editblock__editor");
    await expect(editor).toBeVisible();
    // The box is turned with the page: the editor reads along the text, not along the screen.
    await expect(page.locator(".pdfx-editblock.is-active")).toHaveCSS("transform", /matrix\(0, 1, -1, 0/);
    await page.keyboard.press("Control+End");
    await page.keyboard.type(" modifié");
    await page.keyboard.press("Escape");
    const text = await pageText(await save(page));
    expect(text).toContain("Texte sur une page pivotée modifié");
    expect(problems).toEqual([]);
  });
});
