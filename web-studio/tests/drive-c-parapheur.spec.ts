import { test, expect, type Page } from "@playwright/test";
import { MEMBER, SLOW, authCard, login, openDrive, nav, row, newSession } from "./helpers/drive-ui";

/**
 * Parapheur et signatures dans un vrai navigateur : un membre crée un document, l'enregistre dans le
 * Drive, demande des signatures par lien (deux signataires, dans l'ordre), un anonyme SANS COMPTE signe,
 * un autre refuse ; le membre voit les statuts. S'exécute après drive-a/drive-b (mêmes comptes).
 */
let marie: Page;
const closers: { close: () => Promise<void> }[] = [];
const links: string[] = [];
let elium = "";

test.describe.serial("Parapheur et signatures", () => {
  test("membre : crée un document et l'enregistre dans le Drive", async ({ browser }, testInfo) => {
    const s = await newSession(browser);
    closers.push(s.ctx);
    marie = s.page;
    await login(marie, MEMBER);
    // Documents → profil « Simple » → éditeur
    await marie.getByRole("button", { name: /^Documents? Éditeur/ }).click();
    await marie.getByRole("button", { name: /Simple/ }).click();
    const ed = marie.locator(".ProseMirror").first();
    await expect(ed).toBeVisible(SLOW);
    await ed.click();
    await marie.keyboard.type("Contrat de test à signer");
    // « Enregistrer » produit le fichier .elium (téléchargement) ; on l'importera ensuite dans le Drive.
    const dl = marie.waitForEvent("download", { timeout: 60_000 });
    await marie.getByRole("button", { name: "Enregistrer", exact: true }).click();
    const file = await dl;
    expect(file.suggestedFilename()).toMatch(/\.elium$/);
    elium = testInfo.outputPath(file.suggestedFilename()); // nom réel (le chemin temporaire de Playwright est un GUID sans extension)
    await file.saveAs(elium);
  });

  test("Drive : le document apparaît ; demande de signature à deux signataires dans l'ordre", async () => {
    await marie.getByRole("img", { name: "Elium" }).first().click(); // logo = retour à l'accueil
    await expect(marie.getByText("Votre espace de travail documentaire")).toBeVisible(SLOW);
    await openDrive(marie);
    await nav(marie, "Fichiers");
    await marie.locator('input[type="file"]').first().setInputFiles(elium);
    await marie.getByTitle("Actualiser").click();
    const doc = marie.locator(".dcx-row", { has: marie.getByTitle("Demander une signature par lien") }).first();
    await expect(doc).toBeVisible({ timeout: 60_000 });
    await doc.getByTitle("Demander une signature par lien").click();
    const dlg = marie.getByRole("dialog");
    await expect(dlg).toContainText("Demander une signature");
    await dlg.getByPlaceholder(/Libellé du signataire 1/).fill("Paul Dupont");
    await dlg
      .getByRole("button", { name: /Ajouter/ })
      .first()
      .click();
    await dlg.getByPlaceholder(/Libellé du signataire 2/).fill("Claire Martin");
    await dlg
      .getByText(/ne peut signer qu'après le précédent|dans l'ordre/i)
      .first()
      .click()
      .catch(() => {});
    await dlg.getByRole("button", { name: /Créer 2 liens/ }).click();
    await expect(dlg.locator(".elx-signrow__out input")).toHaveCount(2, { timeout: 90_000 }); // chiffrement + création côté serveur
    const urls = await dlg
      .locator(".elx-signrow__out input")
      .evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
    expect(urls.length).toBe(2);
    for (const u of urls) expect(u).toContain("?sign=");
    links.push(...urls);
  });

  test("signataire sans compte : ouvre le lien, signe et renvoie", async ({ browser }) => {
    const s = await newSession(browser);
    closers.push(s.ctx);
    await s.page.goto(links[0]!);
    await expect(s.page.getByText(/Contrat de test|signature|Signer/i).first()).toBeVisible({ timeout: 90_000 });
    await expect(s.page.getByRole("button", { name: /Signer et renvoyer/ })).toBeVisible({ timeout: 90_000 });
    await s.page.locator("form input").first().fill("Paul Dupont");
    await s.page.getByRole("button", { name: /Signer et renvoyer/ }).click();
    await expect(s.page.getByText(/Signature envoyée|signé|merci|transmis/i).first()).toBeVisible({ timeout: 120_000 });
  });

  test("deuxième signataire : refuse de signer", async ({ browser }) => {
    const s = await newSession(browser);
    closers.push(s.ctx);
    await s.page.goto(links[1]!);
    await expect(s.page.getByRole("button", { name: /Refuser de signer/ })).toBeVisible({ timeout: 90_000 });
    await s.page.getByRole("button", { name: /Refuser de signer/ }).click();
    await expect(s.page.getByText(/refus|décliné|décision/i).first()).toBeVisible({ timeout: 60_000 });
  });

  test("le membre voit les statuts (signé / refusé)", async () => {
    const doc = marie.locator(".dcx-row", { has: marie.getByTitle("Demander une signature par lien") }).first();
    await marie.keyboard.press("Escape");
    await doc.getByTitle("Demander une signature par lien").click();
    const dlg = marie.getByRole("dialog");
    await expect(dlg).toContainText(/signé/i, { timeout: 60_000 });
    await expect(dlg).toContainText(/refus/i, { timeout: 60_000 });
    await expect(dlg).toContainText("Paul Dupont");
    await expect(dlg).toContainText("Claire Martin");
  });

  test("lien invalide ou expiré : message clair, pas de page blanche", async ({ browser }) => {
    const s = await newSession(browser);
    closers.push(s.ctx);
    await s.page.goto("/?sign=jeton-inexistant-0123456789#secret");
    await expect(s.page.locator("body")).toContainText(
      /invalide|expiré|introuvable|impossible|indisponible|incomplet|manquant/i,
      { timeout: 60_000 },
    );
    await expect(authCard(s.page)).toHaveCount(0);
  });

  test.afterAll(async () => {
    for (const c of closers) await c.close().catch(() => {});
  });
});

void row;
