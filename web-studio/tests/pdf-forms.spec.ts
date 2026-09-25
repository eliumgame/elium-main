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

/** Ctrl+S (a download, see `noFilePickers`) → the bytes written. */
async function saveWithCtrlS(page: Page): Promise<Uint8Array> {
  const download = page.waitForEvent("download");
  await page.keyboard.press("Control+s");
  const file = await download;
  const chunks = await (await file.createReadStream()).toArray();
  return new Uint8Array(Buffer.concat(chunks));
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

    const doc = await PDFDocument.load(await saveWithCtrlS(page));
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

test.describe("PDF — formulaires : saisie pendant le chargement des scripts", () => {
  test("ce qui est tapé avant que le moteur de scripts soit prêt n'est pas perdu", async ({ page }) => {
    const problems = trackHealth(page);
    await noFilePickers(page);
    // The script engine (QuickJS) arrives 3 s late: typing starts before it runs.
    let release!: () => void;
    const late = new Promise<void>((ok) => (release = ok));
    await page.route("**/quickjs-eval.wasm", async (route) => {
      await late;
      await route.continue();
    });
    await openPdf(page, "commande.pdf", await orderFormPdf());
    await field(page, "qte").fill("4");
    await field(page, "prix").click();
    // At a (fast) human pace: instant keys outrun even the loaded engine.
    await page.keyboard.type("2.5", { delay: 30 });
    await expect(field(page, "qte")).toHaveValue("4");
    await expect(field(page, "prix")).toHaveValue("2.5");
    await field(page, "nom").click();
    release();
    // Once the engine is up, the commits it waited for run: calculate, format.
    await expect(field(page, "total")).toHaveValue("10,00 €", { timeout: 15_000 });
    await expect(field(page, "prix")).toHaveValue("2.50");
    expect(problems).toEqual([]);
  });
});

test.describe("PDF — formulaires : validation", () => {
  test("une valeur refusée par le script de validation est signalée et annulée", async ({ page }) => {
    const problems = trackHealth(page);
    const dialogs: string[] = [];
    page.on("dialog", (d) => {
      dialogs.push(d.message());
      void d.accept();
    });
    await noFilePickers(page);
    await openPdf(page, "commande.pdf", await orderFormPdf());
    await field(page, "qte").fill("4");
    await field(page, "nom").click();
    await expect(field(page, "qte")).toHaveValue("4");
    await field(page, "qte").fill("150");
    await field(page, "nom").click();
    await expect.poll(() => dialogs.length).toBeGreaterThan(0);
    await expect(field(page, "qte")).toHaveValue("4");
    // The refused value never reaches the file either.
    await field(page, "nom").click();
    const doc = await PDFDocument.load(await saveWithCtrlS(page));
    expect(doc.getForm().getTextField("qte").getText()).toBe("4");
    expect(problems).toEqual([]);
  });
});

test.describe("PDF — formulaires : échange de données", () => {
  test("export FDF → réinitialisation → import : toutes les valeurs reviennent", async ({ page }) => {
    const problems = trackHealth(page);
    await openPdf(page, "commande.pdf", await orderFormPdf());
    await field(page, "nom").fill("Łukasz Wałęsa");
    await field(page, "qte").fill("3");
    await field(page, "prix").click();
    await field(page, "prix").fill("2");
    await field(page, "nom").click();
    await field(page, "pays").selectOption({ label: "Suisse" });
    await expect(field(page, "total")).toHaveValue("6,00 €");

    await page.getByRole("tab", { name: "Formulaires" }).click();
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "FDF", exact: true }).click();
    const file = await download;
    expect(file.suggestedFilename()).toBe("commande.fdf");
    const fdf = Buffer.concat(await (await file.createReadStream()).toArray());
    expect(fdf.subarray(0, 8).toString("latin1")).toBe("%FDF-1.2");

    await page.getByRole("button", { name: "Réinitialiser" }).click();
    // (The list was set: its reset once left the page's whole form layer empty.)
    await expect(field(page, "nom")).toHaveValue("");
    await expect(field(page, "pays")).toHaveValue(" ");

    await page.setInputFiles('input[type="file"][accept*="fdf"]', {
      name: "commande.fdf",
      mimeType: "application/vnd.fdf",
      buffer: fdf,
    });
    await expect(field(page, "nom")).toHaveValue("Łukasz Wałęsa");
    await expect(field(page, "qte")).toHaveValue("3");
    await expect(field(page, "pays")).toHaveValue("CH");
    await expect(field(page, "total")).toHaveValue("6,00 €");
    expect(problems).toEqual([]);
  });
});

