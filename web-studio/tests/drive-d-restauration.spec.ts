import { test, expect, type Page } from "@playwright/test";
import { OWNER, MEMBER, SLOW, authCard, login, openDrive, nav, newSession } from "./helpers/drive-ui";

/**
 * Cycle « effacement total du navigateur → reconnexion → restauration automatique » pour un MEMBRE,
 * contrôlé côté serveur : le propriétaire voit dans le portail la date et le nombre d'éléments de la
 * dernière sauvegarde du membre. S'exécute après drive-a/b/c (mêmes comptes).
 */
let marie: Page;
const closers: { close: () => Promise<void> }[] = [];

async function wipeBrowserData(page: Page) {
  await page.evaluate(async () => {
    localStorage.clear();
    sessionStorage.clear();
    const dbs = (await indexedDB.databases?.()) ?? [];
    await Promise.all(
      dbs.map(
        (d) =>
          new Promise<void>((res) => {
            if (!d.name) return res();
            const r = indexedDB.deleteDatabase(d.name);
            r.onsuccess = r.onerror = r.onblocked = () => res();
          }),
      ),
    );
  });
}

test.describe.serial("Sauvegarde et restauration d'un membre", () => {
  test("membre : crée un document local et le sauvegarde dans le Drive", async ({ browser }) => {
    const s = await newSession(browser);
    closers.push(s.ctx);
    marie = s.page;
    await login(marie, MEMBER);
    await marie.getByRole("button", { name: /^Documents? Éditeur/ }).click();
    await marie.getByRole("button", { name: /Simple/ }).click();
    const ed = marie.locator(".ProseMirror").first();
    await expect(ed).toBeVisible(SLOW);
    await marie.getByRole("textbox", { name: "Titre du document" }).fill("Rapport à restaurer");
    await ed.click();
    await marie.keyboard.type("Texte à retrouver après effacement total");
    await marie
      .getByRole("button", { name: /Enregistrer dans le Drive/ })
      .first()
      .click();
    await expect(marie.getByText(/Enregistré dans le Drive/).first()).toBeVisible({ timeout: 90_000 });
  });

  test("le propriétaire voit la sauvegarde du membre dans le portail", async ({ browser }) => {
    const o = await newSession(browser);
    closers.push(o.ctx);
    await login(o.page, OWNER);
    await openDrive(o.page);
    await nav(o.page, "Portail du propriétaire");
    await o.page.getByTestId("portal-tab-users").click();
    const r = o.page.getByTestId(`user-row-${MEMBER.email}`);
    await expect(r).toBeVisible({ timeout: 30_000 });
    await expect(r).not.toContainText("jamais", { timeout: 30_000 });
    await o.ctx.close();
  });

  test("effacement total du navigateur, reconnexion : l'espace est restauré automatiquement", async () => {
    await wipeBrowserData(marie);
    await marie.reload();
    await expect(authCard(marie).getByRole("button", { name: "Connexion" })).toBeVisible(SLOW);
    await login(marie, MEMBER);
    // restauration automatique (appareil vierge) : bannière « Votre espace a été restauré »
    await expect(marie.getByText(/Votre espace a été restauré/)).toBeVisible({ timeout: 120_000 });
    await expect(marie.getByText("Rapport à restaurer").first()).toBeVisible({ timeout: 60_000 });
  });

  test("le contenu restauré est intact : le document se rouvre avec son texte", async () => {
    await marie.getByText("Rapport à restaurer").first().click();
    await expect(marie.locator(".ProseMirror").first()).toContainText("Texte à retrouver après effacement total", {
      timeout: 60_000,
    });
  });

  test.afterAll(async () => {
    for (const c of closers) await c.close().catch(() => {});
  });
});
