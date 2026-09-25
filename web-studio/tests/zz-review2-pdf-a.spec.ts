import { test, expect, type Page } from "@playwright/test";
import { orderFormPdf } from "./fixtures/pdf-form-fixtures";

async function noFilePickers(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    delete w.showSaveFilePicker;
    delete w.showOpenFilePicker;
  });
}
async function openPdf(page: Page, name: string, bytes: Uint8Array) {
  await page.goto("/");
  await page.getByRole("button", { name: /^PDF/ }).click();
  await page.setInputFiles('input[type="file"][accept*="pdf"]', {
    name,
    mimeType: "application/pdf",
    buffer: Buffer.from(bytes),
  });
  await expect(page.locator(".pdfx-canvas").first()).toBeVisible();
}

async function drawSquare(page: Page) {
  await page.locator(".pdfx-annot-layer").first().waitFor();
  const layer = page.locator(".pdfx-slot").first();
  const b = (await layer.boundingBox())!;
  await page.keyboard.press("r");
  await page.mouse.move(b.x + b.width * 0.1, b.y + 30);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width * 0.2, b.y + 60, { steps: 5 });
  await page.mouse.up();
}

test("css: annotationLayer hidden while preparing", async ({ page }) => {
  await openPdf(page, "commande.pdf", await orderFormPdf());
  await page.getByRole("tab", { name: "Formulaires" }).click();
  await page.getByRole("button", { name: "Préparer", exact: true }).click();
  await expect(page.locator(".pdfx-prep").first()).toBeVisible();
  const info = await page.evaluate(() => {
    const al = document.querySelector(".pdfx-stack .annotationLayer") as HTMLElement;
    const canvas = document.querySelector(".pdfx-canvas") as HTMLElement;
    return { vis: al ? getComputedStyle(al).visibility : "none", canvasCls: canvas.className };
  });
  console.log("INFO", JSON.stringify(info));
  expect(info.vis).toBe("hidden");
});

test("delete in prepare also deletes selected annotation", async ({ page }) => {
  await openPdf(page, "commande.pdf", await orderFormPdf());
  await drawSquare(page);
  const shapes = page.locator(".pdfx-annot-svg [data-annot-id]");
  await expect(shapes.first()).toBeAttached();
  const before = await page.locator("[data-annot-id]").count();
  console.log("annots before", before);
  // select it with the select tool
  await page.keyboard.press("v");
  const s = (await shapes.first().boundingBox())!;
  await page.mouse.click(s.x + 2, s.y + s.height / 2);
  await page.waitForTimeout(200);
  console.log("selected?", await page.locator(".pdfx-handles").count());
  await page.getByRole("tab", { name: "Formulaires" }).click();
  await page.getByRole("button", { name: "Préparer", exact: true }).click();
  const nom = page.locator(".pdfx-prep-box", { hasText: /^nom$/ });
  await nom.click();
  await page.keyboard.press("Delete");
  await expect(nom).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(1500);
  const after = await page.locator(".pdfx-annot-svg [data-annot-id]").count();
  console.log("annots after", after);
  expect(after).toBeGreaterThan(0);
});
