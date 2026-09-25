import { test, expect, type Page } from "@playwright/test";
import { PDFDocument, PDFName } from "pdf-lib";
import { orderFormPdf } from "./fixtures/pdf-form-fixtures";

/**
 * Formulaires PDF dans un vrai navigateur (projets « drive » et « desktop »,
 * voir playwright.pdf.config.ts) : champs actifs, JavaScript Acrobat
 * (calcul, format, validation) exécuté dans le bac à sable QuickJS de pdf.js
 * sous la CSP du bureau, et fichier enregistré relu octet par octet.
 */

/** Sans sélecteurs de fichiers, « Enregistrer » télécharge : Playwright récupère le fichier. */
async function noFilePickers(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    delete w.showSaveFilePicker;
    delete w.showOpenFilePicker;
  });
}

function trackHealth(page: Page) {
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(`exception : ${e.message}`));
  page.on("console", async (m) => {
    if (m.type() !== "error" && !(m.type() === "warning" && m.text().startsWith("[pdf]"))) return;
    // Fonts from Google (blocked by the sandbox network here) are not our concern.
    if (m.text().includes("ERR_CERT_AUTHORITY_INVALID")) return;
    const details = await Promise.all(
      m
        .args()
        .map((a) => a.evaluate((x) => (x instanceof Error ? `${x.name}: ${x.message}` : String(x))).catch(() => "?")),
    );
    problems.push(`${m.type()} : ${details.join(" ")}`);
  });
  return problems;
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

/** The form-layer control of field `name` (pdf.js renders one per widget, `name` attribute = field name). */
function field(page: Page, name: string) {
  return page.locator(`.annotationLayer [name="${name}"]`).first();
}

test.describe("PDF — formulaires", () => {
  test("les scripts Acrobat calculent et formatent, le fichier enregistré garde les valeurs", async ({ page }) => {
    const problems = trackHealth(page);
    await noFilePickers(page);
    await openPdf(page, "commande.pdf", await orderFormPdf());

    await field(page, "nom").fill("Łukasz Wałęsa");
    await field(page, "qte").fill("4");
    await field(page, "prix").click();
    await field(page, "prix").fill("2.5");
    await field(page, "nom").click(); // commit (blur): validate → calculate → format
    await expect(field(page, "total")).toHaveValue("10,00 €");
    await expect(field(page, "prix")).toHaveValue("2.50");
    await field(page, "pays").selectOption({ label: "Suisse" });

    const download = page.waitForEvent("download");
    await page.keyboard.press("Control+s");
    const file = await download;
    const saved = new Uint8Array(await (await file.createReadStream()).toArray().then((c) => Buffer.concat(c)));

    const doc = await PDFDocument.load(saved);
    const form = doc.getForm();
    expect(form.getTextField("nom").getText()).toBe("Łukasz Wałęsa");
    expect(form.getTextField("qte").getText()).toBe("4");
    expect(form.getTextField("total").getText()).toBe("10");
    expect(form.getDropdown("pays").getSelected()).toEqual(["CH"]);
    // Every value is drawn: nothing left to the next viewer.
    expect(form.acroForm.dict.lookup(PDFName.of("NeedAppearances"))).toBeUndefined();
    expect(problems).toEqual([]);
  });
});
