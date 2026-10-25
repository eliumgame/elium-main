import { test, expect, type Page } from "@playwright/test";
import { OWNER, MEMBER, SLOW, login, openDrive, nav, row, newFolder, newSession } from "./helpers/drive-ui";

/**
 * Droits et usages courants dans un vrai navigateur : rôle « Lecteur » (aucune écriture), partage à une
 * équipe, recherche, corbeille (restaurer / supprimer définitivement), appareils et sessions, portail
 * « Rétablir ses accès ». S'exécute après drive-a…d (mêmes comptes).
 */
let owner: Page;
let marie: Page;
const closers: { close: () => Promise<void> }[] = [];

test.describe.serial("Droits, équipes, corbeille, appareils", () => {
  test("ouverture", async ({ browser }) => {
    const o = await newSession(browser);
    const m = await newSession(browser);
    closers.push(o.ctx, m.ctx);
    owner = o.page;
    marie = m.page;
    await login(owner, OWNER);
    await openDrive(owner);
    await login(marie, MEMBER);
    await openDrive(marie);
  });

  test("rôle Lecteur : le membre voit le dossier partagé mais ne peut rien y modifier", async () => {
    await nav(owner, "Fichiers");
    await newFolder(owner, "Lecture seule");
    await row(owner, "Lecture seule").getByTitle("Partager").click();
    const dlg = owner.getByRole("dialog");
    await dlg.locator('input[type="email"]').first().fill(MEMBER.email);
    await dlg.getByLabel("Rôle du membre").selectOption({ label: "Lecteur" });
    await dlg
      .getByRole("button", { name: /^Partager$/ })
      .first()
      .click();
    await expect(dlg).toContainText("Lecteur", { timeout: 60_000 });
    await owner.keyboard.press("Escape");
    await nav(marie, "Fichiers");
    await marie.getByTitle("Actualiser").click();
    await row(marie, "Lecture seule").dblclick();
    await expect(marie.locator(".dcx-crumbs")).toContainText("Lecture seule");
    await expect(marie.getByRole("button", { name: /Dossier$/ })).toBeDisabled();
    await expect(marie.getByRole("button", { name: /Importer/ })).toBeDisabled();
    await marie.locator(".dcx-crumbs button").first().click();
  });

  test("partage à une équipe : les membres de l'équipe voient le dossier", async () => {
    await nav(owner, "Fichiers");
    await newFolder(owner, "Pour la compta");
    await row(owner, "Pour la compta").getByTitle("Partager").click();
    const dlg = owner.getByRole("dialog");
    await dlg.getByLabel("Équipe", { exact: true }).selectOption({ label: "Compta" });
    await dlg
      .getByRole("button", { name: /^Partager$/ })
      .last()
      .click();
    await expect(dlg).toContainText("Compta", { timeout: 60_000 });
    await owner.keyboard.press("Escape");
    await marie.getByTitle("Actualiser").click();
    await expect(row(marie, "Pour la compta")).toBeVisible({ timeout: 60_000 });
  });

  test("recherche et filtres dans le dossier", async () => {
    await marie.getByPlaceholder("Rechercher dans ce dossier…").fill("compta");
    await expect(row(marie, "Pour la compta")).toBeVisible();
    await expect(row(marie, "Lecture seule")).toHaveCount(0);
    await marie.getByPlaceholder("Rechercher dans ce dossier…").fill("");
    await marie.getByRole("button", { name: "Dossiers", exact: true }).click();
    await expect(row(marie, "Mes projets")).toBeVisible();
    await marie.getByRole("button", { name: "Dossiers", exact: true }).click();
  });

  test("corbeille : restaurer puis supprimer définitivement", async () => {
    await newFolder(marie, "Jetable");
    await row(marie, "Jetable").getByTitle("Corbeille (Suppr)").click();
    await marie.getByRole("dialog").getByRole("button", { name: "Corbeille" }).click();
    await expect(row(marie, "Jetable")).toHaveCount(0, { timeout: 30_000 });
    await nav(marie, "Corbeille");
    const trashRow = marie.locator("tr", { hasText: "Jetable" });
    await expect(trashRow).toBeVisible({ timeout: 30_000 });
    await trashRow.getByTitle("Supprimer définitivement").click();
    await marie
      .getByRole("dialog")
      .getByRole("button")
      .filter({ hasNotText: /Annuler|Fermer/ })
      .last()
      .click();
    await expect(trashRow).toHaveCount(0, { timeout: 30_000 });
  });

  test("appareils et sessions : l'appareil courant est marqué ; « déconnecter les autres »", async ({ browser }) => {
    const other = await newSession(browser);
    closers.push(other.ctx);
    await login(other.page, MEMBER);
    await nav(marie, "Sécurité");
    const devices = marie.getByTestId("devices-section");
    await expect(devices).toContainText("cet appareil", { timeout: 30_000 });
    await expect(devices.locator("li")).toHaveCount(await devices.locator("li").count());
    expect(await devices.locator("li").count()).toBeGreaterThanOrEqual(2);
    await devices.getByRole("button", { name: /Déconnecter les autres appareils/ }).click();
    await expect(devices.locator("li")).toHaveCount(1, { timeout: 30_000 });
  });

  test("portail : « Rétablir ses accès » pour un membre", async () => {
    await nav(owner, "Portail du propriétaire");
    await owner.getByTestId("portal-tab-users").click();
    await owner.getByTestId(`restore-${MEMBER.email}`).click();
    await owner.getByTestId("restore-confirm").click();
    await expect(owner.getByTestId("restore-result")).toContainText(/rétabli/, { timeout: 90_000 });
  });

  test.afterAll(async () => {
    for (const c of closers) await c.close().catch(() => {});
  });
});

void SLOW;
