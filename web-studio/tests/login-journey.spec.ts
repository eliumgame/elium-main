import { test, expect, type Page } from "@playwright/test";
import { totpNow } from "../../server/src/lib/totp";

/**
 * Parcours de connexion de bout en bout (vrai navigateur, vrai serveur Drive) :
 * garde d'authentification → inscription du propriétaire avec code d'activation →
 * création du Drive → connexion sans 2FA → mauvais mot de passe → verrou de session
 * → activation TOTP → reconnexion avec code → avec code de secours → 2FA obligatoire
 * (confirmation + ré-authentification) → enrôlement forcé d'un autre compte →
 * réinitialisation de mot de passe par le propriétaire → compte suspendu.
 * Lancer : `npm run test:e2e:login` (config playwright.login.config.ts).
 */

const OWNER = { name: "Propriétaire", email: "owner@example.test", pw: "Motdepasse!42-Owner" };
const MEMBER = {
  name: "Membre",
  email: "membre@example.test",
  pw: "Motdepasse!42-Membre",
  pw2: "Motdepasse!77-Nouveau",
};
const ACTIVATION = "AAAA-BBBB-CCCC";

const authCard = (page: Page) => page.locator(".dc-auth__card");

async function expectLoginScreen(page: Page) {
  await expect(authCard(page).getByRole("button", { name: "Connexion" })).toBeVisible({ timeout: 30_000 });
}
async function expectHome(page: Page) {
  await expect(page.getByText("Votre espace de travail documentaire")).toBeVisible({ timeout: 90_000 });
}
async function fillLogin(page: Page, email: string, pw: string) {
  await authCard(page).locator('input[type="email"]').fill(email);
  await authCard(page).locator('input[type="password"]').first().fill(pw);
  await authCard(page).locator("form button.eb--primary").first().click();
}
async function login(page: Page, email: string, pw: string) {
  await fillLogin(page, email, pw);
}
async function openDrive(page: Page) {
  await page.getByText("Drive entreprise chiffré").first().click();
  await expect(page.locator(".dc-app")).toBeVisible({ timeout: 60_000 });
}
async function logoutFromDrive(page: Page) {
  await page.getByTitle("Se déconnecter").click();
  await expectLoginScreen(page);
}
async function driveNav(page: Page, name: string) {
  await page.locator(".dc-nav").getByRole("button", { name }).click();
}
async function loginWithTotp(page: Page, email: string, pw: string, secret: string) {
  await fillLogin(page, email, pw);
  await expect(page.getByRole("heading", { name: /Vérification en deux étapes/ })).toBeVisible({ timeout: 90_000 });
  await page.getByTestId("mfa-code").fill(totpNow(secret));
  await page.getByRole("button", { name: "Vérifier" }).click();
  await expectHome(page);
}
/** Active la 2FA depuis le menu Sécurité ; renvoie le secret et les codes de secours. */
async function enrollTotp(page: Page) {
  await page.getByRole("button", { name: "Activer la 2FA" }).click();
  const secret = (await page.locator(".dc-security__secret").innerText()).trim();
  await page.getByPlaceholder("123456").fill(totpNow(secret));
  await page.getByRole("button", { name: "Confirmer" }).click();
  await expect(page.getByText("Vos codes de secours")).toBeVisible({ timeout: 30_000 });
  const codes = (await page.locator(".dc-security__codelist code").allInnerTexts()).map((c) => c.trim());
  expect(codes.length).toBe(10);
  await page.getByRole("button", { name: "J'ai sauvegardé mes codes" }).click();
  return { secret, codes };
}