test.describe("PDF — préparer un formulaire", () => {
  test("tracer, configurer, déplacer, supprimer, puis remplir et enregistrer", async ({ page }) => {
    const problems = trackHealth(page);
    await noFilePickers(page);
    await openPdf(page, "commande.pdf", await orderFormPdf());
    await page.getByRole("tab", { name: "Formulaires" }).click();

    // Draw a text field with the tool.
    await page.getByRole("button", { name: "Texte", exact: true }).first().click();
    const layer = page.locator(".pdfx-prep").first();
    await expect(layer).toBeVisible();
    const box = (await layer.boundingBox())!;
    // Top right of the page: free, and on screen at any zoom.
    await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.02);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.9, box.y + box.height * 0.06, { steps: 5 });
    await page.mouse.up();
    const created = page.locator('.pdfx-prep-box[data-key^="c:"]');
    await expect(created).toHaveCount(1);
    await expect(created).toContainText("Texte1");

    // Its properties: a name and a number format.
    await created.dblclick();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Nom").fill("montant");
    await dialog.getByRole("tab", { name: "Format" }).click();
    await dialog.getByLabel("Catégorie").selectOption("number");
    await dialog.getByRole("button", { name: "Appliquer" }).click();
    await expect(created).toContainText("montant");

    // Move the file's « nom » 40 px right, delete « pays » with the keyboard.
    const nom = page.locator(".pdfx-prep-box", { hasText: /^nom$/ });
    const nb = (await nom.boundingBox())!;
    await page.mouse.move(nb.x + nb.width / 2, nb.y + nb.height / 2);
    await page.mouse.down();
    await page.mouse.move(nb.x + nb.width / 2 + 40, nb.y + nb.height / 2, { steps: 5 });
    await page.mouse.up();
    await page.locator(".pdfx-prep-box", { hasText: /^pays$/ }).click();
    await page.keyboard.press("Delete");
    await expect(page.locator(".pdfx-prep-box", { hasText: /^pays$/ })).toHaveCount(0);

    // Back to filling: the prepared fields are real fields of the document now.
    await page.keyboard.press("Escape");
    await expect(field(page, "montant")).toBeVisible();
    await expect(page.locator('.annotationLayer [name="pays"]')).toHaveCount(0);
    // The format writes « 1.234,56 »: the decimal comma is typed as such.
    const alerts: string[] = [];
    page.on("dialog", (d) => {
      alerts.push(d.message());
      void d.dismiss();
    });
    await field(page, "montant").fill("1234,5");
    await field(page, "nom").click();
    await expect(field(page, "montant")).toHaveValue("1.234,50");
    expect(alerts).toEqual([]);

    const doc = await PDFDocument.load(await saveWithCtrlS(page));
    const form = doc.getForm();
    expect(form.getTextField("montant").getText()).toBe("1234.5");
    expect(form.getFieldMaybe("pays")).toBeUndefined();
    const rect = form.getTextField("nom").acroField.getWidgets()[0].getRectangle();
    // 40 px on screen at the current zoom: moved right, same height.
    expect(rect.x).toBeGreaterThan(125);
    expect(Math.round(rect.y)).toBe(320);
    expect(problems).toEqual([]);
  });
});

