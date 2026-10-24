import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { strFromU8, unzipSync } from "fflate";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Application Windows de bout en bout : VRAI lanceur Python (installer/elium_launcher.py, mode serveur
 * seul) + VRAI navigateur. Vérifie le miroir de fichiers (Documents\Elium) : contenu créé dans tous les
 * modules → fichiers sur disque → profil du navigateur effacé OU port changé → restauration automatique
 * identique, sans fenêtre ; conflit de dates ; sécurité de l'API loopback.
 * Les modules sont semés par le code source servi par Vite (routé vers l'origine du lanceur : mêmes
 * bases IndexedDB que l'application servie par le lanceur depuis `dist/`).
 * Prérequis : `npm run build` (dist/). Lancer : `npm run test:e2e:winapp`.
 */

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LAUNCHER = resolve(WEB, "..", "installer", "elium_launcher.py");
const DEV = `http://localhost:${Number(process.env.WINAPP_DEV_PORT ?? 3421)}`;
// Chemin ABSOLU de l'interpréteur, résolu avant d'isoler LOCALAPPDATA (sinon le « python » de Windows en réinstalle un).
const PY = execFileSync(process.env.PYTHON ?? "python", ["-c", "import sys;print(sys.executable)"], {
  encoding: "utf8",
}).trim();

interface Launcher {
  port: number;
  origin: string;
  files: string;
  stop(): Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Démarre le lanceur sur un port dédié, avec un LocalAppData et un dossier de fichiers isolés. */
async function startLauncher(root: string, port: number, extraEnv: Record<string, string> = {}): Promise<Launcher> {
  const la = join(root, "LocalAppData");
  const files = join(root, "Elium");
  mkdirSync(join(la, "Elium"), { recursive: true });
  writeFileSync(join(la, "Elium", "launcher-config.json"), JSON.stringify({ port, files_dir: files }));
  const proc: ChildProcess = spawn(PY, ["-I", LAUNCHER], {
    env: {
      ...process.env,
      LOCALAPPDATA: la,
      LocalAppData: la,
      ELIUM_NO_BROWSER: "1",
      ELIUM_NO_UPDATE: "1",
      ELIUM_WEB_DIR: join(WEB, "dist"),
      PYTHONIOENCODING: "utf-8",
      ...extraEnv,
    },
    stdio: "ignore",
    windowsHide: true,
  });
  const origin = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(origin + "/")).ok) break;
    } catch {
      /* pas encore prêt */
    }
    await sleep(200);
  }
  return {
    port,
    origin,
    files,
    async stop() {
      if (proc.exitCode === null && proc.pid) {
        // Terminaison par PID (Windows : arbre complet) ; jamais de kill global.
        await new Promise<void>((res) => {
          const k = spawn("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
          k.on("exit", () => res());
          k.on("error", () => res());
        });
      }
    },
  };
}

/** Contexte navigateur VIERGE sur l'origine du lanceur ; le code source de Vite est servi à sa place. */
async function freshContext(browser: Browser, launcher: Launcher): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext();
  await ctx.route(
    (url) => url.origin === launcher.origin && /^\/(src|node_modules|@vite|@id|@fs|@react-refresh)/.test(url.pathname),
    async (route) => {
      const u = new URL(route.request().url());
      const r = await route.fetch({ url: DEV + u.pathname + u.search });
      await route.fulfill({ response: r });
    },
  );
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    delete w.showSaveFilePicker;
    delete w.showOpenFilePicker;
  });
  return { ctx, page };
}

async function expectHome(page: Page) {
  await expect(page.getByText("Votre espace de travail documentaire")).toBeVisible({ timeout: 60_000 });
}

/** Tous les fichiers sous la racine du dossier (chemins logiques avec « / »). */
function tree(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string, rel: string) => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(d, e.name), p);
      else out.push(p);
    }
  };
  walk(root, "");
  return out.sort();
}

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

/** Réchauffe Vite (1re compilation des modules semés) : sinon un import dynamique peut échouer à froid. */
async function warmVite() {
  for (const m of [
    "/src/main.tsx",
    "/src/workspace/content.ts",
    "/src/workspace/extras.ts",
    "/src/workspace/drive-sync.ts",
  ]) {
    for (let i = 0; i < 40; i++) {
      try {
        if ((await fetch(DEV + m)).ok) break;
      } catch {
        /* pas encore prêt */
      }
      await sleep(500);
    }
  }
}