test("parcours de connexion complet", async ({ page }) => {
  // --- Garde d'authentification : rien n'est accessible sans compte ---------
  await page.goto("/");
  await expectLoginScreen(page);
  await expect(page.getByText("Votre espace de travail documentaire")).toHaveCount(0);

  // --- Inscription du propriétaire (code d'activation) ----------------------
  await authCard(page).getByRole("button", { name: "Créer un compte" }).click();
  await expect(page.getByTestId("activation-code")).toBeVisible();
  const fillRegister = async (code: string | null, who: { name: string; email: string; pw: string }) => {
    await authCard(page).getByPlaceholder("Prénom Nom").fill(who.name);
    if (code !== null) await page.getByTestId("activation-code").fill(code);
    await authCard(page).locator('input[type="email"]').fill(who.email);
    const pws = authCard(page).locator('input[type="password"]');
    await pws.nth(0).fill(who.pw);
    await pws.nth(1).fill(who.pw);
    await authCard(page).getByRole("button", { name: "Créer le compte" }).click();
  };
  await fillRegister("ZZZZ-ZZZZ-ZZZZ", OWNER);
  await expect(authCard(page).locator(".dc-error")).toContainText("Code d'activation invalide", { timeout: 60_000 });
  await page.getByTestId("activation-code").fill(ACTIVATION);
  await authCard(page).getByRole("button", { name: "Créer le compte" }).click();
  await expectHome(page);

  // --- Création du Drive (le code est repris) --------------------------------
  await openDrive(page);
  await expect(page.getByTestId("activation-code-org")).toHaveValue(ACTIVATION);
  await page.getByPlaceholder("Ma société").fill("Demo SARL");
  await page.getByRole("button", { name: "Créer l'organisation" }).click();
  await expect(page.locator(".dc-nav").getByRole("button", { name: "Portail du propriétaire" })).toBeVisible({
    timeout: 60_000,
  });

  // --- Déconnexion, mauvais mot de passe, connexion sans 2FA -----------------
  await logoutFromDrive(page);
  await login(page, OWNER.email, "Mauvais!motdepasse-1");
  await expect(authCard(page).locator(".dc-error")).toContainText("incorrect", { timeout: 90_000 });
  await login(page, OWNER.email, OWNER.pw);
  await expectHome(page);

  // --- Verrou de session : rechargement = déverrouillage par mot de passe ----
  await page.reload();
  await expect(page.getByRole("heading", { name: "Session verrouillée" })).toBeVisible({ timeout: 30_000 });
  await authCard(page).locator('input[type="password"]').fill("Mauvais!motdepasse-2");
  await authCard(page).getByRole("button", { name: "Déverrouiller" }).click();
  await expect(authCard(page).locator(".dc-error")).toBeVisible({ timeout: 90_000 });
  await authCard(page).locator('input[type="password"]').fill(OWNER.pw);
  await authCard(page).getByRole("button", { name: "Déverrouiller" }).click();
  await expectHome(page);

  // --- Activation de la 2FA (TOTP calculé pour de vrai) ----------------------
  await openDrive(page);
  await driveNav(page, "Sécurité");
  const ownerMfa = await enrollTotp(page);
  await expect(page.getByText("2FA activée")).toBeVisible();

  // --- Reconnexion avec code, puis avec code de secours -----------------------
  await logoutFromDrive(page);
  await fillLogin(page, OWNER.email, OWNER.pw);
  await expect(page.getByRole("heading", { name: /Vérification en deux étapes/ })).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId("mfa-code")).toBeVisible();
  await page.getByTestId("mfa-noapp").click();
  await expect(page.getByTestId("mfa-noapp-help")).toContainText("codes de secours");
  await page.getByTestId("mfa-code").fill("000000");
  await page.getByRole("button", { name: "Vérifier" }).click();
  await expect(authCard(page).locator(".dc-error")).toContainText("Code de vérification invalide", { timeout: 30_000 });
  await expect(page.getByTestId("mfa-code")).toBeVisible(); // pas d'écran vide : on peut réessayer
  await page.getByTestId("mfa-code").fill(totpNow(ownerMfa.secret));
  await page.getByRole("button", { name: "Vérifier" }).click();
  await expectHome(page);

  await openDrive(page);
  await logoutFromDrive(page);
  await fillLogin(page, OWNER.email, OWNER.pw);
  await expect(page.getByTestId("mfa-code")).toBeVisible({ timeout: 90_000 });
  const backup = ownerMfa.codes[0]!;
  await page.getByTestId("mfa-code").fill(backup.toUpperCase()); // saisie tolérante (majuscules)
  await page.getByRole("button", { name: "Vérifier" }).click();
  await expectHome(page);

  // Le même code de secours ne sert qu'une fois ; « Annuler » ramène à la connexion.
  await openDrive(page);
  await logoutFromDrive(page);
  await fillLogin(page, OWNER.email, OWNER.pw);
  await expect(page.getByTestId("mfa-code")).toBeVisible({ timeout: 90_000 });
  await page.getByTestId("mfa-code").fill(backup);
  await page.getByRole("button", { name: "Vérifier" }).click();
  await expect(authCard(page).locator(".dc-error")).toContainText("Code de vérification invalide", { timeout: 30_000 });
  await authCard(page).getByRole("button", { name: "Annuler" }).click();
  await expectLoginScreen(page);

  // --- 2FA obligatoire : confirmation explicite + ré-authentification ---------
  await loginWithTotp(page, OWNER.email, OWNER.pw, ownerMfa.secret);
  await openDrive(page);
  await driveNav(page, "Portail du propriétaire");
  await page.getByTestId("portal-tab-security").click();
  await page.getByTestId("mfa-required").check();
  await page.getByTestId("portal-save").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Imposer la vérification en deux étapes");
  await expect(page.getByTestId("mfa-confirm")).toBeDisabled(); // ni case cochée, ni code
  await page.getByTestId("mfa-ack").check();
  await page.getByTestId("mfa-proof").fill("000000");
  await page.getByTestId("mfa-confirm").click();
  await expect(dialog).toContainText("Code de vérification invalide", { timeout: 30_000 });
  await page.getByTestId("mfa-proof").fill(totpNow(ownerMfa.secret));
  await page.getByTestId("mfa-confirm").click();
  await expect(page.getByTestId("portal-msg")).toContainText("Réglages enregistrés", { timeout: 30_000 });

  // --- Autre compte : enrôlement forcé (écran clair, pas de page blanche) -----
  await logoutFromDrive(page);
  await authCard(page).getByRole("button", { name: "Créer un compte" }).click();
  await expect(page.getByTestId("activation-code")).toHaveCount(0); // Drive déjà créé : plus de code
  await authCard(page).getByPlaceholder("Prénom Nom").fill(MEMBER.name);
  await authCard(page).locator('input[type="email"]').fill(MEMBER.email);
  const mp = authCard(page).locator('input[type="password"]');
  await mp.nth(0).fill(MEMBER.pw);
  await mp.nth(1).fill(MEMBER.pw);
  await authCard(page).getByRole("button", { name: "Créer le compte" }).click();
  const gate = page.getByTestId("mfa-enrollment-gate");
  await expect(gate).toContainText("Activez la vérification en deux étapes", { timeout: 90_000 });
  await expect(page.getByText("Votre espace de travail documentaire")).toHaveCount(0);
  const memberMfa = await enrollTotp(page);
  await expectHome(page);

  // --- Le propriétaire réinitialise le mot de passe du membre ----------------
  await openDrive(page);
  await page.getByTitle("Se déconnecter").click();
  await expectLoginScreen(page);
  await loginWithTotp(page, OWNER.email, OWNER.pw, ownerMfa.secret);
  await openDrive(page);
  await driveNav(page, "Portail du propriétaire");
  await page.getByTestId("portal-tab-users").click();
  await page.getByTestId(`reset-${MEMBER.email}`).click();
  await expect(page.getByRole("dialog")).toContainText("ne sont pas lisibles");
  await page.getByTestId("reset-confirm").click();
  const link = await page.getByTestId("reset-link").inputValue();
  expect(link).toContain("?reset=");
  await page.getByRole("button", { name: "Fermer" }).first().click();

  await page.goto(link);
  await expect(page.getByTestId("reset-page")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("reset-pw").fill(MEMBER.pw2);
  await page.getByTestId("reset-pw2").fill(MEMBER.pw2);
  await page.getByTestId("reset-submit").click();
  await expect(page.getByTestId("reset-done")).toBeVisible({ timeout: 90_000 });
  // Lien à usage unique : le rouvrir affiche une erreur claire, pas une page blanche.
  await page.goto(link);
  await expect(page.getByTestId("reset-invalid")).toContainText("invalide", { timeout: 30_000 });
  await page.getByRole("button", { name: "Retour à la connexion" }).click();
  // Ce navigateur garde la session verrouillée du propriétaire : on passe à un autre compte.
  await page.getByRole("button", { name: "Se connecter avec un autre compte" }).click();
  await expectLoginScreen(page);
  // L'ancien mot de passe ne marche plus ; le nouveau + sa 2FA oui.
  await login(page, MEMBER.email, MEMBER.pw);
  await expect(authCard(page).locator(".dc-error")).toContainText("incorrect", { timeout: 90_000 });
  await loginWithTotp(page, MEMBER.email, MEMBER.pw2, memberMfa.secret);

  // --- Compte suspendu : message clair, pas d'écran vide ---------------------
  await openDrive(page);
  await page.getByTitle("Se déconnecter").click();
  await loginWithTotp(page, OWNER.email, OWNER.pw, ownerMfa.secret);
  await openDrive(page);
  await driveNav(page, "Portail du propriétaire");
  await page.getByTestId("portal-tab-users").click();
  await page
    .getByTestId(`user-row-${MEMBER.email}`)
    .getByRole("button", { name: /Suspendre/ })
    .click();
  await expect(page.getByTestId(`user-row-${MEMBER.email}`)).toContainText("suspendu");
  await logoutFromDrive(page);
  await login(page, MEMBER.email, MEMBER.pw2);
  await expect(authCard(page).locator(".dc-error")).toContainText("incorrect", { timeout: 90_000 });
  await expect(authCard(page).locator('input[type="email"]')).toBeVisible(); // on peut réessayer
});
