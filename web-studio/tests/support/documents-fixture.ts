import { test as base, expect, type Locator, type Page, type Browser, type BrowserContext } from "@playwright/test";

/**
 * Socle commun des parcours Documents : inscription d'un MEMBRE sur un Drive neuf (le propriétaire
 * est créé d'abord), ouverture d'un document vierge, suivi des erreurs console et des tâches
 * longues, aides de saisie au clavier réel.
 */
export const ACTIVATION = "AAAA-BBBB-CCCC";
export const OWNER = { name: "Propriétaire", email: "owner-b@test.local", pw: "Motdepasse!42-Owner" };
export const MEMBER = {
  name: "Membre Docs",
  email: `membre-docs-${Date.now()}@test.local`,
  pw: "Motdepasse!42-Docs",
};

const card = (page: Page) => page.locator(".dc-auth__card");

export async function expectHome(page: Page, timeout = 120_000) {
  await expect(page.getByText("Votre espace de travail documentaire")).toBeVisible({ timeout });
}

export async function register(
  page: Page,
  who: { name: string; email: string; pw: string },
  createOrg = false,
  homeTimeout = 120_000,
) {
  await page.goto("/");
  await expect(card(page).getByRole("button", { name: "Connexion" })).toBeVisible({ timeout: 120_000 });
  await card(page).getByRole("button", { name: "Créer un compte" }).click();
  await card(page).getByPlaceholder("Prénom Nom").fill(who.name);
  const code = page.getByTestId("activation-code");
  if (await code.isVisible({ timeout: 5_000 }).catch(() => false)) await code.fill(ACTIVATION);
  await card(page).locator('input[type="email"]').fill(who.email);
  const pws = card(page).locator('input[type="password"]');
  await pws.nth(0).fill(who.pw);
  await pws.nth(1).fill(who.pw);
  await card(page).getByRole("button", { name: "Créer le compte" }).click();
  await expectHome(page, homeTimeout);
  if (!createOrg) return;
  await page.getByText("Drive entreprise chiffré").first().click();
  await page.getByPlaceholder("Ma société").fill("Demo SARL");
  await page.getByRole("button", { name: "Créer l'organisation" }).click();
  await expect(page.locator(".dc-nav").getByRole("button", { name: "Portail du propriétaire" })).toBeVisible({
    timeout: 60_000,
  });
}

/** Le propriétaire doit exister avant qu'un membre puisse s'inscrire ; sans effet s'il existe déjà. */
export async function ensureOwner(browser: Browser) {
  const api = `http://127.0.0.1:${process.env.DOCS_API_PORT ?? 8801}/api`;
  try {
    const policy = (await (await fetch(`${api}/site/policy`)).json()) as { bootstrapped?: boolean };
    if (policy.bootstrapped) return;
  } catch {
    /* politique illisible : on tente l'inscription */
  }
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    await register(page, OWNER, true);
  } finally {
    await ctx.close();
  }
}

export async function unlockOrLogin(page: Page, who = MEMBER) {
  const locked = page.getByRole("heading", { name: "Session verrouillée" });
  const login = card(page).getByRole("button", { name: "Connexion" });
  await expect(locked.or(login).or(page.getByText("Votre espace de travail documentaire"))).toBeVisible({
    timeout: 120_000,
  });
  if (await page.getByText("Votre espace de travail documentaire").isVisible()) return;
  if (await locked.isVisible()) {
    await card(page).locator('input[type="password"]').fill(who.pw);
    await card(page).getByRole("button", { name: "Déverrouiller" }).click();
  } else {
    await card(page).locator('input[type="email"]').fill(who.email);
    await card(page).locator('input[type="password"]').first().fill(who.pw);
    await card(page).locator("form button.eb--primary").first().click();
  }
  await expectHome(page);
}

export interface Health {
  consoleErrors: string[];
  pageErrors: string[];
}

/** Erreurs console / exceptions non interceptées, hors bruit réseau attendu en dev. */
export function trackHealth(page: Page): Health {
  const h: Health = { consoleErrors: [], pageErrors: [] };
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const t = m.text();
    if (/Failed to load resource|favicon|ERR_|net::/.test(t)) return;
    h.consoleErrors.push(t);
  });
  page.on("pageerror", (e) => h.pageErrors.push(e.message));
  return h;
}

export async function watchLongTasks(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __long: number[] };
    w.__long = [];
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) w.__long.push(Math.round(e.duration));
      }).observe({ entryTypes: ["longtask"] });
    } catch {
      /* API absente */
    }
  });
}
export const longTasks = (page: Page) => page.evaluate(() => (window as unknown as { __long?: number[] }).__long ?? []);

/** Ouvre un document vierge (profil Simple) depuis l'accueil. */
export async function newBlankDoc(page: Page, title?: string) {
  if (
    !(await page
      .locator(".elx-ribbon")
      .isVisible()
      .catch(() => false))
  ) {
    // De l'accueil (ou d'un autre module) : clic sur la tuile Documents.
    if (
      !(await page
        .getByText("Votre espace de travail documentaire")
        .isVisible()
        .catch(() => false))
    ) {
      await page.getByTitle("Accueil").first().click();
      await expectHome(page);
    }
    await page.getByRole("button", { name: /^Documents? Éditeur/ }).click();
    await page.getByRole("button", { name: /Simple/ }).click();
  }
  await expect(page.locator(".elx-ribbon")).toBeVisible();
  await expect(editor(page)).toBeVisible();
  if (title) await page.getByLabel("Titre du document").fill(title);
}

/** Étend la sélection au clavier, puis laisse ProseMirror relire la sélection du DOM avant la commande suivante. */
export async function select(page: Page, combo: string) {
  await page.keyboard.press(combo);
  await page.waitForTimeout(150);
}

export const editor = (page: Page): Locator => page.locator(".elium-prose").first();

/** Clique dans la page et place le curseur dans le corps du document. */
export async function focusBody(page: Page) {
  await editor(page).click();
}

/** Vide le modèle de départ (titre + paragraphe d'amorce) pour partir d'une page blanche. */
export async function clearBody(page: Page) {
  await editor(page).click();
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Delete");
  await expect(editor(page)).toHaveText(/^\s*$/);
  // Laisse passer le premier cycle de remontée / de mise en page : un raccourci pressé dans la
  // première seconde suivant l'ouverture d'un document peut être perdu (voir le rapport).
  await page.waitForTimeout(1200);
}

export async function tab(page: Page, name: string) {
  await page.locator(".elx-ribbon [role=tab]", { hasText: name }).first().click();
}

export async function ribbon(page: Page, tabName: string, title: string | RegExp) {
  await tab(page, tabName);
  const b = page.locator(".elx-ribbon").getByRole("button", { name: title }).first();
  await b.click();
}

export { expect, base as test };
export type { Page, BrowserContext };
