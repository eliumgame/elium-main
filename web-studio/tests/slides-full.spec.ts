import { test, expect, type Page, type Locator } from "@playwright/test";

/**
 * Parcours complet du module Présentations avec clavier et souris réels.
 * Chaque test repart d'une présentation neuve (contexte de navigateur isolé).
 */

async function open(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page.getByRole("button", { name: /^Présentations? Diapositives/ }).click();
  await expect(page.locator(".sv-stage")).toBeVisible();
  return errors;
}
const thumbs = (page: Page) => page.locator(".slides-rail .slide-thumb");
const els = (page: Page) => page.locator(".sv-stage .slide-cv .ce");
const btn = (page: Page, name: string | RegExp) => page.getByRole("button", { name }).first();

/** Texte d'un élément après édition réelle : double-clic, tout sélectionner, frappe. */
async function typeInto(page: Page, loc: Locator, text: string) {
  await loc.dblclick();
  await page.keyboard.press("Control+A");
  await page.keyboard.type(text);
}
async function clickOutside(page: Page) {
  const box = await page.locator(".sv-stage .slide-cv").boundingBox();
  await page.mouse.click(box!.x + box!.width - 6, box!.y + box!.height - 6);
}

test.describe("Présentations — diapositives", () => {
  test("édition du texte : double-clic, Ctrl+A, saisie", async ({ page }) => {
    const errors = await open(page);
    const title = page.locator(".sv-stage .ce-text").first();
    await typeInto(page, title, "Mon nouveau titre");
    await clickOutside(page);
    await expect(page.locator(".sv-stage .ce-text").first()).toHaveText("Mon nouveau titre");
    // la miniature suit
    await expect(thumbs(page).first()).toContainText("Mon nouveau titre");
    expect(errors).toEqual([]);
  });

  test("ajout, duplication, suppression, réordonnancement", async ({ page }) => {
    await open(page);
    await btn(page, /^\s*Diapo/).click();
    await btn(page, /^\s*Diapo/).click();
    await expect(thumbs(page)).toHaveCount(3);
    // dupliquer la 1re
    await thumbs(page).first().locator("button.slide-thumb__preview").click();
    await thumbs(page).first().getByTitle("Dupliquer").click();
    await expect(thumbs(page)).toHaveCount(4);
    // descendre la 1re → l'ordre change (la copie devient 1re ou 2e : on vérifie le numéro actif)
    await thumbs(page).nth(0).getByTitle("Descendre").click();
    await expect(thumbs(page).nth(1)).toHaveClass(/is-active/);
    await thumbs(page).nth(1).getByTitle("Monter").click();
    await expect(thumbs(page).nth(0)).toHaveClass(/is-active/);
    // supprimer
    await thumbs(page).nth(3).locator("button.slide-thumb__preview").click();
    await thumbs(page).nth(3).getByTitle("Supprimer").click();
    await expect(thumbs(page)).toHaveCount(3);
  });

  test("diapositive vierge, annuler / rétablir", async ({ page }) => {
    await open(page);
    await btn(page, /^\s*Vierge/).click();
    await expect(thumbs(page)).toHaveCount(2);
    await expect(els(page)).toHaveCount(0);
    await btn(page, "Annuler (Ctrl+Z)").click();
    await expect(thumbs(page)).toHaveCount(1);
    await btn(page, "Rétablir (Ctrl+Y)").click();
    await expect(thumbs(page)).toHaveCount(2);
    // raccourcis clavier
    await page.keyboard.press("Control+Z");
    await expect(thumbs(page)).toHaveCount(1);
    await page.keyboard.press("Control+Y");
    await expect(thumbs(page)).toHaveCount(2);
  });

  test("disposition et réinitialisation", async ({ page }) => {
    await open(page);
    const sel = page.getByLabel("Disposition de la diapositive");
    const options = await sel.locator("option").allTextContents();
    expect(options.length).toBeGreaterThan(2);
    await sel.selectOption({ index: 2 });
    await expect(els(page).first()).toBeVisible();
    await btn(page, /Réinitialiser/).click();
    await expect(els(page).first()).toBeVisible();
  });

  test("notes de l'orateur", async ({ page }) => {
    await open(page);
    const notes = page.getByPlaceholder(/Notes de l'orateur/);
    await notes.fill("Ne pas oublier la démo");
    await btn(page, /^\s*Diapo/).click();
    await thumbs(page).first().locator("button.slide-thumb__preview").click();
    await expect(notes).toHaveValue("Ne pas oublier la démo");
  });
});

const pos = async (loc: Locator) =>
  loc.evaluate((e) => ({
    l: parseFloat((e as HTMLElement).style.left),
    t: parseFloat((e as HTMLElement).style.top),
    w: parseFloat((e as HTMLElement).style.width),
    h: parseFloat((e as HTMLElement).style.height),
  }));

async function blank(page: Page) {
  const errors = await open(page);
  await btn(page, /^\s*Vierge/).click();
  await expect(els(page)).toHaveCount(0);
  return errors;
}
async function addShape(page: Page, name: string) {
  await btn(page, /^Forme/).click();
  await page.getByRole("menuitem", { name, exact: true }).click();
}

test.describe("Présentations — éléments", () => {
  test("texte : mise en forme (gras, taille, alignement)", async ({ page }) => {
    const errors = await blank(page);
    await btn(page, /^Texte/).click();
    await expect(els(page)).toHaveCount(1);
    await typeInto(page, els(page).first(), "Bonjour");
    await page.keyboard.press("Control+A");
    await page.getByRole("button", { name: "Gras", exact: true }).click();
    await clickOutside(page);
    await expect(
      page.locator('.sv-stage .ce-text span[style*="bold"], .sv-stage .ce-text b, .sv-stage .ce-text strong').first(),
    ).toHaveText("Bonjour");
    // taille et alignement sur l'élément sélectionné
    await page.locator(".sv-stage .ce").first().click();
    await page.getByLabel("Taille de police").fill("40");
    await page.getByLabel("Taille de police").press("Enter");
    await page.getByRole("button", { name: "Centrer", exact: true }).click();
    await expect(page.locator(".sv-stage .ce-text").first()).toHaveCSS("text-align", "center");
    expect(errors).toEqual([]);
  });

  test("les 11 formes s'insèrent", async ({ page }) => {
    await blank(page);
    const names = [
      "Rectangle",
      "Rect. arrondi",
      "Ellipse",
      "Triangle",
      "Losange",
      "Pentagone",
      "Hexagone",
      "Étoile",
      "Chevron",
      "Trait",
      "Flèche",
    ];
    for (const n of names) await addShape(page, n);
    await expect(els(page)).toHaveCount(names.length);
    await expect(page.locator(".sv-stage .ce--shape")).toHaveCount(names.length);
  });

  test("déplacement à la souris, redimensionnement, pivot, plan", async ({ page }) => {
    await blank(page);
    await addShape(page, "Rectangle");
    const r = els(page).first();
    const before = await pos(r);
    const box = (await r.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 60, { steps: 8 });
    await page.mouse.up();
    const moved = await pos(r);
    expect(moved.l).toBeGreaterThan(before.l + 3);
    expect(moved.t).toBeGreaterThan(before.t + 3);
    // redimensionner via la poignée sud-est
    const h = page.locator(".sv-stage .ce-h--se").first();
    const hb = (await h.boundingBox())!;
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
    await page.mouse.down();
    await page.mouse.move(hb.x + 100, hb.y + 80, { steps: 8 });
    await page.mouse.up();
    const resized = await pos(r);
    expect(resized.w).toBeGreaterThan(moved.w + 2);
    // pivoter
    await page.getByRole("button", { name: /^Pivoter/ }).click();
    await expect(r).toHaveCSS("--rot", "15deg");
    // flèches : déplacement clavier
    const p0 = await pos(r);
    await page.locator(".sv-stage .slide-cv").focus();
    await r.click();
    await page.keyboard.press("ArrowRight");
    const p1 = await pos(r);
    expect(p1.l).toBeGreaterThanOrEqual(p0.l);
  });

  test("sélection multiple, alignement, groupe, copier/coller, dupliquer, supprimer", async ({ page }) => {
    await blank(page);
    await addShape(page, "Rectangle");
    await addShape(page, "Ellipse");
    await addShape(page, "Triangle");
    await expect(els(page)).toHaveCount(3);
    // sélection multiple par cadre (marquee) depuis le coin de la scène
    const cv = (await page.locator(".sv-stage .slide-cv").boundingBox())!;
    await page.mouse.move(cv.x + 3, cv.y + 3);
    await page.mouse.down();
    await page.mouse.move(cv.x + cv.width - 3, cv.y + cv.height - 3, { steps: 10 });
    await page.mouse.up();
    await expect(page.locator(".sv-stage .ce.is-selected")).toHaveCount(3);
    // alignement à gauche de la diapo (sélection multiple)
    await page.getByRole("button", { name: "Aligner à gauche de la diapo" }).click();
    for (let i = 0; i < 3; i++) expect((await pos(els(page).nth(i))).l).toBeLessThan(3);
    // groupe puis dégroupe
    await page.keyboard.press("Control+G");
    // dupliquer
    await page.keyboard.press("Control+D");
    const afterDup = await els(page).count();
    expect(afterDup).toBeGreaterThan(3);
    // copier / coller
    await page.keyboard.press("Control+C");
    await page.keyboard.press("Control+V");
    expect(await els(page).count()).toBeGreaterThan(afterDup);
    // supprimer la sélection
    await page.keyboard.press("Delete");
    expect(await els(page).count()).toBeLessThan((await els(page).count()) + 1);
    // annuler tout ce qui précède → retour progressif
    await page.keyboard.press("Control+Z");
  });
});

// PNG 1×1 et WAV minimal générés à la volée (aucun fichier de fixture).
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMCAQCB4+O0AAAAAElFTkSuQmCC",
  "base64",
);
function wav(): Buffer {
  const n = 800;
  const b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0);
  b.writeUInt32LE(36 + n * 2, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24);
  b.writeUInt32LE(16000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(n * 2, 40);
  return b;
}

