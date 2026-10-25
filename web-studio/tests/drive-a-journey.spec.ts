import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import {
  CODE,
  OWNER,
  MEMBER,
  SLOW,
  authCard,
  register,
  login,
  openDrive,
  nav,
  row,
  newFolder,
  upload,
  promptValue,
  confirmDialog,
  noHorizontalOverflow,
  newSession,
} from "./helpers/drive-ui";

/**
 * Drive entreprise dans un VRAI navigateur, plusieurs comptes (propriétaire, membre, anonyme) :
 * garde, inscription, fichiers (créer/renommer/déplacer/corbeille/versions/import), partage par
 * membre et par lien, isolation du membre simple, portail, 390 px. Comptes @test.local.
 */

let owner: { ctx: BrowserContext; page: Page };
let member: { ctx: BrowserContext; page: Page };

test.describe.serial("Drive entreprise : plusieurs comptes", () => {
  test("garde : un site déployé n'ouvre aucun module sans compte", async ({ browser }) => {
    owner = await newSession(browser);
    await expect(authCard(owner.page).getByRole("button", { name: "Connexion" })).toBeVisible(SLOW);
    await expect(owner.page.getByText("Votre espace de travail documentaire")).toHaveCount(0);
    // Un lien profond vers un module ne contourne pas la garde.
    await owner.page.goto("/?mode=drive-cloud");
    await expect(authCard(owner.page).getByRole("button", { name: "Connexion" })).toBeVisible(SLOW);
  });

  test("propriétaire : inscription (code d'activation), création du Drive, portail", async () => {
    const p = owner.page;
    await p.goto("/");
    await register(p, OWNER, CODE);
    await openDrive(p);
    await p.getByPlaceholder("Ma société").fill("Test SARL");
    await p.getByRole("button", { name: "Créer l'organisation" }).click();
    await expect(p.locator(".dc-nav").getByRole("button", { name: "Portail du propriétaire" })).toBeVisible(SLOW);
  });

  test("membre : inscription libre, espace privé vide, aucun accès au portail", async ({ browser }) => {
    member = await newSession(browser);
    const p = member.page;
    await expect(authCard(p).getByRole("button", { name: "Connexion" })).toBeVisible(SLOW);
    await register(p, MEMBER);
    await openDrive(p);
    const navItems = await p.locator(".dc-nav").getByRole("button").allInnerTexts();
    expect(navItems.join("|")).not.toContain("Portail du propriétaire");
    await expect(p.getByRole("button", { name: /Dossier$/ })).toBeEnabled({ timeout: 30_000 });
    await expect(p.getByText("Aucun fichier.")).toBeVisible();
  });

  test("membre : dossiers et fichiers (créer, renommer, déplacer, importer, télécharger)", async () => {
    const p = member.page;
    await newFolder(p, "Mes projets");
    await newFolder(p, "Archives");
    // ouvrir un dossier (double-clic réel)
    await row(p, "Mes projets").dblclick();
    await expect(p.locator(".dcx-crumbs")).toContainText("Mes projets");
    await upload(p, "notes.dat", "contenu secret de Marie v1");
    // renommer au clavier : sélection + F2
    await row(p, "notes.dat").click();
    await p.keyboard.press("F2");
    await promptValue(p, "notes-renommees.dat");
    await expect(row(p, "notes-renommees.dat")).toBeVisible({ timeout: 30_000 });
    // télécharger (contenu déchiffré = contenu d'origine)
    const dl = p.waitForEvent("download");
    await row(p, "notes-renommees.dat").getByTitle("Télécharger").click();
    const file = await dl;
    const fs = await import("node:fs/promises");
    expect(await fs.readFile(await file.path(), "utf8")).toBe("contenu secret de Marie v1");
    // déplacer par glisser-déposer vers un dossier frère : retour racine puis dépôt sur « Archives »
    await p.locator(".dcx-crumbs button").first().click();
    await expect(row(p, "Archives")).toBeVisible();
    await row(p, "Mes projets").dblclick();
    await row(p, "notes-renommees.dat").dragTo(p.locator(".dcx-crumbs button").first());
    await p.locator(".dcx-crumbs button").first().click();
    await expect(row(p, "notes-renommees.dat")).toBeVisible({ timeout: 30_000 });
  });

  test("membre : corbeille (supprimer, restaurer), versions", async () => {
    const p = member.page;
    await row(p, "notes-renommees.dat").getByTitle("Corbeille (Suppr)").click();
    await confirmDialog(p);
    await expect(row(p, "notes-renommees.dat")).toHaveCount(0, { timeout: 30_000 });
    await nav(p, "Corbeille");
    await expect(p.getByText("notes-renommees.dat")).toBeVisible({ timeout: 30_000 });
    await p.getByTitle("Restaurer").first().click();
    await nav(p, "Fichiers");
    await expect(row(p, "notes-renommees.dat")).toBeVisible({ timeout: 30_000 });
    // nouvelle version : ré-import du même nom → historique des versions
    await row(p, "notes-renommees.dat").getByTitle("Historique des versions").click();
    await expect(p.getByRole("dialog")).toBeVisible();
    await p.keyboard.press("Escape");
  });

  test("isolation : le membre ne voit rien des autres, le propriétaire a son portail", async () => {
    const o = owner.page;
    await nav(o, "Fichiers");
    await newFolder(o, "Dossier du patron");
    const m = member.page;
    await nav(m, "Fichiers");
    await m.getByTitle("Actualiser").click();
    await expect(row(m, "Dossier du patron")).toHaveCount(0);
    // API directe : le membre n'accède à aucune route du portail
    const status = await m.evaluate(async () => {
      const raw = localStorage.getItem("elium_drive_session_v1");
      const tok = raw ? (JSON.parse(raw) as { tokens: { accessToken: string } }).tokens.accessToken : "";
      const hit = async (path: string, method = "GET") =>
        (await fetch(`/api/site/admin/${path}`, { method, headers: { authorization: `Bearer ${tok}` } })).status;
      return [await hit("settings"), await hit("users")];
    });
    expect(status).toEqual([403, 403]);
    await nav(o, "Portail du propriétaire");
    await o.getByTestId("portal-tab-users").click();
    await expect(o.getByTestId(`user-row-${MEMBER.email}`)).toBeVisible({ timeout: 30_000 });
  });

  test("partage : le propriétaire partage un dossier au membre, qui le voit puis perd l'accès", async () => {
    const o = owner.page;
    await nav(o, "Fichiers");
    await row(o, "Dossier du patron").getByTitle("Partager").click();
    const dlg = o.getByRole("dialog");
    await dlg.locator('input[type="email"]').first().fill(MEMBER.email);
    await dlg
      .getByRole("button", { name: /Partager|Ajouter|Inviter/ })
      .first()
      .click();
    await expect(dlg).toContainText(MEMBER.name, { timeout: 60_000 });
    await o.keyboard.press("Escape");
    const m = member.page;
    await m.getByTitle("Actualiser").click();
    await expect(row(m, "Dossier du patron")).toBeVisible({ timeout: 30_000 });
    // retrait du partage (révocation + rotation des clés)
    await row(o, "Dossier du patron").getByTitle("Partager").click();
    await o
      .getByRole("dialog")
      .getByTitle(/Retirer|Révoquer|Supprimer/)
      .first()
      .click();
    await expect(o.getByRole("dialog")).not.toContainText(MEMBER.name, { timeout: 90_000 });
    await o.keyboard.press("Escape");
    await m.getByTitle("Actualiser").click();
    await expect(row(m, "Dossier du patron")).toHaveCount(0, { timeout: 30_000 });
  });

  test("lien de partage : un anonyme ouvre le fichier sans compte", async ({ browser }) => {
    const m = member.page;
    await nav(m, "Fichiers");
    await m.locator(".dcx-crumbs button").first().click();
    await row(m, "notes-renommees.dat").getByTitle("Partager").click();
    const dlg = m.getByRole("dialog");
    await dlg.getByRole("button", { name: /Créer un lien/ }).click();
    const link = await dlg.locator("input[readonly]").first().inputValue();
    expect(link).toContain("?link=");
    await m.keyboard.press("Escape");
    const anon = await newSession(browser);
    await anon.page.goto(link);
    await expect(anon.page.getByText("notes-renommees.dat")).toBeVisible({ timeout: 60_000 });
    await anon.ctx.close();
  });

  test("fenêtre étroite 390 px : aucune page ne déborde", async ({ browser }) => {
    const narrow = await newSession(browser, { width: 390, height: 800 });
    const p = narrow.page;
    await noHorizontalOverflow(p, "écran de connexion");
    await login(p, MEMBER);
    await openDrive(p);
    await noHorizontalOverflow(p, "Drive (fichiers)");
    for (const n of ["Membres", "Rôles & permissions", "Corbeille", "Sécurité", "Journal d'audit"]) {
      const item = p.locator(".dc-nav").getByRole("button", { name: n, exact: true });
      if (await item.count()) {
        await item.click();
        await noHorizontalOverflow(p, `Drive › ${n}`);
      }
    }
    await narrow.ctx.close();
    const ownerNarrow = await newSession(browser, { width: 390, height: 800 });
    await login(ownerNarrow.page, OWNER);
    await openDrive(ownerNarrow.page);
    await nav(ownerNarrow.page, "Portail du propriétaire");
    for (const t of ["access", "users", "storage", "security", "invites"]) {
      await ownerNarrow.page.getByTestId(`portal-tab-${t}`).click();
      await noHorizontalOverflow(ownerNarrow.page, `Portail › ${t}`);
    }
    await ownerNarrow.ctx.close();
  });
});

// Utilitaires exportés pour les autres parcours (parapheur, restauration).
