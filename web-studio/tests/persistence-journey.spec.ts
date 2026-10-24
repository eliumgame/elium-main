import { test, expect, type Browser, type Page } from "@playwright/test";

/**
 * Persistance de bout en bout (vrai navigateur, vrai serveur Drive) — « aucun travail ne se perd » :
 *  1. un utilisateur crée un compte, puis du contenu dans TOUS les modules (document enregistré,
 *     tableur, présentation, PDF, brouillon non enregistré, historique de versions, police, passeport,
 *     dossier, favori, étiquette, corbeille, réglages) ;
 *  2. « Enregistrer » avec un disque qui REFUSE l'écriture (createWritable : NotAllowedError, le bug
 *     constaté en production) ne perd rien : message français, document en bibliothèque et dans le Drive ;
 *  3. la sauvegarde incrémentale part seule dans le Drive ;
 *  4. un navigateur VIERGE (nouveau contexte) se reconnecte : la restauration est proposée, appliquée,
 *     et l'espace est identique octet pour octet ;
 *  5. aucune tâche > 100 ms n'est introduite par la sauvegarde (Long Tasks API, après le chargement).
 * Lancer : `npm run test:e2e:persistence`.
 */

const OWNER = { name: "Propriétaire", email: "owner@example.test", pw: "Motdepasse!42-Owner" };
const MEMBER = { name: "Membre", email: "membre@example.test", pw: "Motdepasse!42-Membre" };
/** Compte utilisé par le parcours en cours (propriétaire, puis simple membre). */
let WHO = OWNER;
const ACTIVATION = "AAAA-BBBB-CCCC";
const authCard = (page: Page) => page.locator(".dc-auth__card");

async function expectHome(page: Page) {
  await expect(page.getByText("Votre espace de travail documentaire")).toBeVisible({ timeout: 120_000 });
}

