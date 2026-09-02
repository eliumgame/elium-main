/**
 * E2E réseau réel — Tableur collaboratif (2 clients, VRAI relais WebSocket).
 *
 * Boote un VRAI PostgreSQL (embedded-postgres) et la VRAIE API Fastify, exactement
 * comme `tests/e2e-multiuser.ts`, mais se concentre UNIQUEMENT sur la feuille de
 * calcul collaborative : deux instances RÉELLES d'`EncryptedYjsProvider` (deux
 * `Y.Doc` distincts, comme deux onglets de navigateur différents) se connectent au
 * MÊME nœud `collab-sheet` par-dessus le VRAI relais WebSocket chiffré. C'est la
 * PREMIÈRE vérification de bout en bout, sur le réseau, de la co-édition du
 * Tableur — jusqu'ici seule la fusion CRDT en mémoire était testée
 * (`tests/collab-sheet-model.test.ts`), jamais le trajet réseau réel.
 *
 * Ce que ça prouve, que le test en mémoire ne peut pas prouver :
 *   - le nœud `appKind: "collab-sheet"` se crée, se partage et s'ouvre via l'API réelle ;
 *   - les mises à jour Yjs de la feuille sont vraiment chiffrées, envoyées au relais,
 *     rediffusées et déchiffrées côté pair (pas une simple fusion en mémoire) ;
 *   - une édition de cellule ET une opération STRUCTURELLE (insertion de ligne, via
 *     la même fonction pure `sheet/structural.ts` que le Tableur local) traversent
 *     le réseau et convergent chez le second client ;
 *   - le rôle (éditeur) accordé par le VRAI serveur de permissions se reflète bien
 *     dans `onReady` côté client B.
 *
 * Lancer :  npx tsx tests/e2e-collab-sheet.ts   (depuis web-studio/)
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import * as Y from "yjs";

import { DriveApi } from "../src/drive-cloud/api";
import { buildRegistration, type AccountKeys } from "../src/drive-cloud/account";
import * as ops from "../src/drive-cloud/ops";
import { EncryptedYjsProvider } from "../src/drive-cloud/collab-provider";
import { setCellText } from "../src/drive-cloud/collab-sheet-crdt";
import * as SM from "../src/drive-cloud/collab-sheet-model";
import { generateRecipientKeypair, encryptForRecipients } from "../src/crypto/recipients";
import { fromHex } from "../src/format/canonical";
import type { RoleDef } from "../src/drive-cloud/types";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dec = new TextDecoder();

/** Attend qu'une condition devienne vraie, en sondant au lieu de dormir à l'aveugle. */
async function waitFor(cond: () => boolean, timeoutMs = 5000, stepMs = 40): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return true;
    await sleep(stepMs);
  }
  return cond();
}

// --- Scorecard ---------------------------------------------------------------
let failures = 0;
let checks = 0;
function ok(name: string, cond: unknown, detail = ""): void {
  checks++;
  const pass = !!cond;
  if (!pass) failures++;
  // eslint-disable-next-line no-console
  console.log(`${pass ? "  ✓" : "  ✗ ÉCHEC"} ${name}${!pass && detail ? ` — ${detail}` : ""}`);
}
function section(title: string): void {
  // eslint-disable-next-line no-console
  console.log(`\n== ${title} ==`);
}

interface TestUser {
  api: DriveApi;
  keys: AccountKeys;
  user: {
    id: string;
    email: string;
    displayName: string;
    p256PublicHex: string;
    ed25519PublicHex: string;
    fingerprint: string;
  };
  password: string;
}

async function newUser(base: string, email: string, name: string): Promise<TestUser> {
  const api = new DriveApi({ baseUrl: base });
  const password = `Motdepasse!42-${name}`;
  const { payload, keys } = await buildRegistration(email, password, name);
  const res = await api.register(payload);
  api.setTokens({
    accessToken: res.accessToken,
    accessTokenExpiresAt: res.accessTokenExpiresAt,
    refreshToken: res.refreshToken,
  });
  return { api, keys, user: res.user, password };
}

