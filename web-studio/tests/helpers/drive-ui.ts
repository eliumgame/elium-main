import { expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { totpNow } from "../../../server/src/lib/totp";

/** Aides communes aux parcours navigateur du Drive (drive-*.spec.ts). */
export { totpNow };
export const CODE = "DRIV-EE2E-TEST";
export const OWNER = { name: "Patron", email: "owner-p@test.local", pw: "Motdepasse!42-Patron" };
export const MEMBER = { name: "Marie", email: "marie@test.local", pw: "Motdepasse!42-Marie" };
export const GUEST = { name: "Paul", email: "paul@test.local", pw: "Motdepasse!42-Paul" };

export const authCard = (p: Page) => p.locator(".dc-auth__card");
export const SLOW = { timeout: 120_000 };

export async function register(
  page: Page,
  who: { name: string; email: string; pw: string },
  code?: string,
  landing: "home" | "drive" = "home",
) {
  await authCard(page).getByRole("button", { name: "Créer un compte" }).click();
  await authCard(page).getByPlaceholder("Prénom Nom").fill(who.name);
  if (code) await page.getByTestId("activation-code").fill(code);
  await authCard(page).locator('input[type="email"]').fill(who.email);
  const pws = authCard(page).locator('input[type="password"]');
  await pws.nth(0).fill(who.pw);
  await pws.nth(1).fill(who.pw);
  await authCard(page).getByRole("button", { name: "Créer le compte" }).click();
  // Un lien d'invitation (?invite=…) atterrit directement dans le Drive, pas sur l'accueil.
  if (landing === "drive") await expect(page.locator(".dc-app")).toBeVisible(SLOW);
  else await expect(page.getByText("Votre espace de travail documentaire")).toBeVisible(SLOW);
}
export async function login(page: Page, who: { email: string; pw: string }) {
  await authCard(page).locator('input[type="email"]').fill(who.email);
  await authCard(page).locator('input[type="password"]').first().fill(who.pw);
  await authCard(page).locator("form button.eb--primary").first().click();
  await expect(page.getByText("Votre espace de travail documentaire")).toBeVisible(SLOW);
}
export async function openDrive(page: Page) {
  await page.getByText("Drive entreprise chiffré").first().click();
  await expect(page.locator(".dc-app")).toBeVisible(SLOW);
}
export async function nav(page: Page, name: string) {
  await page.locator(".dc-nav").getByRole("button", { name, exact: true }).click();
}
export const row = (page: Page, name: string) => page.locator(".dcx-row", { hasText: name });
export async function promptValue(page: Page, value: string) {
  const input = page.getByRole("dialog").locator("input").first();
  await expect(input).toBeVisible();
  await input.fill(value);
  await page.keyboard.press("Enter"); // vrai clavier
}
export async function newFolder(page: Page, name: string) {
  await page.getByRole("button", { name: /Dossier$/ }).click();
  await promptValue(page, name);
  await expect(row(page, name)).toBeVisible({ timeout: 30_000 });
}
export async function upload(page: Page, name: string, content: string) {
  await page
    .locator('input[type="file"]')
    .first()
    .setInputFiles({ name, mimeType: "application/octet-stream", buffer: Buffer.from(content) });
  await expect(row(page, name)).toBeVisible({ timeout: 60_000 });
}
export async function confirmDialog(page: Page) {
  await page
    .getByRole("dialog")
    .getByRole("button")
    .filter({ hasNotText: /Annuler|Fermer/ })
    .last()
    .click();
}
export async function noHorizontalOverflow(page: Page, label: string) {
  const { over, culprits } = await page.evaluate(() => {
    const w = window.innerWidth;
    const bad: string[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("body *"))) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.right > w + 1) {
        const anc = el.closest("[class]");
        bad.push(
          `${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0]}(${Math.round(r.right)})${anc && anc !== el ? "<" + String(anc.className).split(" ")[0] : ""}`,
        );
      }
    }
    return { over: document.documentElement.scrollWidth - w, culprits: bad.slice(0, 8) };
  });
  expect(over, `${label} : débordement horizontal de ${over}px — ${culprits.join(", ")}`).toBeLessThanOrEqual(1);
}

export async function newSession(browser: Browser, viewport?: { width: number; height: number }) {
  const ctx: BrowserContext = await browser.newContext(viewport ? { viewport } : {});
  // Chromium expose l'API File System Access : « Enregistrer » ouvrirait un sélecteur natif que Playwright ne pilote
  // pas. On teste le repli par téléchargement (navigateurs sans l'API : Firefox, Safari, PWA).
  await ctx.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    delete w.showSaveFilePicker;
    delete w.showOpenFilePicker;
  });
  const page = await ctx.newPage();
  await page.goto("/");
  return { ctx, page };
}