test.describe("PDF — formulaires : champs obligatoires", () => {
  test("le bandeau compte les champs obligatoires vides et mène au suivant", async ({ page }) => {
    const problems = trackHealth(page);
    await openPdf(page, "commande.pdf", await orderFormPdf());
    const next = page.getByRole("button", { name: /1 champ\(s\) obligatoire\(s\) à remplir/ });
    await expect(next).toBeVisible();
    await next.click();
    await expect(field(page, "nom")).toBeFocused();
    await field(page, "nom").fill("Dupont");
    await field(page, "qte").click();
    await expect(next).toHaveCount(0);
    expect(problems).toEqual([]);
  });
});

test.describe("PDF — préparer : relecture", () => {
  test("Suppr en mode Préparer ne supprime que le champ, pas l'annotation sélectionnée avant", async ({ page }) => {
    const problems = trackHealth(page);
    await openPdf(page, "commande.pdf", await orderFormPdf());
    // A rectangle, left selected.
    await page.keyboard.press("r");
    const stackBox = (await page.locator(".pdfx-page").first().boundingBox())!;
    await page.mouse.move(stackBox.x + stackBox.width * 0.6, stackBox.y + stackBox.height * 0.02);
    await page.mouse.down();
    await page.mouse.move(stackBox.x + stackBox.width * 0.8, stackBox.y + stackBox.height * 0.06, { steps: 4 });
    await page.mouse.up();
    await expect(page.getByText("1 annotation")).toBeVisible();
    await page.getByRole("tab", { name: "Formulaires" }).click();
    await page.getByRole("button", { name: "Préparer" }).click();
    // The fill layer gives way to the editing boxes.
    await expect(page.locator(".annotationLayer").first()).toHaveCSS("visibility", "hidden");
    await page.locator(".pdfx-prep-box", { hasText: /^qte$/ }).click();
    await page.keyboard.press("Delete");
    await expect(page.locator(".pdfx-prep-box", { hasText: /^qte$/ })).toHaveCount(0);
    await expect(page.getByText("1 annotation")).toBeVisible();
    // Ctrl+A does not select the comments behind the boxes either.
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Escape");
    await expect(page.getByText("1 annotation")).toBeVisible();
    expect(problems).toEqual([]);
  });

  test("un nom libéré par un renommage reste réservé ; une lettre tapée dans la boîte ne quitte pas le mode", async ({
    page,
  }) => {
    const problems = trackHealth(page);
    await openPdf(page, "commande.pdf", await orderFormPdf());
    await page.getByRole("tab", { name: "Formulaires" }).click();
    await page.getByRole("button", { name: "Préparer" }).click();
    await page.locator(".pdfx-prep-box", { hasText: /^nom$/ }).dblclick();
    let dialog = page.getByRole("dialog");
    await dialog.getByLabel("Nom").fill("client");
    await dialog.getByRole("button", { name: "Appliquer" }).click();
    await expect(page.locator(".pdfx-prep-box", { hasText: /^client$/ })).toHaveCount(1);

    await page.getByRole("button", { name: "Texte", exact: true }).first().click();
    const layer = (await page.locator(".pdfx-prep").first().boundingBox())!;
    await page.mouse.click(layer.x + layer.width * 0.6, layer.y + layer.height * 0.03);
    await page.locator('.pdfx-prep-box[data-key^="c:"]').dblclick();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel("Nom").fill("nom");
    await expect(dialog.getByText("Ce nom est déjà utilisé.")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Appliquer" })).toBeDisabled();
    // A tool letter while the dialog has focus changes nothing behind it.
    await dialog.getByRole("tab", { name: "Aspect" }).click();
    await page.keyboard.press("r");
    await expect(page.locator(".pdfx-prep").first()).toBeVisible();
    await dialog.getByRole("button", { name: "Annuler" }).click();
    expect(problems).toEqual([]);
  });
});
