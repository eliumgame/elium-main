import { test, expect, type Page } from "@playwright/test";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { ALL_PERMISSIONS, protectDocument } from "../src/pdf/ops/security";

/** A protected document's restrictions, in a real browser (projects « drive » and « desktop »). */

async function restricted(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([595, 842]).drawText("Contrat confidentiel", { x: 40, y: 780, size: 16, font });
  const bytes = await protectDocument(doc, {
    userPassword: "",
    ownerPassword: "proprio",
    permissions: {
      ...ALL_PERMISSIONS,
      print: false,
      printHighRes: false,
      annotate: false,
      assemble: false,
      modify: false,
    },
  });
  return Buffer.from(bytes);
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
    name: "contrat.pdf",
    mimeType: "application/pdf",
    buffer: bytes,
  });
  await expect(page.locator(".pdfx-canvas").first()).toBeVisible();
}

test.describe("PDF — protection", () => {
  test("les restrictions d'un document s'appliquent ; le mot de passe des autorisations les lève", async ({ page }) => {
    const problems: string[] = [];
    page.on("pageerror", (e) => problems.push(e.message));
    await open(page, await restricted());
    // Organising pages is forbidden: the permissions password is asked for.
    await page.getByRole("tab", { name: "Organiser" }).click();
    await page.getByRole("button", { name: "Organiser", exact: true }).click();
    let dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("interdit l'organisation des pages");
    await dialog.getByRole("button", { name: "Annuler" }).click();
    await expect(page.locator(".pdfx-org__cell")).toHaveCount(0);

    // A wrong password does not unlock; the right one does, for everything.
    await page.getByRole("button", { name: "Organiser", exact: true }).click();
    dialog = page.getByRole("dialog");
    await dialog.locator('input[type="password"]').fill("faux");
    await dialog.getByRole("button", { name: "Déverrouiller" }).click();
    await expect(page.getByText("Mot de passe incorrect")).toBeVisible();
    await page.getByRole("button", { name: "Organiser", exact: true }).click();
    dialog = page.getByRole("dialog");
    await dialog.locator('input[type="password"]').fill("proprio");
    await dialog.getByRole("button", { name: "Déverrouiller" }).click();
    await expect(page.getByText("Restrictions levées")).toBeVisible();
    await expect(page.locator(".pdfx-org__cell")).toHaveCount(1);
    expect(problems).toEqual([]);
  });
});