async function main(): Promise<void> {
  const pgPort = 55000 + Math.floor(Math.random() * 900);
  const dataDir = mkdtempSync(join(tmpdir(), "elium-e2e-sheet-pg-"));
  const blobDir = mkdtempSync(join(tmpdir(), "elium-e2e-sheet-blobs-"));

  // L'environnement DOIT être posé avant l'import des modules serveur
  // (config.ts lit process.env à l'import).
  process.env.NODE_ENV = "test";
  process.env.DATABASE_URL = `postgres://elium:elium@127.0.0.1:${pgPort}/elium`;
  process.env.TOKEN_SECRET = "e2e-secret-0123456789abcdef0123456789abcdef";
  process.env.STORAGE_DRIVER = "fs";
  process.env.STORAGE_FS_ROOT = blobDir;
  process.env.CORS_ORIGINS = "http://localhost";

  section("Infrastructure");
  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "elium",
    password: "elium",
    port: pgPort,
    persistent: false,
    onLog: () => {},
    onError: () => {},
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase("elium");
  ok("PostgreSQL embarqué démarré", true);

  const { migrate } = await import("../../server/src/db/migrate");
  const { buildApp } = await import("../../server/src/app");
  const { closePool } = await import("../../server/src/db/pool");

  await migrate();

  const app = await buildApp();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = (app.server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}/api`;

  const health = await fetch(`${base}/health`);
  ok("API démarrée (/api/health)", health.ok);

  let provA: InstanceType<typeof EncryptedYjsProvider> | null = null;
  let provB: InstanceType<typeof EncryptedYjsProvider> | null = null;

  try {
    // =========================================================================
    section("Comptes + organisation (2 utilisateurs)");
    const alice = await newUser(base, "alice@acme.fr", "Alice");
    const bob = await newUser(base, "bob@acme.fr", "Bob");
    ok("inscription d'Alice et Bob", !!alice.user.id && !!bob.user.id);

    const orgKp = await generateRecipientKeypair();
    const wrappedOrgPrivate = JSON.parse(
      dec.decode(await encryptForRecipients(fromHex(orgKp.privateHex), [alice.keys.recipient.publicHex])),
    ) as Record<string, unknown>;
    const created = await alice.api.createOrg({
      name: "ACME SARL",
      slug: "acme",
      orgPublicHex: orgKp.publicHex,
      wrappedOrgPrivate,
    });
    const org = created.org;
    const roleIdByKey: Record<string, string> = Object.fromEntries(created.roles.map((r) => [r.key, r.id]));
    ok("organisation créée + rôles système", !!org.id && !!roleIdByKey["editor"]);

    const ctxA: ops.OpsCtx = {
      api: alice.api,
      keys: alice.keys,
      userId: alice.user.id,
      orgId: org.id,
      orgPublicHex: org.orgPublicHex,
      roleIdByKey,
    };

    const invite = await alice.api.invite(org.id, { email: bob.user.email, roleId: roleIdByKey["editor"]! });
    await bob.api.acceptInvite(invite.token);
    const bobRoles = (await bob.api.listRoles(org.id)).roles as RoleDef[];
    const bobRoleIdByKey: Record<string, string> = Object.fromEntries(bobRoles.map((r) => [r.key, r.id]));
    ok("Bob rejoint l'organisation", bobRoles.length >= 7);
    const ctxB: ops.OpsCtx = {
      api: bob.api,
      keys: bob.keys,
      userId: bob.user.id,
      orgId: org.id,
      orgPublicHex: org.orgPublicHex,
      roleIdByKey: bobRoleIdByKey,
    };

    // =========================================================================
    section("Tableur collaboratif — création + partage réels");
    const sheetNode = await ops.createCollabSheet(ctxA, null, "Budget partagé");
    const sheetA = (await ops.listFolder(ctxA, null)).find((e) => e.id === sheetNode.id)!;
    ok("nœud collab-sheet créé", !!sheetA);
    await ops.shareWithUser(ctxA, sheetA, bob.user as never, roleIdByKey["editor"]!);
    const sheetB = (await ops.listFolder(ctxB, null)).find((e) => e.id === sheetNode.id);
    ok("Bob voit le tableur après partage", !!sheetB);

    const keyA = await ops.nodeKeyFrom(ctxA, sheetA.myWrappedKey);
    const keyB = sheetB ? await ops.nodeKeyFrom(ctxB, sheetB.myWrappedKey) : null;
    ok("les deux clients détiennent la clé du document", !!keyA && !!keyB);

    // =========================================================================
    section("Co-édition RÉSEAU (2 clients, VRAI relais WebSocket)");
    const ydocA = new Y.Doc();
    const ydocB = new Y.Doc();
    let canWriteA: boolean | null = null;
    let canWriteB: boolean | null = null;
    provA = new EncryptedYjsProvider(
      alice.api,
      sheetNode.id,
      keyA!,
      ydocA,
      { name: "Alice", color: "#e11d48" },
      { onReady: (c) => (canWriteA = c) },
    );
    provB = new EncryptedYjsProvider(
      bob.api,
      sheetNode.id,
      keyB!,
      ydocB,
      { name: "Bob", color: "#16a34a" },
      { onReady: (c) => (canWriteB = c) },
    );
    await provA.connect();
    await provB.connect();
    // Petite stabilisation post-connexion, comme dans e2e-multiuser.ts (le
    // rejeu de l'historique + la première annonce de présence sont async).
    await sleep(500);
    ok("Alice (propriétaire) peut écrire", canWriteA === true, String(canWriteA));
    ok("Bob (éditeur, partage réel) peut écrire", canWriteB === true, String(canWriteB));

    const ySheetsA = ydocA.getArray<SM.YSheet>("sheets") as SM.YSheets;
    const ySheetsB = ydocB.getArray<SM.YSheet>("sheets") as SM.YSheets;

    // Alice initialise le classeur (comme le fait useCollabSheetStore à la
    // première ouverture) : une feuille neuve, entièrement structurée.
    ydocA.transact(() => {
      if (ySheetsA.length === 0) ySheetsA.push([SM.newYSheet("Feuille 1")]);
    });
    const sheetCreated = await waitFor(() => ySheetsB.length === 1);
    ok(
      "convergence RÉSEAU : Bob voit la feuille créée par Alice (via le relais chiffré)",
      sheetCreated,
      `ySheetsB.length=${ySheetsB.length}`,
    );

    const ysA = ySheetsA.get(0);
    const ysB = ySheetsB.get(0);

    // --- Édition de cellule : Alice pose une valeur, Bob doit converger -------
    ydocA.transact(() => {
      SM.ensureSheetStructures(ysA);
      setCellText(ysA.get("cells") as Y.Map<Y.Text | string>, "B2", "42");
    });
    const cellConverged = await waitFor(() => SM.sheetSnapshot(ysB).cells["B2"] === "42");
    ok(
      "convergence RÉSEAU A→B : la cellule B2 posée par Alice arrive chez Bob",
      cellConverged,
      JSON.stringify(SM.sheetSnapshot(ysB).cells),
    );

    // --- Édition retour : Bob pose une valeur, Alice doit converger -----------
    ydocB.transact(() => {
      SM.ensureSheetStructures(ysB);
      setCellText(ysB.get("cells") as Y.Map<Y.Text | string>, "C3", "depuis-bob");
    });
    const backConverged = await waitFor(() => SM.sheetSnapshot(ysA).cells["C3"] === "depuis-bob");
    ok(
      "convergence RÉSEAU B→A : la cellule C3 posée par Bob arrive chez Alice",
      backConverged,
      JSON.stringify(SM.sheetSnapshot(ysA).cells),
    );

    // --- Opération STRUCTURELLE réelle : insertion de ligne (sheet/structural.ts)
    // Alice insère une ligne en tête : B2 doit se décaler en B3, C3 en C4 — chez
    // les DEUX clients, la relocalisation étant calculée par la même fonction pure
    // que le Tableur local puis réconciliée dans le CRDT (SM.insertRowY).
    SM.insertRowY(ydocA, ysA, 0);
    const rowInserted = await waitFor(() => {
      const snap = SM.sheetSnapshot(ysB);
      return snap.cells["B3"] === "42" && snap.cells["C4"] === "depuis-bob" && snap.rows === 21;
    });
    ok(
      "convergence RÉSEAU : insertion de ligne (structural.ts) — Bob voit le décalage B2→B3, C3→C4",
      rowInserted,
      JSON.stringify(SM.sheetSnapshot(ysB)),
    );

    // --- Présence : Bob voit Alice dans l'awareness diffusée par le relais ----
    // Sondé comme les convergences ci-dessus (waitFor), pas une lecture unique
    // immédiate : l'awareness voyage aussi sur le VRAI relais réseau, avec la
    // même latence que les mises à jour Yjs — une lecture synchrone sans marge
    // est flaky par construction (déjà observé et diagnostiqué sur le même
    // motif dans tests/e2e-multiuser.ts, corrigé par le même principe).
    let seenByB: (string | undefined)[] = [];
    const presenceSeen = await waitFor(() => {
      seenByB = [...provB.awareness.getStates().values()]
        .map((s) => (s as { user?: { name?: string } }).user?.name)
        .filter(Boolean);
      return seenByB.includes("Alice");
    });
    ok("présence réseau : Bob voit Alice", presenceSeen, seenByB.join(","));

    // --- Convergence finale : les deux classeurs sont byte-identiques ---------
    const finalA = SM.workbookSnapshot(ySheetsA, ydocA.getMap<string>("names"), 0);
    const finalB = SM.workbookSnapshot(ySheetsB, ydocB.getMap<string>("names"), 0);
    ok(
      "les deux Y.Doc convergent vers EXACTEMENT le même classeur",
      JSON.stringify(finalA) === JSON.stringify(finalB),
      `A=${JSON.stringify(finalA)} B=${JSON.stringify(finalB)}`,
    );
  } finally {
    provA?.destroy();
    provB?.destroy();
    await app.close().catch(() => {});
    await closePool().catch(() => {});
    await pg.stop().catch(() => {});
    try {
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* verrou Windows */
    }
    try {
      rmSync(blobDir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* idem */
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    `\n=== RÉSULTAT : ${checks - failures}/${checks} vérifications réussies${failures ? ` — ${failures} ÉCHEC(S)` : " ✅"} ===`,
  );
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error("ERREUR FATALE E2E:", e);
  process.exit(1);
});