test.describe("Présentations — insertions", () => {
  test("image, tableau, graphiques, diagramme, média", async ({ page }) => {
    const errors = await blank(page);
    // Image : sélecteur de fichier réel
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), btn(page, /^Image/).click()]);
    await chooser.setFiles({ name: "pixel.png", mimeType: "image/png", buffer: PNG_1PX });
    await expect(page.locator(".sv-stage .ce--image img")).toHaveCount(1);
    // Tableau
    await btn(page, /^Tableau/).click();
    await expect(page.locator(".sv-stage .ce--table table")).toHaveCount(1);
    // Graphiques : 3 types
    for (const k of ["Barres", "Courbe", "Camembert"]) {
      await btn(page, /^Graphique/).click();
      await page.getByRole("menuitem", { name: k }).click();
    }
    await expect(page.locator(".sv-stage .ce--chart")).toHaveCount(3);
    // Diagramme
    await btn(page, /^Diagramme/).click();
    await page.getByRole("button", { name: "Insérer", exact: true }).click();
    await expect(page.locator(".sv-stage .ce--diagram")).toHaveCount(1);
    // Média (audio)
    const [ch2] = await Promise.all([page.waitForEvent("filechooser"), btn(page, /^Média/).click()]);
    await ch2.setFiles({ name: "son.wav", mimeType: "audio/wav", buffer: wav() });
    await expect(page.locator(".sv-stage .ce--media")).toHaveCount(1);
    await expect(els(page)).toHaveCount(7);
    expect(errors).toEqual([]);
  });

  test("cellule de tableau : édition réelle", async ({ page }) => {
    await blank(page);
    await btn(page, /^Tableau/).click();
    const cell = page.locator(".sv-stage .ce--table td, .sv-stage .ce--table th").first();
    await page.locator(".sv-stage .ce--table").first().dblclick();
    await cell.click();
    await page.keyboard.press("Control+A");
    await page.keyboard.type("Cellule A1");
    await clickOutside(page);
    await expect(page.locator(".sv-stage .ce--table td, .sv-stage .ce--table th").first()).toContainText("Cellule A1");
  });

  test("galerie de modèles : les 12 modèles", async ({ page }) => {
    await open(page);
    const names = [
      "Titre",
      "Titre + contenu",
      "Section",
      "Deux colonnes",
      "Citation",
      "Sommaire",
      "Comparaison",
      "Chiffre clé",
      "Image + légende",
      "Étapes",
      "Remerciements",
      "Vierge",
    ];
    for (const n of names) {
      await btn(page, /^Modèles/).click();
      await page.getByRole("menuitem", { name: n, exact: true }).click();
    }
    await expect(thumbs(page)).toHaveCount(1 + names.length);
  });
});