/** Mesure les tâches longues (> 50 ms par définition de l'API ; on retient celles > 100 ms). */
async function watchLongTasks(page: Page) {
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
const longTasks = (page: Page) => page.evaluate(() => (window as unknown as { __long?: number[] }).__long ?? []);

/** Code exécuté DANS la page : relève tout l'espace utilisateur sous une forme comparable. */
const SNAPSHOT = async () => {
  const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
  const sha = async (u: Uint8Array) => hex(await crypto.subtle.digest("SHA-256", u as BufferSource));
  const { createWorkspaceService, createContentIO } = await import("/src/workspace/content.ts");
  const { EXTRA_PIECES, dumpExtra } = await import("/src/workspace/extras.ts");
  const { SYNC_SETTINGS_KEYS } = await import("/src/workspace/drive-sync.ts");
  const { catalog } = createWorkspaceService(
    () => undefined,
    () => null,
  );
  const io = createContentIO(() => undefined);
  const { items, folders } = await catalog.load();
  const outItems: unknown[] = [];
  for (const it of [...items].sort((a, b) => a.id.localeCompare(b.id))) {
    const bytes = await io[it.contentStore].read(it);
    outItems.push({
      id: it.id,
      title: it.title,
      kind: it.kind,
      folderId: it.folderId,
      starred: it.starred,
      tags: it.tags,
      trashed: !!it.trashedAt,
      hash: bytes ? await sha(bytes) : null,
    });
  }
  const canon = async (v: unknown): Promise<unknown> => {
    if (v instanceof Uint8Array) return { u8: await sha(v) };
    if (Array.isArray(v)) return Promise.all(v.map(canon));
    if (v && typeof v === "object") {
      const o: Record<string, unknown> = {};
      for (const k of Object.keys(v).sort()) o[k] = await canon((v as Record<string, unknown>)[k]);
      return o;
    }
    return v;
  };
  const extras: Record<string, unknown> = {};
  for (const p of EXTRA_PIECES) {
    const dump = await dumpExtra(p);
    for (const [store, list] of Object.entries(dump)) {
      const cleaned = await canon(list.map((r) => (store === "versions" ? { ...(r as object), id: 0 } : r)));
      extras[`${p.piece}/${store}`] = (cleaned as unknown[]).map((x) => JSON.stringify(x)).sort();
    }
  }
  const settings: Record<string, string | null> = {};
  for (const k of SYNC_SETTINGS_KEYS) settings[k] = localStorage.getItem(k);
  return {
    items: outItems,
    folders: folders.map((f) => ({ id: f.id, name: f.name })).sort((a, b) => a.id.localeCompare(b.id)),
    extras,
    settings,
  };
};

/** Contenu semé directement dans les magasins du navigateur (mêmes modules que l'application). */
const SEED = async () => {
  const T = "2026-10-20T10:00:00.000Z";
  const enc = (s: string) => new TextEncoder().encode(s);
  const { createWorkspaceService } = await import("/src/workspace/content.ts");
  const { service, catalog } = createWorkspaceService(
    () => undefined,
    () => null,
  );
  const { sheetStore } = await import("/src/sheet/sheet-store.ts");
  const { deckStore } = await import("/src/slides/deck-store.ts");
  const { pdfStore } = await import("/src/workspace/pdf-store.ts");
  const { emptyWorkbook } = await import("/src/sheet/model.ts");
  const { emptyDeck } = await import("/src/slides/model.ts");
  const { putDraft } = await import("/src/format/drafts-store.ts");
  const { saveVersion } = await import("/src/format/versions-store.ts");
  const { savePassport } = await import("/src/passport/store.ts");
  const { emptyPassport } = await import("/src/passport/model.ts");
  const { DEFAULT_PAGE } = await import("/src/format/document.ts");

  const folder = await catalog.putFolder({
    id: "dossier-compta",
    parentId: null,
    name: "Comptabilité",
    createdAt: T,
    vaultProtected: false,
  });
  void folder;
  const wb = emptyWorkbook();
  wb.sheets[0]!.cells["A1"] = "Budget 2027";
  wb.sheets[0]!.cells["B2"] = "42";
  await sheetStore.save("sheet-budget", wb, undefined, T);
  await service.registerSaved({ id: "sheet-budget", kind: "sheet", title: "Budget 2027", size: 100 });
  const deck = emptyDeck();
  await deckStore.save("deck-q3", deck, undefined, T);
  await service.registerSaved({ id: "deck-q3", kind: "slides", title: "Revue trimestrielle", size: 100 });
  const pdf = enc(
    "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
  );
  await pdfStore.put({ id: "pdf-facture", name: "Facture.pdf", bytes: pdf }, undefined, T);
  await service.registerSaved({ id: "pdf-facture", kind: "pdf", title: "Facture", size: pdf.length });
  await catalog.patchItems(["sheet-budget"], { folderId: "dossier-compta", starred: true });
  await catalog.patchItems(["deck-q3"], { tags: ["direction", "trimestre"] });
  await service.registerSaved({ id: "pdf-vieux", kind: "pdf", title: "Ancien contrat", size: 4 });
  await pdfStore.put({ id: "pdf-vieux", name: "Ancien contrat.pdf", bytes: enc("%PDF-vieux") }, undefined, T);
  await catalog.patchItems(["pdf-vieux"], { trashedAt: T });

  // Brouillon non enregistré, historique de versions, passeport, police, réglages.
  const para = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
  await putDraft({
    id: "brouillon-1",
    title: "Brouillon jamais enregistré",
    profile: "standard",
    updatedAt: T,
    doc: { type: "doc", content: [para("Des heures de frappe sans Ctrl+S")] },
    page: DEFAULT_PAGE,
    size: 40,
  });
  await saveVersion("doc-historique", "Version 1", { type: "doc", content: [para("v1")] }, T);
  await saveVersion("doc-historique", "Version 2", { type: "doc", content: [para("v2")] }, "2026-10-20T11:00:00.000Z");
  const pass = emptyPassport(T);
  pass.holder.nom = "Dupont";
  await savePassport(pass);
  await new Promise<void>((res, rej) => {
    const r = indexedDB.open("elium-fonts", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("fonts", { keyPath: "name" });
    r.onsuccess = () => {
      const tx = r.result.transaction("fonts", "readwrite");
      tx.objectStore("fonts").put({
        name: "Police test",
        filename: "Police test.ttf",
        size: 5,
        addedAt: T,
        source: "fichier",
        bytes: new Uint8Array([0, 1, 0, 0, 7]),
      });
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    };
  });
  const { saveMark } = await import("/src/pdf/ui/identities.ts");
  await saveMark({
    id: "marque-1",
    kind: "signature",
    createdAt: T,
    name: "Ma signature",
    dataUrl: "data:image/png;base64,AAAA",
  } as never);
  localStorage.setItem("elium-detector-search-provider", "bing");
  localStorage.setItem("elium-detector-disabled-signals", JSON.stringify(["x"]));
  const { markDirty } = await import("/src/workspace/sync-dirty.ts");
  markDirty("polices");
  localStorage.setItem("elium.citation.style", "apa");
  localStorage.setItem("elium.bibliography.sources.v1", JSON.stringify([{ id: "s1", title: "Source test" }]));
};

async function register(page: Page, createOrg: boolean) {
  await page.goto("/");
  await expect(authCard(page).getByRole("button", { name: "Connexion" })).toBeVisible({ timeout: 60_000 });
  await authCard(page).getByRole("button", { name: "Créer un compte" }).click();
  await authCard(page).getByPlaceholder("Prénom Nom").fill(WHO.name);
  const code = page.getByTestId("activation-code");
  if (await code.isVisible({ timeout: 5_000 }).catch(() => false)) await code.fill(ACTIVATION);
  await authCard(page).locator('input[type="email"]').fill(WHO.email);
  const pws = authCard(page).locator('input[type="password"]');
  await pws.nth(0).fill(WHO.pw);
  await pws.nth(1).fill(WHO.pw);
  await authCard(page).getByRole("button", { name: "Créer le compte" }).click();
  await expectHome(page);
  if (!createOrg) return;
  await page.getByText("Drive entreprise chiffré").first().click();
  await expect(page.locator(".dc-app")).toBeVisible({ timeout: 60_000 });
  await page.getByPlaceholder("Ma société").fill("Demo SARL");
  await page.getByRole("button", { name: "Créer l'organisation" }).click();
  await expect(page.locator(".dc-nav").getByRole("button", { name: "Portail du propriétaire" })).toBeVisible({
    timeout: 60_000,
  });
}

async function unlockOrLogin(page: Page) {
  const locked = page.getByRole("heading", { name: "Session verrouillée" });
  const login = authCard(page).getByRole("button", { name: "Connexion" });
  await expect(locked.or(login)).toBeVisible({ timeout: 60_000 });
  if (await locked.isVisible()) {
    await authCard(page).locator('input[type="password"]').fill(WHO.pw);
    await authCard(page).getByRole("button", { name: "Déverrouiller" }).click();
  } else {
    await authCard(page).locator('input[type="email"]').fill(WHO.email);
    await authCard(page).locator('input[type="password"]').first().fill(WHO.pw);
    await authCard(page).locator("form button.eb--primary").first().click();
  }
  await expectHome(page);
}

async function syncStatus(page: Page) {
  return page.evaluate(async () => {
    const m = await import("/src/workspace/sync-controller.ts");
    const s = m.getSyncStatus();
    return { phase: s.phase, pending: s.pending, lastOkAt: s.lastOkAt ?? null, message: s.message ?? null };
  });
}
/** Attend que tout soit parti dans le Drive : à jour, rien en attente, et un envoi réussi après `since`. */
async function waitSynced(page: Page, since: string) {
  await expect
    .poll(
      async () => {
        const s = await syncStatus(page);
        return s.phase === "idle" && s.pending === 0 && !!s.lastOkAt && s.lastOkAt >= since;
      },
      { timeout: 180_000, intervals: [1000] },
    )
    .toBe(true);
}

async function freshContext(browser: Browser) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  // Le sélecteur de fichier natif n'est pas pilotable : un disque qui refuse l'écriture, comme en production.
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).showSaveFilePicker = async () => ({
      kind: "file",
      name: "Rapport.elium",
      createWritable: async () => {
        throw new DOMException(
          "Failed to execute 'createWritable' on 'FileSystemFileHandle': The request is not allowed by the user agent or the platform in the current context.",
          "NotAllowedError",
        );
      },
    });
  });
  return { ctx, page };
}

