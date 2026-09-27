import { test, expect, type Page } from "@playwright/test";
import { PDFDocument, StandardFonts } from "pdf-lib";

/** Page organisation in a real browser (projects « drive » and « desktop »). */

async function pdf(sizes: [number, number][], label: string): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  sizes.forEach(([w, h], i) => doc.addPage([w, h]).drawText(`${label} ${i + 1}`, { x: 30, y: h - 50, size: 14, font }));
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
    name: "doc.pdf",
    mimeType: "application/pdf",
    buffer: bytes,
  });
  await expect(page.locator(".pdfx-canvas").first()).toBeVisible();
}

async function save(page: Page): Promise<PDFDocument> {
  const dl = page.waitForEvent("download");
  await page.keyboard.press("Control+s");
  return PDFDocument.load(Buffer.concat(await (await (await dl).createReadStream()).toArray()));
}

function health(page: Page) {
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !m.text().includes("ERR_CERT_AUTHORITY_INVALID")) problems.push(m.text());
  });
  return problems;
}

test.describe("PDF — organiser", () => {
  test("insérer un PDF avant la page 1", async ({ page }) => {
    const problems = health(page);
    await open(
      page,
      await pdf(
        [
          [595, 842],
          [595, 842],
        ],
        "Page",
      ),
    );
    await page.getByRole("tab", { name: "Organiser" }).click();
    await page.getByRole("button", { name: "Depuis un PDF" }).click();
    await page.setInputFiles('input[type="file"][accept="application/pdf,.pdf"][multiple]', {
      name: "couverture.pdf",
      mimeType: "application/pdf",
      buffer: await pdf([[400, 300]], "Couverture"),
    });
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("couverture.pdf");
    await dialog.getByRole("combobox").first().selectOption("before");
    await dialog.getByRole("spinbutton").fill("1");
    await dialog.getByRole("button", { name: "Insérer" }).click();
    await expect(page.getByText("1 page(s) insérée(s)")).toBeVisible();
    const doc = await save(page);
    expect(doc.getPageCount()).toBe(3);
    expect(doc.getPage(0).getSize()).toEqual({ width: 400, height: 300 });
    expect(problems).toEqual([]);
  });

  test("insérer une image à sa taille, après la page 1", async ({ page }) => {
    const problems = health(page);
    await open(
      page,
      await pdf(
        [
          [595, 842],
          [595, 842],
        ],
        "Page",
      ),
    );
    await page.getByRole("tab", { name: "Organiser" }).click();
    await page.getByRole("button", { name: "Depuis une image" }).click();
    // A 400×200 px PNG (a 1×1 red pixel scaled by the browser is not enough: build one).
    const png = await page.evaluate(async () => {
      const c = document.createElement("canvas");
      c.width = 400;
      c.height = 200;
      const g = c.getContext("2d")!;
      g.fillStyle = "#c00";
      g.fillRect(0, 0, 400, 200);
      const b = await new Promise<Blob>((r) => c.toBlob((x) => r(x!), "image/png"));
      return Array.from(new Uint8Array(await b.arrayBuffer()));
    });
    await page.setInputFiles('input[type="file"][accept*="image"]', {
      name: "photo.png",
      mimeType: "image/png",
      buffer: Buffer.from(png),
    });
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("combobox").first().selectOption("after");
    await dialog.getByRole("spinbutton").fill("1");
    await dialog.getByRole("button", { name: "Insérer" }).click();
    await expect(page.getByText("1 page(s) image ajoutée(s).")).toBeVisible();
    const doc = await save(page);
    expect(doc.getPageCount()).toBe(3);
    expect(doc.getPage(1).getSize()).toEqual({ width: 300, height: 150 });
    expect(problems).toEqual([]);
  });

  test("pivoter les pages paires de 180°, déplacer, redimensionner, remplacer", async ({ page }) => {
    const problems = health(page);
    await open(
      page,
      await pdf(
        [
          [595, 842],
          [595, 842],
          [595, 842],
          [595, 842],
        ],
        "Page",
      ),
    );
    await page.getByRole("tab", { name: "Organiser" }).click();

    await page.getByRole("button", { name: /Faire pivoter/ }).click();
    let dialog = page.getByRole("dialog");
    await dialog.getByRole("combobox").nth(0).selectOption("180");
    await dialog.getByRole("combobox").nth(1).selectOption("even");
    await dialog.getByRole("button", { name: "Faire pivoter" }).click();

    // Page 4 to the start.
    await page.keyboard.press("End").catch(() => {});
    await page.getByRole("button", { name: "Déplacer vers la page…" }).click();
    dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("Déplacer");
    await dialog.getByRole("combobox").selectOption("start");
    await dialog.getByRole("button", { name: "Déplacer" }).click();

    // Resize everything to A5 landscape, content fitted.
    await page.getByRole("button", { name: "Redimensionner" }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByRole("combobox").nth(0).selectOption("A5");
    await dialog.getByRole("combobox").nth(1).selectOption("l");
    await dialog.getByRole("combobox").nth(3).selectOption("all");
    await dialog.getByRole("button", { name: "Redimensionner" }).click();
    await expect(page.getByText(/page\(s\) redimensionnée\(s\)/).first()).toBeVisible();

    // Page 2 replaced by the page of another file.
    await page.getByRole("button", { name: "Remplacer" }).click();
    await page.getByTestId("replace-input").setInputFiles({
      name: "neuf.pdf",
      mimeType: "application/pdf",
      buffer: await pdf([[300, 300]], "Neuf"),
    });
    dialog = page.getByRole("dialog");
    await dialog.getByRole("spinbutton").nth(0).fill("2");
    await dialog.getByRole("spinbutton").nth(1).fill("2");
    await dialog.getByRole("button", { name: "Remplacer" }).click();
    await expect(page.getByText(/remplacée\(s\)/).first()).toBeVisible();

    const doc = await save(page);
    expect(doc.getPageCount()).toBe(4);
    const sizes = doc
      .getPages()
      .map((p) => [Math.round(p.getWidth()), Math.round(p.getHeight()), p.getRotation().angle]);
    // Order after the move: 4 (180°), 1, 2 (180°), 3 — resized to A5 landscape as seen
    // (a page turned 180° is seen the same way round); then page 2 replaced by « Neuf ».
    expect(sizes[0]).toEqual([595, 420, 180]);
    expect(sizes[1]).toEqual([300, 300, 0]);
    expect(sizes[2]).toEqual([595, 420, 180]);
    expect(sizes[3]).toEqual([595, 420, 0]);
    expect(problems).toEqual([]);
  });

  test("recadrer : détecter les marges blanches", async ({ page }) => {
    const problems = health(page);
    // Content only in the middle: a block 200 × 100 at (200, 400).
    const doc0 = await PDFDocument.create();
    const p = doc0.addPage([600, 800]);
    const { rgb } = await import("pdf-lib");
    p.drawRectangle({ x: 200, y: 400, width: 200, height: 100, color: rgb(0, 0, 0) });
    await open(page, Buffer.from(await doc0.save()));
    await page.getByRole("tab", { name: "Organiser" }).click();
    await page.getByRole("button", { name: "Recadrer" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Détecter les marges blanches" }).click();
    await expect(dialog.getByRole("spinbutton").first()).not.toHaveValue("0");
    await dialog.getByRole("button", { name: "Appliquer" }).click();
    const doc = await save(page);
    const box = doc.getPage(0).getCropBox();
    // The block, with a hair of margin.
    expect(Math.abs(box.x - 200)).toBeLessThan(4);
    expect(Math.abs(box.y - 400)).toBeLessThan(4);
    expect(Math.abs(box.width - 200)).toBeLessThan(6);
    expect(Math.abs(box.height - 100)).toBeLessThan(6);
    expect(problems).toEqual([]);
  });

  test("vue Organiser : glisser après la dernière page, lasso, flèches, fichier déposé", async ({ page }) => {
    const problems = health(page);
    await open(
      page,
      await pdf(
        [
          [300, 300],
          [400, 400],
          [500, 500],
          [600, 600],
        ],
        "Page",
      ),
    );
    await page.getByRole("tab", { name: "Organiser" }).click();
    await page.getByRole("button", { name: "Organiser", exact: true }).click();
    const cells = page.locator(".pdfx-org__cell");
    await expect(cells).toHaveCount(4);

    // Page 1 dropped on the right half of page 4: after it (it used to land before).
    const last = await cells.nth(3).boundingBox();
    await cells.nth(0).dragTo(cells.nth(3), { targetPosition: { x: last!.width * 0.85, y: last!.height / 2 } });
    await expect(cells.nth(3).locator(".pdfx-org__num")).toHaveText("4");

    // Rubber band from the grid's corner over the first two pages.
    const grid = page.locator(".pdfx-org__grid");
    const g = (await grid.boundingBox())!;
    const second = (await cells.nth(1).boundingBox())!;
    await page.mouse.move(g.x + 4, g.y + 4);
    await page.mouse.down();
    await page.mouse.move(second.x + 20, second.y + 20, { steps: 5 });
    await page.mouse.up();
    await expect(page.locator(".pdfx-org__count")).toHaveText("2 sélectionnées");

    // Keyboard: Home selects the first page, Alt+→ moves it one place on.
    await page.keyboard.press("Home");
    await expect(page.locator(".pdfx-org__count")).toHaveText("1 sélectionnée");
    await page.keyboard.press("Alt+ArrowRight");

    // A PDF dropped from the desktop on the left half of page 1: inserted before it.
    const dt = await page.evaluateHandle(
      async (b64) => {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const t = new DataTransfer();
        t.items.add(new File([bytes], "ajout.pdf", { type: "application/pdf" }));
        return t;
      },
      (await pdf([[200, 200]], "Ajout")).toString("base64"),
    );
    const first = (await cells.nth(0).boundingBox())!;
    const at = { clientX: first.x + 5, clientY: first.y + first.height / 2 };
    await cells.nth(0).dispatchEvent("dragover", { dataTransfer: dt, ...at });
    await cells.nth(0).dispatchEvent("drop", { dataTransfer: dt, ...at });
    await expect(page.getByText("1 page(s) insérée(s)")).toBeVisible();
    await expect(cells).toHaveCount(5);

    const doc = await save(page);
    // [1,2,3,4] → drag 1 after 4: [2,3,4,1] → Alt+→ on 2: [3,2,4,1] → drop before: [+,3,2,4,1].
    expect(doc.getPages().map((p) => Math.round(p.getWidth()))).toEqual([200, 500, 400, 600, 300]);
    expect(problems).toEqual([]);
  });

  test("combiner des fichiers : ordre, sélection de pages, image, document ouvert", async ({ page }) => {
    const problems = health(page);
    await open(
      page,
      await pdf(
        [
          [300, 300],
          [310, 310],
        ],
        "Ouvert",
      ),
    );
    await page.getByRole("tab", { name: "Organiser" }).click();
    await page.getByRole("button", { name: "Combiner" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("doc.pdf (document ouvert)");
    const pngBytes = await page.evaluate(async () => {
      const c = document.createElement("canvas");
      c.width = 400;
      c.height = 200;
      c.getContext("2d")!.fillRect(0, 0, 400, 200);
      const blob = await new Promise<Blob | null>((res) => c.toBlob(res, "image/png"));
      return Array.from(new Uint8Array(await blob!.arrayBuffer()));
    });
    await page.getByTestId("combine-input").setInputFiles([
      {
        name: "annexe.pdf",
        mimeType: "application/pdf",
        buffer: await pdf(
          [
            [500, 500],
            [510, 510],
            [520, 520],
          ],
          "Annexe",
        ),
      },
      { name: "photo.png", mimeType: "image/png", buffer: Buffer.from(pngBytes) },
    ]);
    await expect(dialog.getByText("3 fichiers · 6 pages")).toBeVisible();
    // The picture first, the annex's pages 3 and 1 only.
    await dialog.getByRole("button", { name: "Monter photo.png" }).click();
    await dialog.getByRole("button", { name: "Monter photo.png" }).click();
    await dialog.getByRole("textbox", { name: "Pages de annexe.pdf" }).fill("3, 1");
    await expect(dialog.getByText("3 fichiers · 5 pages")).toBeVisible();
    await dialog.getByRole("button", { name: "Combiner", exact: true }).click();
    // The open document has no unsaved edit: nothing to confirm.
    await expect(page.getByText("3 fichier(s) combiné(s) : 5 page(s).")).toBeVisible();

    const doc = await save(page);
    expect(doc.getPages().map((p) => Math.round(p.getWidth()))).toEqual([300, 300, 310, 520, 500]);
    expect(problems).toEqual([]);
  });

  test("combiner depuis l'accueil PDF", async ({ page }) => {
    const problems = health(page);
    await page.addInitScript(() => {
      const w = window as unknown as Record<string, unknown>;
      delete w.showSaveFilePicker;
      delete w.showOpenFilePicker;
    });
    await page.goto("/");
    await page.getByRole("button", { name: /^PDF/ }).click();
    await page.getByRole("button", { name: "Combiner des fichiers" }).click();
    await page.getByTestId("combine-input").setInputFiles([
      { name: "a.pdf", mimeType: "application/pdf", buffer: await pdf([[200, 200]], "A") },
      { name: "b.pdf", mimeType: "application/pdf", buffer: await pdf([[250, 250]], "B") },
    ]);
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("2 fichiers · 2 pages")).toBeVisible();
    await dialog.getByRole("button", { name: "Combiner", exact: true }).click();
    await expect(page.locator(".pdfx-canvas").first()).toBeVisible();
    const doc = await save(page);
    expect(doc.getPages().map((p) => Math.round(p.getWidth()))).toEqual([200, 250]);
    expect(problems).toEqual([]);
  });

  test("presse-papiers : Ctrl+V dans la vue Organiser, bouton du ruban", async ({ page, context }) => {
    const problems = health(page);
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await open(
      page,
      await pdf(
        [
          [300, 300],
          [310, 310],
        ],
        "Page",
      ),
    );
    await page.getByRole("tab", { name: "Organiser" }).click();
    await page.getByRole("button", { name: "Organiser", exact: true }).click();
    const cells = page.locator(".pdfx-org__cell");
    await expect(cells).toHaveCount(2);

    // Text pasted after the selected first page: one A4 page.
    await cells.nth(0).click();
    await page.evaluate(() => {
      const data = new DataTransfer();
      data.setData("text/plain", "Collé depuis le presse-papiers");
      document.body.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true }));
    });
    await expect(page.getByText("1 page(s) insérée(s)")).toBeVisible();
    await expect(cells).toHaveCount(3);

    // The ribbon's button reads the clipboard (permission granted): a picture, after page 1.
    await page.getByRole("button", { name: "Terminer" }).click();
    await page.evaluate(async () => {
      const c = document.createElement("canvas");
      c.width = 200;
      c.height = 100;
      c.getContext("2d")!.fillRect(0, 0, 200, 100);
      const blob = await new Promise<Blob | null>((res) => c.toBlob(res, "image/png"));
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob! })]);
    });
    await page.getByRole("button", { name: "Presse-papiers" }).click();
    await expect(page.getByText("1 page(s) image ajoutée(s).")).toBeVisible();

    const doc = await save(page);
    expect(doc.getPages().map((p) => Math.round(p.getWidth()))).toEqual([300, 150, 595, 310]);
    expect(problems).toEqual([]);
  });
});