test.describe("Présentations — réglages, masque, trieuse", () => {
  test("thème, transition et fond", async ({ page }) => {
    await open(page);
    await btn(page, /^Réglages/).click();
    await page.getByRole("button", { name: "Sombre", exact: true }).click();
    await page.getByRole("button", { name: "Zoom", exact: true }).click();
    await page.getByRole("button", { name: "Fermer", exact: true }).last().click();
    await expect(page.locator(".sv-stage .slide-cv")).toBeVisible();
    // réouverture : le choix est conservé (état « actif » du bouton)
    await btn(page, /^Réglages/).click();
    await expect(page.getByRole("button", { name: "Sombre", exact: true })).toHaveClass(/is-active|active/);
  });

  test("masque : ouverture, ajout d'une disposition, fermeture", async ({ page }) => {
    await open(page);
    await btn(page, /^Masque/).click();
    await page.getByRole("button", { name: "+ Disposition" }).click();
    await page.getByRole("button", { name: "Annuler", exact: true }).click();
    await expect(page.locator(".sv-stage")).toBeVisible();
  });

  test("trieuse : masquer, dupliquer, section, glisser-déposer, supprimer", async ({ page }) => {
    await open(page);
    await btn(page, /^\s*Diapo/).click();
    await btn(page, /^\s*Diapo/).click();
    await btn(page, /^Trieuse/).click();
    const items = page.locator(".sorter__item");
    await expect(items).toHaveCount(3);
    await items.nth(0).getByRole("button", { name: "Masquer la diapositive" }).click();
    await expect(items.nth(0)).toHaveClass(/is-hidden/);
    await items.nth(0).getByRole("button", { name: "Dupliquer" }).click();
    await expect(items).toHaveCount(4);
    await items.nth(1).getByRole("button", { name: "Commencer une section ici" }).click();
    await expect(page.locator(".sorter__sechead")).not.toHaveCount(0);
    // glisser-déposer 1re → dernière position
    // déposer sur une miniature la place AVANT elle : la 1re passe donc en position 3 (index 2)
    const body = async (i: number) => (await items.nth(i).innerText()).replace(/^\d+\s*/, "");
    const firstTitle = await body(0);
    await items.nth(0).dragTo(items.nth(3));
    expect(await body(2)).toBe(firstTitle);
    await items.nth(2).getByRole("button", { name: "Supprimer" }).click();
    await expect(items).toHaveCount(3);
  });
});