/** Sème le contenu (réessaie : une re-optimisation des dépendances par Vite peut interrompre un import). */
async function seed(page: Page, launcher: Launcher) {
  for (let i = 0; ; i++) {
    try {
      await blankPage(page, launcher);
      await page.evaluate(SEED);
      return;
    } catch (e) {
      if (i >= 3) throw e;
      await sleep(2000);
    }
  }
}

/** Page vierge de l'origine du lanceur : permet de semer IndexedDB AVANT que l'application ne démarre. */
async function blankPage(page: Page, launcher: Launcher) {
  await page.goto(launcher.origin + "/elium-logo.svg");
}

async function waitMirrored(launcher: Launcher, wanted: RegExp[]) {
  await expect
    .poll(() => tree(launcher.files).filter((f) => !f.startsWith(".")), { timeout: 60_000, intervals: [500] })
    .toEqual(expect.arrayContaining([]));
  await expect
    .poll(
      () => {
        const t = tree(launcher.files);
        return wanted.every((re) => t.some((f) => re.test(f)));
      },
      { timeout: 60_000, intervals: [500], message: `fichiers attendus : ${wanted.join(", ")}` },
    )
    .toBe(true);
}

const WANTED = [
  /^_elium\/catalogue\.json$/,
  /^_elium\/state\.json$/,
  /^Sauvegardes\/avant-migration-.*\.elium-workspace$/,
  /^Classeurs\/Budget 2027 \[sheet-budget\]\.classeur\.json$/,
  /^Presentations\/Revue trimestrielle \[deck-q3\]\.presentation\.json$/,
  /^PDF\/Facture \[pdf-facture\]\.pdf$/,
  /^Annexes\/brouillons\.elium-extra$/,
  /^Annexes\/versions\.elium-extra$/,
  /^Annexes\/polices\.elium-extra$/,
  /^Annexes\/passeport\.elium-extra$/,
  /^Annexes\/reglages\.json$/,
  /^Passeport\/passeport\.json$/,
];