async function journey(browser: Browser, createOrg: boolean) {
  // ----- Appareil A -----
  const A = await freshContext(browser);
  const a = A.page;
  await register(a, createOrg);

  // Contenu semé dans tous les modules, puis rechargement (l'application relit ses magasins).
  await a.goto("/");
  await unlockOrLogin(a);
  await a.evaluate(SEED);
  // Comme un brouillon créé AVANT la mise à jour : aucune pièce signalée « modifiée », elles doivent partir quand même.
  await a.evaluate(() => localStorage.removeItem("elium_sync_dirty_v1"));
  await a.reload();
  await unlockOrLogin(a);
  await watchLongTasks(a);

  // Document créé à la main, ENREGISTRÉ alors que le disque refuse l'écriture (bug de production).
  await a.getByRole("button", { name: /^Documents? Éditeur/ }).click();
  await a.getByRole("button", { name: /Simple/ }).click();
  await expect(a.locator(".elx-ribbon")).toBeVisible();
  await a.getByLabel("Titre du document").fill("Rapport trimestriel");
  await a.getByText("Commencez à rédiger…").click({ clickCount: 3 });
  await a.keyboard.type("Contenu écrit avant l'enregistrement.");
  const downloadPromise = a.waitForEvent("download", { timeout: 60_000 });
  await a.getByRole("button", { name: "Enregistrer", exact: true }).click();
  await downloadPromise; // repli : une copie est téléchargée
  const toast = a.locator(".toast");
  await expect(toast).toContainText("n'autorise pas l'écriture directe", { timeout: 60_000 });
  await expect(toast).not.toContainText("createWritable");
  await expect(a.getByText("Failed to execute")).toHaveCount(0);
  // « Enregistrer dans le Drive » : visible dans l'éditeur, envoie tout de suite.
  const driveBtn = a.getByTestId("save-to-drive");
  await expect(driveBtn).toBeVisible();
  await driveBtn.click();
  await expect(a.locator(".toast")).toContainText("Enregistré dans le Drive", { timeout: 120_000 });

  // Retour à l'accueil : la bibliothèque contient le document enregistré malgré le disque refusé.
  await a.getByTitle("Accueil").first().click();
  await expectHome(a);

  // Mesure ciblée : seule la sauvegarde (hors chargement des éditeurs en mode dev) ne doit pas bloquer l'interface.
  await watchLongTasks(a);
  const since = new Date().toISOString();
  await a.evaluate(async () => (await import("/src/workspace/sync-controller.ts")).flushNow());
  await waitSynced(a, since);
  const snapA = await a.evaluate(SNAPSHOT);
  const titles = (snapA.items as { title: string }[]).map((i) => i.title).sort();
  expect(titles).toContain("Rapport trimestriel");
  expect(titles).toContain("Budget 2027");
  expect(snapA.items).toHaveLength(5);
  expect(Object.keys(snapA.extras)).toEqual(
    expect.arrayContaining(["brouillons/drafts", "versions/versions", "polices/fonts", "passeport/passport"]),
  );
  const longA = await longTasks(a);
  const bigA = longA.filter((d) => d > 100);
  console.log(`tâches longues (A) : ${JSON.stringify(longA)}`);
  expect(bigA, `tâches > 100 ms pendant la sauvegarde : ${bigA.join(", ")}`).toEqual([]);

  // ----- Appareil B : navigateur VIERGE, même compte -----
  const B = await freshContext(browser);
  const b = B.page;
  await b.goto("/");
  await unlockOrLogin(b);
  // Appareil VIDE : restauration automatique, sans fenêtre ni clic, avec bandeau de résumé.
  const banner = b.getByTestId("restore-banner");
  await expect(banner).toContainText("restauré", { timeout: 180_000 });
  await expect(b.getByText("Une sauvegarde existe dans votre Drive")).toHaveCount(0);
  const restoredDrafts = await b.evaluate(async () => {
    const m = await import("/src/format/drafts-store.ts");
    return (await m.listDrafts()).map((d) => d.id);
  });
  expect(restoredDrafts).toContain("brouillon-1"); // brouillon antérieur, jamais signalé « modifié »
  if (await banner.getByRole("button", { name: /Recharger/ }).isVisible()) {
    await banner.getByRole("button", { name: /Recharger/ }).click();
    await unlockOrLogin(b);
  }
  const snapB = await b.evaluate(SNAPSHOT);
  expect(snapB).toEqual(snapA);

  // Après restauration, rien d'écrasé : le Drive n'est pas renvoyé en entier, et l'envoi reprend.
  const since2 = new Date().toISOString();
  await b.evaluate(async () => (await import("/src/workspace/sync-controller.ts")).flushNow());
  await waitSynced(b, since2);
  expect((await syncStatus(b)).phase).toBe("idle");

  // ----- Appareil C : NON vide et différent du Drive = vrai conflit → fenêtre, envoi en pause -----
  const C = await freshContext(browser);
  const c = C.page;
  await c.goto("/");
  await expect(authCard(c).getByRole("button", { name: "Connexion" })).toBeVisible({ timeout: 60_000 });
  await c.evaluate(async () => {
    const { createWorkspaceService } = await import("/src/workspace/content.ts");
    const { sheetStore } = await import("/src/sheet/sheet-store.ts");
    const { emptyWorkbook } = await import("/src/sheet/model.ts");
    const { service } = createWorkspaceService(
      () => undefined,
      () => null,
    );
    await sheetStore.save("sheet-local", emptyWorkbook(), undefined, "2026-10-21T10:00:00.000Z");
    await service.registerSaved({ id: "sheet-local", kind: "sheet", title: "Travail local", size: 50 });
  });
  await unlockOrLogin(c);
  await expect(c.getByRole("dialog")).toContainText("Une sauvegarde existe dans votre Drive", { timeout: 120_000 });
  expect((await syncStatus(c)).phase).toBe("needs-restore");

  await A.ctx.close();
  await B.ctx.close();
  await C.ctx.close();
}

test("propriétaire : rien ne se perd (disque refusé, sauvegarde Drive, restauration automatique)", async ({
  browser,
}) => {
  WHO = OWNER;
  await journey(browser, true);
});

test("simple membre : même parcours, même résultat", async ({ browser }) => {
  WHO = MEMBER;
  await journey(browser, false);
});
