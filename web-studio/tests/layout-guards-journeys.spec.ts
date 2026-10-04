import { test, expect, type Page } from "@playwright/test";

/**
 * Gardes de mise en page de la COQUE et des écrans transverses (audit visuel) :
 * accueil, réglages, Détecteur, Documentation, écran de connexion du Drive, à
 * quatre largeurs (1440 / 1024 / 768 / 390). Pour chacun on affirme :
 *   (a) aucun débordement horizontal de la page ;
 *   (b) aucun texte coupé visible (ellipsis / overflow:hidden sur une feuille de texte) ;
 *   (c) toutes les cibles cliquables font au moins 24 px (liste blanche motivée).
 * Les mesures reprennent la logique de tests/_atlas/atlas.spec.ts.txt. Les écrans
 * des éditeurs (Documents, Tableur, PDF, Présentations) ne sont pas couverts ici.
 */
test.use({ actionTimeout: 4000 });

const WIDTHS = [
  { w: 1440, h: 900 },
  { w: 1024, h: 768 },
  { w: 768, h: 1024 },
  { w: 390, h: 844 },
];

type Metrics = { overflow: string[]; clipped: string[]; small: string[] };

/** Exécuté dans la page. Retourne les violations, chacune décrite en une ligne. */
const measure = (): Metrics => {
  const out: Metrics = { overflow: [], clipped: [], small: [] };
  const vw = window.innerWidth;
  const doc = document.documentElement;
  if (doc.scrollWidth > vw + 1) out.overflow.push(`page ${doc.scrollWidth}px > fenêtre ${vw}px`);

  const visible = (e: Element) => {
    const r = e.getBoundingClientRect();
    const cs = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none" && cs.opacity !== "0";
  };
  const name = (e: Element) =>
    e.tagName.toLowerCase() +
    "." +
    String((e as HTMLElement).className || "")
      .split(/\s+/)
      .slice(0, 3)
      .join(".");

  for (const e of Array.from(document.querySelectorAll("body *"))) {
    const el = e as HTMLElement;
    if (!visible(el)) continue;
    // Texte réservé aux lecteurs d'écran : invisible par construction.
    if (el.closest(".sr-only, .visually-hidden")) continue;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);

    // (b) texte coupé : une feuille de texte plus large que sa boîte, masquée.
    if (
      el.scrollWidth > el.clientWidth + 2 &&
      (cs.overflowX === "hidden" || cs.textOverflow === "ellipsis") &&
      el.children.length === 0 &&
      (el.textContent ?? "").trim().length > 1
    ) {
      out.clipped.push(
        `${name(el)} « ${(el.textContent ?? "").trim().slice(0, 40)} » (${el.scrollWidth}>${el.clientWidth})`,
      );
    }

    // (c) cibles interactives < 24 px (WCAG 2.2 AA, 2.5.8).
    if (/^(button|a|select|input|textarea)$/i.test(el.tagName)) {
      const input = el as HTMLInputElement;
      if (input.type === "hidden" || r.width <= 4) continue;
      // Liste blanche : une case / un bouton radio natif dans un <label> n'est pas
      // la cible — c'est le libellé entier (>= 28 px de haut) qui reçoit le clic.
      if ((input.type === "checkbox" || input.type === "radio") && el.closest("label")) continue;
      // Lien « en ligne » dans un paragraphe : exception de la norme (cible en ligne).
      if (el.tagName === "A" && el.closest("p, li, td, th, .doc-content")) continue;
      if (r.width < 24 || r.height < 24) {
        out.small.push(
          `${name(el)} ${Math.round(r.width)}×${Math.round(r.height)} « ${(el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 30)} »`,
        );
      }
    }
  }
  return out;
};

async function expectClean(page: Page, label: string) {
  await page.waitForTimeout(250);
  const m = await page.evaluate(measure);
  expect(m.overflow, `${label} : débordement horizontal`).toEqual([]);
  expect(m.clipped, `${label} : texte coupé`).toEqual([]);
  expect(m.small, `${label} : cibles < 24 px`).toEqual([]);
}

async function goHome(page: Page) {
  await page.goto("/");
  await page.getByRole("heading", { level: 1 }).first().waitFor();
}

for (const { w, h } of WIDTHS) {
  for (const scheme of ["light", "dark"] as const) {
    // Le thème sombre est vérifié aux deux extrêmes seulement (bureau / mobile).
    if (scheme === "dark" && w !== 1440 && w !== 390) continue;

    test.describe(`${w}px ${scheme}`, () => {
      test.use({ viewport: { width: w, height: h }, colorScheme: scheme });

      test("accueil", async ({ page }) => {
        await goHome(page);
        await expectClean(page, "accueil");
      });

      test("espace de travail et palette de commandes", async ({ page }) => {
        for (const label of ["Mon espace", "Favoris", "Récents", "Recherche", "Corbeille"]) {
          await goHome(page);
          await page.getByRole("button", { name: label, exact: true }).first().click();
          await expectClean(page, `espace › ${label}`);
        }
        await goHome(page);
        await page.getByRole("button", { name: "Palette de commandes" }).click();
        await expectClean(page, "palette de commandes");
      });

      test("réglages (10 catégories)", async ({ page }) => {
        await goHome(page);
        await page.getByRole("button", { name: "Paramètres" }).click();
        const cats = [
          "Général",
          "Apparence",
          "Édition",
          "Polices",
          "Raccourcis",
          "Espace de travail",
          "Sécurité & clés",
          "Mises à jour & version",
          "Confidentialité & données",
          "À propos",
        ];
        for (const c of cats) {
          await page.locator(".modal-overlay").getByRole("button", { name: c, exact: true }).click();
          await expectClean(page, `réglages › ${c}`);
        }
      });

      test("Détecteur", async ({ page }) => {
        await goHome(page);
        await page.getByRole("button", { name: /^Détecteur/ }).click();
        await page.getByRole("heading", { name: "Détecteur", level: 1 }).waitFor();
        await expectClean(page, "détecteur");
        await page.locator("summary", { hasText: "Racines de confiance C2PA" }).click();
        await expectClean(page, "détecteur › racines de confiance");
      });

      test("Documentation", async ({ page }) => {
        await goHome(page);
        await page.getByRole("button", { name: "Documentation" }).click();
        await page.getByRole("heading", { level: 1 }).first().waitFor();
        await expectClean(page, "documentation");
        if (w <= 860) {
          // Sous 860 px le sommaire est un tiroir ouvert depuis la barre du haut.
          await page.getByRole("button", { name: "Sommaire" }).click();
          await expectClean(page, "documentation › tiroir");
        }
        // Le code inline des titres et du sommaire ne montre pas ses accents graves.
        const withTicks = await page.evaluate(() =>
          Array.from(document.querySelectorAll(".doc-content :is(h1,h2,h3,h4), .doc-toc"))
            .filter((e) => (e.textContent ?? "").includes("`"))
            .map((e) => (e.textContent ?? "").slice(0, 60)),
        );
        expect(withTicks, "accents graves visibles").toEqual([]);
      });

      test("Drive : écran de connexion", async ({ page }) => {
        await goHome(page);
        await page.getByRole("button", { name: /Drive entreprise chiffré/ }).click();
        await page.locator(".dc-auth").waitFor({ timeout: 30_000 });
        await expectClean(page, "drive › connexion");
      });
    });
  }
}