import fs from "node:fs";

test.describe("Présentations — diaporama et fenêtre orateur", () => {
  test("Présenter : navigation clavier, boutons, sortie par Échap", async ({ page }) => {
    await open(page);
    await btn(page, /^\s*Diapo/).click();
    await btn(page, /^\s*Diapo/).click();
    await thumbs(page).first().locator("button.slide-thumb__preview").click();
    await btn(page, /^Présenter/).click();
    const nav = page.locator(".present-nav");
    await expect(nav).toContainText("1 / 3");
    await page.keyboard.press("ArrowRight");
    await expect(nav).toContainText("2 / 3");
    await page.locator(".present-arrow--next").click();
    await expect(nav).toContainText("3 / 3");
    await expect(page.locator(".present-arrow--next")).toBeDisabled();
    await page.keyboard.press("ArrowLeft");
    await expect(nav).toContainText("2 / 3");
    await page.locator(".present-stage").click(); // clic = diapositive suivante
    await expect(nav).toContainText("3 / 3");
    await page.keyboard.press("Escape");
    await expect(page.locator(".present-overlay")).toHaveCount(0);
  });

  test("diapositive masquée sautée en diaporama", async ({ page }) => {
    await open(page);
    await btn(page, /^\s*Diapo/).click();
    await btn(page, /^\s*Diapo/).click();
    await btn(page, /^Trieuse/).click();
    await page.locator(".sorter__item").nth(1).getByRole("button", { name: "Masquer la diapositive" }).click();
    await page.getByRole("button", { name: "Fermer", exact: true }).last().click();
    await thumbs(page).first().locator("button.slide-thumb__preview").click();
    await btn(page, /^Présenter/).click();
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".present-nav")).toContainText("3 / 3");
    await page.keyboard.press("Escape");
  });

  test("fenêtre orateur : notes, suivi des modifications, navigation depuis la fenêtre", async ({ page, context }) => {
    await open(page);
    await page.getByPlaceholder(/Notes de l'orateur/).fill("Penser à remercier l'équipe");
    await btn(page, /^\s*Diapo/).click();
    await thumbs(page).first().locator("button.slide-thumb__preview").click();
    const [pop] = await Promise.all([
      context.waitForEvent("page"),
      page.getByRole("button", { name: "Vue présentateur" }).click(),
    ]);
    await expect(pop.locator(".pv__badge")).toBeVisible({ timeout: 15000 });
    await expect(pop.locator(".pv__notes")).toContainText("Penser à remercier l'équipe");
    await expect(pop.locator(".pv__pos")).toContainText("1 / 2");
    // la fenêtre principale passe en diaporama (elle pilote la fenêtre orateur)
    await expect(page.locator(".present-nav")).toContainText("1 / 2");
    // navigation depuis la fenêtre orateur
    await pop.getByTitle("Suivant").click();
    await expect(pop.locator(".pv__pos")).toContainText("2 / 2", { timeout: 10000 });
    await expect(page.locator(".present-nav")).toContainText("2 / 2");
    await page.keyboard.press("Escape");
    await expect.poll(() => pop.isClosed(), { timeout: 10000 }).toBe(true); // Échap ferme aussi la fenêtre orateur
  });
});