test.describe("Application Windows — fichiers locaux", () => {
  test.describe.configure({ mode: "serial" });
  let root: string;
  let launcher: Launcher;
  let snapA: unknown;

  test.beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "elium-winapp-"));
  });
  test.afterAll(async () => {
    await launcher?.stop();
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* fichiers encore verrouillés : sans importance (dossier temporaire) */
    }
  });

  test("création dans tous les modules → fichiers sur disque (formats, noms, atomicité)", async ({ browser }) => {
    test.setTimeout(240_000);
    launcher = await startLauncher(root, Number(process.env.WINAPP_PORT ?? 3411));
    const A = await freshContext(browser, launcher);
    const a = A.page;
    // Contenu antérieur au miroir (appareil existant) : semé avant le premier démarrage de l'application.
    await warmVite();
    await seed(a, launcher);
    await a.goto(launcher.origin + "/");
    await expectHome(a);

    // Document créé à la main et enregistré (repli téléchargement : pas de sélecteur natif).
    await a.getByRole("button", { name: /^Documents? Éditeur/ }).click();
    await a.getByRole("button", { name: /Simple/ }).click();
    await expect(a.locator(".elx-ribbon")).toBeVisible();
    await a.getByLabel("Titre du document").fill("Rapport trimestriel");
    await a.getByText("Commencez à rédiger…").click({ clickCount: 3 });
    await a.keyboard.type("Contenu écrit avant l'enregistrement.");
    const dl = a.waitForEvent("download", { timeout: 60_000 });
    await a.getByRole("button", { name: "Enregistrer", exact: true }).click();
    await dl;
    await a.getByTitle("Accueil").first().click();
    await expectHome(a);

    await waitMirrored(launcher, [...WANTED, /^Documents\/Rapport trimestriel \[[^\]]+\]\.elium$/]);
    const files = tree(launcher.files);
    // Atomicité : aucun fichier temporaire ni partiel.
    // (une écriture peut encore être en cours : on attend qu'aucun temporaire ne subsiste.)
    await expect
      .poll(() => tree(launcher.files).filter((f) => f.endsWith(".tmp")), { timeout: 30_000, intervals: [300] })
      .toEqual([]);
    // Formats : le PDF est un vrai PDF, le .elium un conteneur non vide, les pièces annexes des zip.
    const pdf = readFileSync(join(launcher.files, "PDF", "Facture [pdf-facture].pdf"));
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    const doc = files.find((f) => f.startsWith("Documents/Rapport trimestriel"))!;
    expect(statSync(join(launcher.files, doc)).size).toBeGreaterThan(100);
    const extra = readFileSync(join(launcher.files, "Annexes", "brouillons.elium-extra"));
    expect(extra.subarray(0, 2).toString("latin1")).toBe("PK");
    const cat = JSON.parse(readFileSync(join(launcher.files, "_elium", "catalogue.json"), "utf8")) as {
      items: { id: string; file: string; trashedAt?: string }[];
    };
    expect(cat.items.map((i) => i.id)).toEqual(expect.arrayContaining(["sheet-budget", "deck-q3", "pdf-facture"]));

    snapA = await a.evaluate(SNAPSHOT);
    expect((snapA as { items: unknown[] }).items.length).toBeGreaterThanOrEqual(5);
    await A.ctx.close();
  });

  test("navigateur VIERGE (même port) : tout revient seul, sans fenêtre", async ({ browser }) => {
    test.setTimeout(240_000);
    const B = await freshContext(browser, launcher);
    const b = B.page;
    await b.goto(launcher.origin + "/");
    await expectHome(b);
    await expect
      .poll(async () => ((await b.evaluate(SNAPSHOT)) as { items: unknown[] }).items.length, { timeout: 60_000 })
      .toBeGreaterThanOrEqual(5);
    await expect(b.getByRole("dialog")).toHaveCount(0);
    await expect.poll(() => b.evaluate(SNAPSHOT), { timeout: 60_000, intervals: [1000] }).toEqual(snapA);
    await B.ctx.close();
  });

  test("port changé (autre origine) : mêmes fichiers, même restauration", async ({ browser }) => {
    test.setTimeout(240_000);
    await launcher.stop();
    launcher = await startLauncher(root, Number(process.env.WINAPP_PORT2 ?? 3412));
    const C = await freshContext(browser, launcher);
    const c = C.page;
    await c.goto(launcher.origin + "/");
    await expectHome(c);
    await expect
      .poll(async () => ((await c.evaluate(SNAPSHOT)) as { items: unknown[] }).items.length, { timeout: 60_000 })
      .toBeGreaterThanOrEqual(5);
    await expect(c.getByRole("dialog")).toHaveCount(0);
    await expect.poll(() => c.evaluate(SNAPSHOT), { timeout: 60_000, intervals: [1000] }).toEqual(snapA);
    await C.ctx.close();
  });

  test("conflit : le plus récent gagne, rien d'écrasé en silence, aucune fenêtre", async ({ browser }) => {
    test.setTimeout(240_000);
    const D = await freshContext(browser, launcher);
    const d = D.page;
    await blankPage(d, launcher);
    await d.evaluate(async () => {
      const { putDraft } = await import("/src/format/drafts-store.ts");
      const { DEFAULT_PAGE } = await import("/src/format/document.ts");
      const para = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
      // Plus récent que le fichier (20 oct.) : doit rester ; autre brouillon, absent du fichier : doit rester.
      await putDraft({
        id: "brouillon-1",
        title: "Brouillon local récent",
        profile: "standard",
        updatedAt: "2026-10-22T10:00:00.000Z",
        doc: { type: "doc", content: [para("LOCAL-RECENT")] },
        page: DEFAULT_PAGE,
        size: 10,
      } as never);
      await putDraft({
        id: "brouillon-local",
        title: "Brouillon propre à cet appareil",
        profile: "standard",
        updatedAt: "2026-10-22T11:00:00.000Z",
        doc: { type: "doc", content: [para("SEULEMENT-ICI")] },
        page: DEFAULT_PAGE,
        size: 10,
      } as never);
    });
    await d.goto(launcher.origin + "/");
    await expectHome(d);
    await expect(d.getByRole("dialog")).toHaveCount(0);
    const drafts = async () =>
      d.evaluate(async () => {
        const m = await import("/src/format/drafts-store.ts");
        const all = await m.listDrafts();
        const out: Record<string, string> = {};
        for (const e of all) out[e.id] = e.title;
        return out;
      });
    await expect.poll(drafts, { timeout: 60_000 }).toMatchObject({
      "brouillon-1": "Brouillon local récent", // local plus récent que le fichier : conservé
      "brouillon-local": "Brouillon propre à cet appareil",
    });
    // Le fichier est ensuite réécrit FUSIONNÉ : brouillon local récent + brouillon propre à l'appareil,
    // et la version plus ancienne du fichier a cédé la place (jamais l'inverse).
    const draftsInFile = () => {
      const z = unzipSync(new Uint8Array(readFileSync(join(launcher.files, "Annexes", "brouillons.elium-extra"))));
      return Object.entries(z)
        .filter(([n]) => n.startsWith("s/drafts/"))
        .map(([, v]) => strFromU8(v))
        .join(" ");
    };
    await expect.poll(draftsInFile, { timeout: 60_000, intervals: [500] }).toContain("SEULEMENT-ICI");
    expect(draftsInFile()).toContain("LOCAL-RECENT");
    expect(draftsInFile()).not.toContain("Des heures de frappe sans Ctrl+S");
    await D.ctx.close();
  });
});

