/**
 * A PDF of the encrypted Drive, opened in the PDF module (DrivePdfEditor):
 * account and organisation created, PDF uploaded, opened with a double click,
 * annotated, saved as a new encrypted version, reopened with its annotation;
 * then a save over a version saved meanwhile in another tab asks first.
 *
 * Needs the real Drive stack: `npx tsx tests/dev-drive-server.ts` (API on
 * :8787, proxied by Vite under /api). Skipped when it is not running, and in
 * the « desktop » project (dist without the /api proxy).
 */
import { test, expect } from "@playwright/test";
import { PDFDocument, StandardFonts } from "pdf-lib";
test("PDF du Drive : ouvrir, annoter, enregistrer une nouvelle version, conflit entre deux onglets", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "drive", "Drive API proxied by Vite only");
  const health = await page.request.get("/api/health").catch(() => null);
  test.skip(!health || !health.ok(), "Drive server not running (npx tsx tests/dev-drive-server.ts)");
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page.getByText("Drive entreprise chiffré").click();
  await page.getByRole("button", { name: /Créer un compte/ }).click();
  await page.getByPlaceholder("Prénom Nom").fill("Test Pdf");
  await page.getByLabel("E-mail").fill(`t${Date.now()}@ex.fr`);
  await page.getByLabel("Mot de passe", { exact: true }).fill("motdepasse123");
  await page.getByLabel("Confirmer le mot de passe").fill("motdepasse123");
  await page.locator("form.dc-auth__form button.eb--primary").click();
  await page.getByPlaceholder("Ma société").fill("Societe Test");
  await page.getByPlaceholder("ma-societe").fill(`st${Date.now()}`);
  await page.getByRole("button", { name: /Créer l'organisation/ }).click();
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([595, 842]).drawText("Contrat du Drive", { x: 60, y: 760, size: 20, font });
  await page.waitForTimeout(3000);
  await page
    .locator('input[type="file"][multiple]')
    .first()
    .setInputFiles({
      name: "Contrat.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from(await doc.save()),
    });
  await expect(page.getByText("912 o").first()).toBeVisible();
  await page.getByText("Contrat.pdf").first().dblclick();
  await expect(page.locator(".pdfx-canvas").first()).toBeVisible({ timeout: 60_000 });
  await page.getByRole("tab", { name: "Commenter" }).click();
  await page.getByRole("button", { name: "Rectangle" }).click();
  const c = (await page.locator(".pdfx-canvas").first().boundingBox())!;
  await page.mouse.move(c.x + 100, c.y + 100);
  await page.mouse.down();
  await page.mouse.move(c.x + 220, c.y + 180, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+s");
  await expect(page.locator(".pdfx-toast", { hasText: /Enregistr/ }).first()).toBeVisible({ timeout: 30_000 });
  // Close, reopen from the Drive: the rectangle is in the file.
  await page.getByRole("button", { name: "Retour au Drive" }).click();
  await expect(page.locator(".pdfx-canvas")).toHaveCount(0);
  await page.waitForTimeout(1500);
  await page.getByText("Contrat.pdf").first().dblclick();
  await expect(page.locator(".pdfx-status")).toContainText("1 annotation", { timeout: 60_000 });
  expect(errors).toEqual([]);

  // Conflict: a second tab saves first, this one is asked before overwriting.
  const url = page.url();
  const other = await page.context().newPage();
  await other.goto(url);
  await other
    .getByText("Drive entreprise chiffré")
    .click()
    .catch(() => {});
  await other.getByLabel("Mot de passe").fill("motdepasse123");
  await other.getByRole("button", { name: /Déverrouiller/ }).click();
  await other.getByText("Contrat.pdf").first().dblclick();
  await expect(other.locator(".pdfx-canvas").first()).toBeVisible({ timeout: 60_000 });
  await other.getByRole("tab", { name: "Commenter" }).click();
  await other.getByRole("button", { name: "Rectangle" }).click();
  const c2 = (await other.locator(".pdfx-canvas").first().boundingBox())!;
  await other.mouse.move(c2.x + 300, c2.y + 300);
  await other.mouse.down();
  await other.mouse.move(c2.x + 380, c2.y + 360, { steps: 4 });
  await other.mouse.up();
  await other.keyboard.press("Escape");
  await other.keyboard.press("Control+s");
  await expect(other.locator(".pdfx-toast", { hasText: /Enregistr/ }).first()).toBeVisible({ timeout: 30_000 });
  // Back in the first tab (still on the older version): a change, then save.
  await page.bringToFront();
  await page.getByRole("tab", { name: "Commenter" }).click();
  await page.getByRole("button", { name: "Rectangle" }).click();
  const c3 = (await page.locator(".pdfx-canvas").first().boundingBox())!;
  await page.mouse.move(c3.x + 120, c3.y + 400);
  await page.mouse.down();
  await page.mouse.move(c3.x + 200, c3.y + 460, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+s");
  const dlg = page.getByRole("dialog");
  await expect(dlg).toContainText("modifié dans le Drive", { timeout: 20_000 });
  await dlg.getByRole("button", { name: "Enregistrer quand même" }).click();
  await expect(page.locator(".pdfx-toast", { hasText: /Enregistr/ }).first()).toBeVisible({ timeout: 30_000 });
  expect(errors).toEqual([]);
});