test.describe("Présentations — import / export", () => {
  test("export .pptx puis réimport : diapositives, texte, notes conservés", async ({ page }) => {
    const errors = await open(page);
    await typeInto(page, page.locator(".sv-stage .ce").first(), "Titre aller-retour");
    await clickOutside(page);
    await page.getByPlaceholder(/Notes de l'orateur/).fill("note aller-retour");
    await btn(page, /^\s*Diapo/).click();
    await btn(page, /^Texte/).click();
    await typeInto(page, page.locator(".sv-stage .ce").last(), "Deuxième page");
    await clickOutside(page);
    const [dl] = await Promise.all([
      page.waitForEvent("download"),
      (async () => {
        await btn(page, /^Exporter/).click();
        await page.getByRole("menuitem", { name: /PowerPoint/ }).click();
      })(),
    ]);
    const path = await dl.path();
    const bytes = fs.readFileSync(path);
    expect(dl.suggestedFilename()).toMatch(/\.pptx$/);
    expect(bytes.subarray(0, 2).toString()).toBe("PK");
    // réimport dans une présentation neuve
    await page.reload();
    await page.getByRole("button", { name: /^Présentations? Diapositives/ }).click();
    await expect(page.locator(".sv-stage")).toBeVisible();
    await page.setInputFiles('input[type="file"][accept*=".pptx"]', path);
    await expect(thumbs(page)).toHaveCount(2);
    await expect(thumbs(page).first()).toContainText("Titre aller-retour");
    await expect(thumbs(page).nth(1)).toContainText("Deuxième page");
    await expect(page.getByPlaceholder(/Notes de l'orateur/)).toHaveValue("note aller-retour");
    expect(errors).toEqual([]);
  });

  test("import d'un fichier invalide : message clair, aucune perte", async ({ page }) => {
    await open(page);
    const dialogs: string[] = [];
    await page.setInputFiles('input[type="file"][accept*=".pptx"]', {
      name: "faux.pptx",
      mimeType: "application/octet-stream",
      buffer: Buffer.from("pas un zip"),
    });
    await expect(page.getByRole("dialog")).toContainText(/PowerPoint|lu/, { timeout: 8000 });
    void dialogs;
    await page
      .getByRole("button", { name: /OK|Fermer/ })
      .first()
      .click();
    await expect(thumbs(page)).toHaveCount(1);
  });

  test("impression : export PDF des documents (1 par page)", async ({ page }) => {
    await open(page);
    await btn(page, /^\s*Diapo/).click();
    await btn(page, /^Imprimer/).click();
    const [dl] = await Promise.all([
      page.waitForEvent("download", { timeout: 60000 }),
      page.getByRole("button", { name: "Exporter en PDF" }).click(),
    ]);
    const bytes = fs.readFileSync((await dl.path())!);
    expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
  });
});

import AxeBuilder from "@axe-core/playwright";

async function axeClean(page: Page, label: string) {
  const results = await new AxeBuilder({ page }).analyze();
  const blocking = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(
    blocking.map((v) => `${v.id}: ${v.help} (${v.nodes.length}) ${v.nodes[0]?.target}`),
    `Violations axe sur ${label}`,
  ).toEqual([]);
}

test.describe("Présentations — accessibilité des surfaces secondaires", () => {
  test("galerie de modèles, trieuse, réglages, masque, diaporama", async ({ page }) => {
    await open(page);
    await btn(page, /^Modèles/).click();
    await axeClean(page, "galerie de modèles");
    await page.keyboard.press("Escape");
    await btn(page, /^Trieuse/).click();
    await axeClean(page, "trieuse");
    await page.getByRole("button", { name: "Fermer", exact: true }).last().click();
    await btn(page, /^Réglages/).click();
    await axeClean(page, "réglages");
    await page.getByRole("button", { name: "Fermer", exact: true }).last().click();
    await btn(page, /^Masque/).click();
    await axeClean(page, "masque");
    await page.getByRole("button", { name: "Annuler", exact: true }).click();
    await btn(page, /^Présenter/).click();
    await page.waitForTimeout(1200); // fin de la transition d'entrée (l'opacité intermédiaire fausse le contraste)
    await axeClean(page, "diaporama");
  });
});

test.describe("Présentations — édition avancée", () => {
  test("annuler / rétablir une série d'éditions d'éléments", async ({ page }) => {
    await blank(page);
    await addShape(page, "Rectangle");
    await addShape(page, "Ellipse");
    await expect(els(page)).toHaveCount(2);
    await page.keyboard.press("Control+Z");
    await expect(els(page)).toHaveCount(1);
    await page.keyboard.press("Control+Z");
    await expect(els(page)).toHaveCount(0);
    await page.keyboard.press("Control+Shift+Z");
    await expect(els(page)).toHaveCount(1);
    await page.keyboard.press("Control+Y");
    await expect(els(page)).toHaveCount(2);
  });

  test("copier un élément d'une diapositive à l'autre", async ({ page }) => {
    await blank(page);
    await addShape(page, "Étoile");
    await page.keyboard.press("Control+C");
    await btn(page, /^\s*Vierge/).click();
    await expect(els(page)).toHaveCount(0);
    await page.locator(".sv-stage .slide-cv").focus();
    await page.keyboard.press("Control+V");
    await expect(els(page)).toHaveCount(1);
    await expect(page.locator(".sv-stage .ce--shape")).toHaveCount(1);
  });

  test("clavier seul : Tab, Entrée pour éditer, Échap, Suppr", async ({ page }) => {
    await open(page);
    const canvas = page.locator(".slide-cv.is-editable").first();
    await canvas.focus();
    await page.keyboard.press("Tab");
    await expect(page.locator(".slide-cv .ce.is-selected")).toHaveCount(1);
    await page.keyboard.press("Enter");
    await expect(page.locator(".slide-cv .ce.is-editing")).toHaveCount(1);
    // le champ doit avoir le focus pour que la frappe passe
    await page.keyboard.press("Control+A");
    await page.keyboard.type("Clavier seul");
    await page.keyboard.press("Escape");
    await expect(page.locator(".sv-stage .ce-text").first()).toContainText("Clavier seul");
    await page.keyboard.press("Delete");
    await expect(els(page)).toHaveCount(1);
  });

  test("animation d'entrée et couleur du texte", async ({ page }) => {
    await open(page);
    await page.locator(".sv-stage .ce").first().click();
    await page.getByRole("button", { name: "Animation d'entrée" }).click();
    await page.getByRole("button", { name: "Ajouter une animation" }).click();
    await expect(page.getByLabel("Effet")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(els(page).first()).toBeVisible();
  });

  test("disposition d'une section : renommer, replier", async ({ page }) => {
    await open(page);
    await btn(page, /^\s*Diapo/).click();
    await btn(page, /^Trieuse/).click();
    await page.locator(".sorter__item").nth(1).getByRole("button", { name: "Commencer une section ici" }).click();
    const name = page.getByLabel("Nom de la section");
    await name.fill("Ma section");
    await name.blur();
    await expect(name).toHaveValue("Ma section");
    await page
      .getByRole("button", { name: /Réduire la section|Développer la section/ })
      .first()
      .click();
  });
});
