import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { PDFDocument, PDFHexString, PDFName, StandardFonts } from "pdf-lib";
import { verifyPdfSignatures } from "../src/pdf/ops/pades";

/**
 * Certificate signing in a real browser (projects « drive » and « desktop »):
 * a digital ID made in the browser, a prepared field signed by clicking it, a
 * second signature appended, the signed file becoming the open document and
 * the signature panel.
 */

async function prepared(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  page.drawText("Contrat de prestation", { x: 40, y: 780, size: 18, font });
  const field = doc.context.register(
    doc.context.obj({
      Type: "Annot",
      Subtype: "Widget",
      FT: "Sig",
      T: PDFHexString.fromText("Client"),
      Rect: [60, 600, 300, 660],
      P: page.ref,
      F: 4,
    }),
  );
  page.node.set(PDFName.of("Annots"), doc.context.obj([field]));
  doc.catalog.set(PDFName.of("AcroForm"), doc.context.obj({ Fields: [field] }));
  return Buffer.from(await doc.save({ useObjectStreams: false }));
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

async function downloaded(page: Page, action: () => Promise<void>): Promise<Uint8Array> {
  const dl = page.waitForEvent("download");
  await action();
  const file = await (await dl).path();
  return new Uint8Array(await readFile(file!));
}

test.describe("PDF — signature avec certificat", () => {
  test("identifiant créé dans le navigateur, champ signé d'un clic, deuxième signature, panneau", async ({ page }) => {
    const problems: string[] = [];
    page.on("pageerror", (e) => problems.push(e.message));
    await open(page, await prepared());

    // The empty field invites a click.
    const target = page.getByRole("button", { name: "Signer le champ Client" });
    await expect(target).toBeVisible();
    await target.click();
    let dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("Champ de signature « Client »");
    await dialog.getByRole("button", { name: /Nouvel identifiant auto-signé/ }).click();
    await dialog.getByRole("textbox", { name: "Nom", exact: true }).fill("Test Signataire");
    await dialog.getByRole("button", { name: "Créer" }).click();
    await expect(dialog.getByRole("radio", { name: /Test Signataire/ })).toBeChecked();
    await dialog.getByRole("combobox", { name: "Motif" }).fill("J'approuve ce document");
    const first = await downloaded(page, () => dialog.getByRole("button", { name: "Signer", exact: true }).click());

    let v = await verifyPdfSignatures(first);
    expect(v.map((x) => [x.fieldName, x.signerName, x.intact])).toEqual([["Client", "Test Signataire", true]]);

    // The signed file is the open document: the panel shows its signature, trusted (own ID).
    const panel = page.locator(".pdfx-sig");
    await expect(panel).toContainText("Rév. 1 : signé par Test Signataire");
    await expect(panel).toContainText("Signé et toutes les signatures sont valides.");
    await expect(target).toHaveCount(0);

    // A second signature, invisible, from the ribbon: the first stays valid.
    await page.getByRole("tab", { name: "Protéger" }).click();
    await page.getByRole("button", { name: "Signer", exact: true }).first().click();
    dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("Signature invisible");
    await expect(dialog.getByRole("radio", { name: /Test Signataire/ })).toBeChecked();
    const second = await downloaded(page, () => dialog.getByRole("button", { name: "Signer", exact: true }).click());
    expect(Buffer.from(second.subarray(0, first.length)).equals(Buffer.from(first))).toBe(true);
    v = await verifyPdfSignatures(second);
    expect(v.map((x) => [x.revision, x.intact, x.modifications])).toEqual([
      [1, true, "allowed"],
      [2, true, "none"],
    ]);
    await expect(panel).toContainText("Rév. 2 : signé par Test Signataire");
    await panel.getByRole("button", { name: /Rév. 1/ }).click();
    await expect(panel).toContainText("Des modifications autorisées ont été apportées depuis");
    expect(problems).toEqual([]);
  });

  test("Remplir et signer : coche, croix, point, date, initiales mémorisées d'un document à l'autre", async ({
    page,
  }) => {
    const problems: string[] = [];
    page.on("pageerror", (e) => problems.push(e.message));
    await open(page, await prepared());
    await page.getByRole("tab", { name: "Formulaires" }).click();
    const marks = page.locator("[data-annot-id]");
    for (const [i, label] of ["Coche", "Croix", "Point", "Date"].entries()) {
      await page.getByRole("button", { name: label, exact: true }).click();
      await expect(marks).toHaveCount(i + 1);
    }
    await expect(page.locator(".pdfx-canvas").first().locator("..")).toContainText(
      new Date().toLocaleDateString("fr-FR"),
    );

    await page.getByRole("button", { name: "Initiales", exact: true }).click();
    let dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("Initiales");
    await dialog.getByRole("button", { name: "Saisir" }).click();
    await dialog.getByRole("textbox").first().fill("TS");
    await dialog.getByRole("button", { name: "Placer sur la page" }).click();
    await expect(marks).toHaveCount(5);

    // Another session: the initials are still offered.
    await page.reload();
    await page.getByRole("button", { name: /^PDF/ }).click();
    await page.setInputFiles('input[type="file"][accept*="pdf"]', {
      name: "autre.pdf",
      mimeType: "application/pdf",
      buffer: await prepared(),
    });
    await expect(page.locator(".pdfx-canvas").first()).toBeVisible();
    await page.getByRole("tab", { name: "Formulaires" }).click();
    await page.getByRole("button", { name: "Initiales", exact: true }).click();
    dialog = page.getByRole("dialog");
    await expect(dialog.getByTitle("Utiliser")).toHaveCount(1);
    await dialog.getByTitle("Utiliser").click();
    await expect(page.locator("[data-annot-id]")).toHaveCount(1);
    expect(problems).toEqual([]);
  });
});
