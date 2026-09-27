import { test, expect, type Page } from "@playwright/test";
import { PDFDocument, degrees } from "pdf-lib";

/**
 * OCR in a real browser (projects « drive » and « desktop »): Tesseract's worker,
 * core and models come from the app itself — no CDN, which the desktop CSP
 * forbids — and a page turned by /Rotate is recognised upright.
 */

/** A PNG of printed-looking text, drawn by the browser. */
async function textImage(page: Page, lines: string[]): Promise<Buffer> {
  const b64 = await page.evaluate((ls) => {
    const c = document.createElement("canvas");
    c.width = 1650;
    c.height = 700;
    const g = c.getContext("2d")!;
    g.fillStyle = "#fff";
    g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = "#000";
    g.font = "56px serif";
    ls.forEach((l, i) => g.fillText(l, 80, 140 + i * 110));
    return c.toDataURL("image/png").split(",")[1]!;
  }, lines);
  return Buffer.from(b64, "base64");
}

async function scannedPdf(page: Page): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const upright = await doc.embedPng(await textImage(page, ["Facture numero 2048", "Montant total verse"]));
  const turned = await doc.embedPng(await textImage(page, ["Deuxieme feuillet signe", "Paiement recu comptant"]));
  // 72 dpi scans at 3.4× (≈ 245 dpi when rendered at 300).
  const w = upright.width / 3.4;
  const h = upright.height / 3.4;
  doc.addPage([w, h]).drawImage(upright, { x: 0, y: 0, width: w, height: h });
  // Stored sideways, shown upright by /Rotate 90.
  const p2 = doc.addPage([h, w]);
  p2.setRotation(degrees(90));
  p2.drawImage(turned, { x: h, y: 0, width: w, height: h, rotate: degrees(90) });
  return Buffer.from(await doc.save());
}

test.describe("PDF — OCR", () => {
  test("reconnaissance hors ligne, page tournée comprise ; le texte devient cherchable", async ({ page }) => {
    test.setTimeout(120_000);
    const problems: string[] = [];
    const external: string[] = [];
    page.on("pageerror", (e) => problems.push(e.message));
    page.on("request", (r) => {
      const u = new URL(r.url());
      // The app's own web fonts aside, nothing may come from elsewhere.
      const local = ["127.0.0.1", "localhost", "fonts.googleapis.com", "fonts.gstatic.com"].includes(u.hostname);
      if (!local && u.protocol.startsWith("http")) external.push(r.url());
    });
    await page.goto("/");
    const bytes = await scannedPdf(page);
    await page.getByRole("button", { name: /^PDF/ }).click();
    await page.setInputFiles('input[type="file"][accept*="pdf"]', {
      name: "scan.pdf",
      mimeType: "application/pdf",
      buffer: bytes,
    });
    await expect(page.locator(".pdfx-canvas").first()).toBeVisible();

    await page.getByRole("tab", { name: "Convertir" }).click();
    await page.getByRole("button", { name: "OCR", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Lancer" }).click();
    await expect(page.getByText("Reconnaissance terminée")).toBeVisible({ timeout: 90_000 });

    await page.keyboard.press("Control+f");
    const find = page.getByPlaceholder("Rechercher dans le document…");
    const count = page.locator(".pdfx-find__count");
    await find.fill("Facture");
    await expect(count).toHaveText("1/1");
    // The sideways page reads as its text, not as garbage.
    await find.fill("Paiement");
    await expect(count).toHaveText("1/1");
    // Words of a line are separated: a phrase is found as typed.
    await find.fill("Montant total");
    await expect(count).toHaveText("1/1");

    expect(external).toEqual([]);
    expect(problems).toEqual([]);
  });
});