test.describe("API loopback — sécurité", () => {
  let root: string;
  let launcher: Launcher;
  let token: string;

  test.beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "elium-winapp-sec-"));
    launcher = await startLauncher(root, Number(process.env.WINAPP_PORT3 ?? 3413));
    const html = await (await fetch(launcher.origin + "/")).text();
    token = /name="elium-token" content="([^"]+)"/.exec(html)![1]!;
  });
  test.afterAll(async () => {
    await launcher?.stop();
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* dossier temporaire */
    }
  });

  const call = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
    fetch(launcher.origin + path, { ...init, headers: { Origin: launcher.origin, ...(init.headers ?? {}) } });

  test("jeton, origine, traversée de chemin", async () => {
    expect((await call("/__files__/list")).status).toBe(403); // pas de jeton
    expect((await call("/__files__/list", { headers: { "X-Elium-Token": "faux" } })).status).toBe(403);
    expect(
      (await call("/__files__/list", { headers: { "X-Elium-Token": token, Origin: "http://evil.test" } })).status,
    ).toBe(403);
    const ok = await call("/__files__/list", { headers: { "X-Elium-Token": token } });
    expect(ok.status).toBe(200);
    const h = { "X-Elium-Token": token };
    for (const p of [
      "../x.elium",
      "Documents/..%2F..%2Fx.elium",
      "Documents/x.exe",
      "C%3A%2Fx.elium",
      "Documents/CON.elium",
    ]) {
      expect((await call(`/__files__/write?p=${p}`, { method: "POST", headers: h, body: "x" })).status, p).toBe(400);
      expect((await call(`/__files__/read?p=${p}`, { headers: h })).status, p).toBe(400);
    }
    expect(existsSync(join(root, "x.elium"))).toBe(false);
  });

  test("une autre page web (autre origine) ne peut ni lire ni écrire", async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(DEV + "/");
    const r = await page.evaluate(async (origin) => {
      const out: Record<string, string> = {};
      try {
        await fetch(origin + "/__files__/list", { headers: { "X-Elium-Token": "deviné" } });
        out.read = "réponse lisible";
      } catch {
        out.read = "bloqué";
      }
      try {
        await fetch(origin + "/__files__/write?p=Documents/pirate.elium", {
          method: "POST",
          mode: "no-cors",
          headers: { "Content-Type": "text/plain" },
          body: "pirate",
        });
      } catch {
        /* peut échouer ou non : seul le disque compte */
      }
      return out;
    }, launcher.origin);
    expect(r.read).toBe("bloqué");
    await sleep(500);
    expect(tree(launcher.files).some((f) => f.includes("pirate"))).toBe(false);
    await ctx.close();
  });

  test("Drive : l'origine du serveur saisie est autorisée par la CSP (et seulement elle)", async ({ browser }) => {
    test.setTimeout(120_000);
    await warmVite();
    const A = await freshContext(browser, launcher);
    const a = A.page;
    await a.goto(launcher.origin + "/elium-logo.svg");
    await a.evaluate(() => localStorage.setItem("elium_drive_api_base", "https://drive.example.com/api"));
    const first = await a.goto(launcher.origin + "/");
    expect(first!.headers()["content-security-policy"]).toContain("connect-src 'self' data: blob:;");
    await expectHome(a);
    // Le lanceur a reçu l'origine ; la page s'est rechargée une fois et la CSP la contient désormais.
    await expect
      .poll(async () => (await (await fetch(launcher.origin + "/__drive_origin__")).json()).origin, { timeout: 30_000 })
      .toBe("https://drive.example.com");
    const second = await a.goto(launcher.origin + "/");
    const csp = second!.headers()["content-security-policy"]!;
    expect(csp).toContain("connect-src 'self' data: blob: https://drive.example.com wss://drive.example.com;");
    expect(csp).not.toContain("unsafe-inline");
    // Une origine hors règles est refusée par le lanceur.
    const bad = await fetch(launcher.origin + "/__drive_origin__", {
      method: "POST",
      headers: { "X-Elium-Token": token, Origin: launcher.origin },
      body: JSON.stringify({ origin: "http://drive.example.com" }),
    });
    expect(bad.status).toBe(400);
    await A.ctx.close();
  });
});
