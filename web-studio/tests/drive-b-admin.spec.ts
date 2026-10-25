import { test, expect, type Page } from "@playwright/test";
import {
  OWNER,
  MEMBER,
  GUEST,
  SLOW,
  authCard,
  register,
  login,
  openDrive,
  nav,
  row,
  newFolder,
  promptValue,
  newSession,
} from "./helpers/drive-ui";

/**
 * Administration du Drive dans un vrai navigateur, plusieurs comptes : utilisateurs (quota, suspension),
 * modes d'inscription (invitation, fermée), rôles, équipes, journal d'audit, recouvrement, SSO,
 * co-édition temps réel entre deux comptes. S'exécute après drive-a-journey (mêmes comptes).
 */
let owner: Page;
let member: Page;
const sessions: { close: () => Promise<void> }[] = [];

test.describe.serial("Administration du Drive", () => {
  test("ouverture : propriétaire et membre se reconnectent", async ({ browser }) => {
    const o = await newSession(browser);
    const m = await newSession(browser);
    sessions.push(o.ctx, m.ctx);
    owner = o.page;
    member = m.page;
    await login(owner, OWNER);
    await openDrive(owner);
    await login(member, MEMBER);
    await openDrive(member);
    await expect(owner.locator(".dc-nav").getByRole("button", { name: "Portail du propriétaire" })).toBeVisible();
  });

  test("utilisateurs : quota individuel, suspension puis réactivation", async ({ browser }) => {
    await nav(owner, "Portail du propriétaire");
    await owner.getByTestId("portal-tab-users").click();
    await owner.getByRole("button", { name: `Quota de ${MEMBER.email}` }).click();
    await owner
      .getByRole("row", { name: new RegExp(MEMBER.email) })
      .locator("input")
      .first()
      .fill("5");
    await owner
      .getByRole("row", { name: new RegExp(MEMBER.email) })
      .getByRole("button", { name: "OK" })
      .click();
    await expect(owner.getByTestId("portal-msg")).toContainText("Quota enregistré", { timeout: 30_000 });
    // suspension
    const mrow = owner.getByTestId(`user-row-${MEMBER.email}`);
    await mrow.getByRole("button", { name: /Suspendre/ }).click();
    await expect(mrow).toContainText("suspendu", { timeout: 30_000 });
    const s = await newSession(browser);
    sessions.push(s.ctx);
    await authCard(s.page).locator('input[type="email"]').fill(MEMBER.email);
    await authCard(s.page).locator('input[type="password"]').first().fill(MEMBER.pw);
    await authCard(s.page).locator("form button.eb--primary").first().click();
    await expect(authCard(s.page).locator(".dc-error")).toBeVisible({ timeout: 90_000 });
    await mrow.getByRole("button", { name: /Réactiver/ }).click();
    await expect(mrow).not.toContainText("suspendu", { timeout: 30_000 });
    await login(s.page, MEMBER);
  });

  test("inscription sur invitation puis fermée, puis ouverte", async ({ browser }) => {
    await owner.getByTestId("portal-tab-access").click();
    await owner.getByTestId("signup-invite").check();
    await owner.getByTestId("portal-save").click();
    await expect(owner.getByTestId("portal-msg")).toContainText("enregistrés", { timeout: 30_000 });
    const anon = await newSession(browser);
    sessions.push(anon.ctx);
    await expect(authCard(anon.page).getByRole("button", { name: "Connexion" })).toBeVisible(SLOW);
    await expect(authCard(anon.page).getByRole("button", { name: "Créer un compte" })).toHaveCount(0);
    await expect(anon.page.getByTestId("signup-closed")).toContainText("invitation");
    // le propriétaire invite Paul
    await owner.getByTestId("portal-tab-invites").click();
    await owner.getByPlaceholder("E-mail à inviter").fill(GUEST.email);
    await owner
      .getByRole("button", { name: /Inviter|Envoyer/ })
      .first()
      .click();
    const link = await owner
      .locator("input[readonly], code")
      .filter({ hasText: /invite=|^$/ })
      .first()
      .inputValue()
      .catch(async () => await owner.locator("code").first().innerText());
    expect(link).toContain("?invite=");
    const guest = await newSession(browser);
    sessions.push(guest.ctx);
    await guest.page.goto(link);
    await register(guest.page, GUEST, undefined, "drive");
    await expect(guest.page.getByRole("button", { name: /Dossier$/ })).toBeEnabled({ timeout: 30_000 });
    // fermée
    await owner.getByTestId("portal-tab-access").click();
    await owner.getByTestId("signup-closed").check();
    await owner.getByTestId("portal-save").click();
    await expect(owner.getByTestId("portal-msg")).toContainText("enregistrés", { timeout: 30_000 });
    await anon.page.reload();
    await expect(anon.page.getByTestId("signup-closed")).toContainText("fermées", { timeout: 60_000 });
    await owner.getByTestId("signup-open").check();
    await owner.getByTestId("portal-save").click();
    await expect(owner.getByTestId("portal-msg")).toContainText("enregistrés", { timeout: 30_000 });
  });

  test("rôles : création d'un rôle personnalisé", async () => {
    await nav(owner, "Rôles & permissions");
    await owner.getByTitle("Nouveau rôle").click();
    const nameInput = owner.locator(".dcx-role-name");
    await expect(nameInput).toHaveValue("Nouveau rôle", { timeout: 30_000 });
    await nameInput.fill("Relecteur");
    await owner.getByRole("button", { name: /Enregistrer/ }).click();
    await expect(owner.locator(".dcx-role-item", { hasText: "Relecteur" })).toBeVisible({ timeout: 30_000 });
  });

  test("équipes : création d'une équipe avec un membre", async () => {
    await nav(owner, "Équipes");
    await owner.getByTitle("Nouvelle équipe").click();
    await owner.getByPlaceholder("Marketing").fill("Compta");
    await owner.getByPlaceholder(/ajouter@exemple\.fr/).fill(MEMBER.email);
    await owner.keyboard.press("Enter");
    await owner.getByRole("button", { name: /Créer/ }).last().click();
    await expect(owner.locator("main").getByText("Compta").first()).toBeVisible({ timeout: 60_000 });
    // le membre ajouté figure bien dans l'équipe (clé d'équipe enveloppée pour lui)
    await owner.locator("main").getByText("Compta").first().click();
    await expect(owner.locator(".dcx-team-row", { hasText: "Marie" })).toBeVisible({ timeout: 30_000 });
  });

  test("journal d'audit, recouvrement (propriétaire seulement)", async () => {
    await nav(owner, "Journal d'audit");
    await expect(owner.locator("main")).toContainText(/org\.create|node\.create|member|invit/i, { timeout: 30_000 });
    await nav(owner, "Recouvrement");
    await expect(owner.locator("main")).toContainText(/recouvrement|clé d'organisation/i);
    const items = await member.locator(".dc-nav").getByRole("button").allInnerTexts();
    expect(items.join("|")).not.toContain("Recouvrement");
    expect(items.join("|")).not.toContain("Portail");
  });

  test("SSO : configuration avec confirmation d'identité", async () => {
    await nav(owner, "SSO & SCIM");
    await owner.getByPlaceholder("https://exemple.okta.com", { exact: true }).fill("https://idp.test.local");
    await owner.getByPlaceholder("0oa…").fill("elium-test");
    await owner.getByPlaceholder(/oauth2\/v1\/keys/).fill("https://idp.test.local/oauth2/v1/keys");
    await owner.getByRole("button", { name: /Enregistrer le SSO/ }).click();
    const dlg = owner.getByRole("dialog");
    await expect(dlg).toContainText("Confirmez votre identité");
    await dlg.locator("input").first().fill("Mauvais!motdepasse-1");
    await owner.keyboard.press("Enter");
    await expect(owner.locator("main")).toContainText(/incorrect/i, { timeout: 90_000 });
    await owner.getByRole("button", { name: /Enregistrer le SSO/ }).click();
    await owner.getByRole("dialog").locator("input").first().fill(OWNER.pw);
    await owner.keyboard.press("Enter");
    await expect(owner.getByText(/Configuration SSO enregistrée/)).toBeVisible({ timeout: 90_000 });
  });

  test("co-édition : un document collaboratif partagé, frappe vue en direct par l'autre compte", async () => {
    await nav(member, "Fichiers");
    await member.getByRole("button", { name: /^Doc$/ }).click();
    await promptValue(member, "Compte rendu");
    const editor = member.locator(".ProseMirror").first();
    await expect(editor).toBeVisible({ timeout: 60_000 });
    await editor.click();
    await member.keyboard.type("Bonjour de Marie");
    // laisse partir la frappe (relais chiffré) avant de fermer
    await member.waitForTimeout(2500);
    await expect(editor).toContainText("Bonjour de Marie");
    // fermeture puis réouverture : le contenu est bien rechargé depuis le serveur (journal chiffré)
    await member.getByRole("button", { name: "Fermer", exact: true }).first().click();
    await row(member, "Compte rendu").dblclick();
    await expect(member.locator(".ProseMirror").first()).toContainText("Bonjour de Marie", { timeout: 60_000 });
    await member.getByRole("button", { name: "Fermer", exact: true }).first().click();
    // partage avec le propriétaire
    await row(member, "Compte rendu").getByTitle("Partager").click();
    const dlg = member.getByRole("dialog");
    await dlg.locator('input[type="email"]').first().fill(OWNER.email);
    await dlg
      .getByRole("button", { name: /Partager|Ajouter|Inviter/ })
      .first()
      .click();
    await expect(dlg).toContainText("Patron", { timeout: 60_000 });
    await member.keyboard.press("Escape");
    // le propriétaire ouvre le document : il voit le texte, puis tape à son tour
    await nav(owner, "Fichiers");
    await owner.getByTitle("Actualiser").click();
    await row(owner, "Compte rendu").dblclick();
    const oEditor = owner.locator(".ProseMirror").first();
    await expect(oEditor).toContainText("Bonjour de Marie", { timeout: 60_000 });
    await oEditor.click();
    await owner.keyboard.press("End");
    await owner.keyboard.type(" — réponse du patron");
    await member
      .getByRole("button", { name: "Fermer", exact: true })
      .first()
      .click()
      .catch(() => {});
    await row(member, "Compte rendu").dblclick();
    await expect(member.locator(".ProseMirror").first()).toContainText("réponse du patron", { timeout: 60_000 });
  });

  test.afterAll(async () => {
    for (const s of sessions) await s.close().catch(() => {});
  });
});
