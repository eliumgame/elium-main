/**
 * E2E multi-utilisateurs du PORTAIL DU PROPRIÉTAIRE — SANS Docker.
 *
 * Boote un vrai PostgreSQL embarqué + la vraie API Fastify (mode « un déploiement
 * = un Drive » : SINGLE_DRIVE=true, OWNER_EMAIL fixé) et pilote le vrai SDK client
 * (cryptographie comprise) comme plusieurs navigateurs. Vérifie : amorçage du
 * propriétaire, Drive unique, inscription libre → membre simple avec espace privé,
 * routes d'administration réservées au propriétaire, inscription fermée / sur
 * invitation, quotas global/par utilisateur/individuel (507), rétention des
 * versions, suspension / réactivation / changement de rôle, sessions et appareils,
 * 2FA obligatoire (enrôlement forcé) et sauvegarde obligatoire publiée.
 *
 * Lancer :  npm run test:e2e:portal   (depuis web-studio/ ; ~1-2 min, Argon2id oblige)
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";

import { DriveApi, ApiError, type SiteSettings } from "../src/drive-cloud/api";
import { buildRegistration, prepareLogin, signLoginChallenge, type AccountKeys } from "../src/drive-cloud/account";
import type { LoginResponse, RoleDef } from "../src/drive-cloud/types";
import * as ops from "../src/drive-cloud/ops";
import { generateRecipientKeypair, encryptForRecipients } from "../src/crypto/recipients";
import { fromHex } from "../src/format/canonical";
import { restoreOwnedNodes } from "../src/drive-cloud/recovery";
import type { KdfParams } from "../src/drive-cloud/kdf";

const enc = new TextEncoder();
const dec = new TextDecoder();

let failures = 0;
let checks = 0;
function ok(name: string, cond: unknown, detail = ""): void {
  checks++;
  if (!cond) failures++;
  // eslint-disable-next-line no-console
  console.log(`${cond ? "  ✓" : "  ✗ ÉCHEC"} ${name}${!cond && detail ? ` — ${detail}` : ""}`);
}
function section(title: string): void {
  // eslint-disable-next-line no-console
  console.log(`\n== ${title} ==`);
}
async function expectStatus(name: string, p: Promise<unknown>, status: number, code?: string): Promise<void> {
  try {
    await p;
    ok(name, false, `la requête aurait dû échouer (${status} attendu)`);
  } catch (e) {
    const good = e instanceof ApiError && e.status === status && (!code || e.code === code);
    ok(name, good, `reçu ${e instanceof ApiError ? `${e.status}/${e.code}` : String(e)}`);
  }
}

interface TestUser {
  api: DriveApi;
  keys: AccountKeys;
  user: { id: string; email: string; displayName: string };
  password: string;
}

async function newUser(base: string, email: string, name: string, activationCode?: string): Promise<TestUser> {
  const api = new DriveApi({ baseUrl: base });
  const password = `Motdepasse!42-${name}`;
  const { payload, keys } = await buildRegistration(email, password, name);
  const res = await api.register(payload, undefined, activationCode);
  api.setTokens({
    accessToken: res.accessToken,
    accessTokenExpiresAt: res.accessTokenExpiresAt,
    refreshToken: res.refreshToken,
  });
  return { api, keys, user: res.user, password };
}

async function login(base: string, email: string, password: string): Promise<{ api: DriveApi; res: LoginResponse }> {
  const api = new DriveApi({ baseUrl: base });
  const pre = await api.prelogin(email);
  const { authSignSeedHex } = await prepareLogin(password, pre.kdfSalt, pre.kdfParams as KdfParams);
  const { challengeId, challenge } = await api.loginInit(email);
  const res = await api.loginVerify(email, challengeId, await signLoginChallenge(challenge, authSignSeedHex));
  const r = res as { accessToken?: string; accessTokenExpiresAt?: number; refreshToken?: string };
  if (r.accessToken) {
    api.setTokens({
      accessToken: r.accessToken,
      accessTokenExpiresAt: r.accessTokenExpiresAt!,
      refreshToken: r.refreshToken!,
    });
  }
  return { api, res };
}

async function main(): Promise<void> {
  const pgPort = 54000 + Math.floor(Math.random() * 900);
  const dataDir = mkdtempSync(join(tmpdir(), "elium-portal-pg-"));
  const blobDir = mkdtempSync(join(tmpdir(), "elium-portal-blobs-"));

  process.env.NODE_ENV = "test";
  process.env.DATABASE_URL = `postgres://elium:elium@127.0.0.1:${pgPort}/elium`;
  process.env.TOKEN_SECRET = "e2e-secret-0123456789abcdef0123456789abcdef";
  process.env.STORAGE_DRIVER = "fs";
  process.env.STORAGE_FS_ROOT = blobDir;
  process.env.CORS_ORIGINS = "http://localhost";
  process.env.SINGLE_DRIVE = "true";
  process.env.OWNER_EMAIL = "boss@acme.fr";

  section("Infrastructure");
  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "elium",
    password: "elium",
    port: pgPort,
    persistent: false,
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
    onLog: () => {},
    onError: () => {},
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase("elium");

  const { migrate } = await import("../../server/src/db/migrate");
  const { buildApp } = await import("../../server/src/app");
  const { query, closePool } = await import("../../server/src/db/pool");
  const { purgeOldVersions } = await import("../../server/src/lib/housekeeping");
  const { totpNow } = await import("../../server/src/lib/totp");
  const { ensureActivationCode, resetActivationLimits } = await import("../../server/src/lib/activation");
  const { setStatfsForTests } = await import("../../server/src/lib/disk");
  const { resetOwnerAccess } = await import("../../server/src/lib/owner-access");
  await migrate();
  // Premier démarrage d'un déploiement neuf : le serveur génère le code d'activation (affiché dans ses journaux).
  const activationCode = (await ensureActivationCode())!;
  const app = await buildApp();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}/api`;
  ok("API démarrée", (await fetch(`${base}/health`)).ok);

  const anon = new DriveApi({ baseUrl: base });

  try {
    // =========================================================================
    section("Amorçage : le premier compte attendu devient propriétaire");
    const pol0 = await anon.sitePolicy();
    ok(
      "politique publique lisible sans compte, Drive pas encore créé",
      pol0?.deployed === true && pol0.bootstrapped === false && pol0.activationRequired === true,
      JSON.stringify(pol0),
    );

    const mallory = await buildRegistration("mallory@evil.fr", "Motdepasse!42-Mallory", "Mallory");
    await expectStatus(
      "un inconnu ne peut pas s'inscrire avant le propriétaire (OWNER_EMAIL)",
      anon.register(mallory.payload),
      403,
    );

    ok(
      "le code d'activation généré a le bon format (12 caractères groupés)",
      /^[A-HJKMNP-Z2-9]{4}(-[A-HJKMNP-Z2-9]{4}){2}$/.test(activationCode),
      activationCode,
    );
    const bossReg = await buildRegistration("boss@acme.fr", "Motdepasse!42-Boss", "Boss");
    await expectStatus("propriétaire attendu SANS code d'activation : refusé", anon.register(bossReg.payload), 403);
    await expectStatus(
      "propriétaire attendu avec un MAUVAIS code : refusé",
      anon.register(bossReg.payload, undefined, "AAAA-AAAA-AAAA"),
      403,
    );
    // Force brute : au bout de 5 échecs, l'adresse est bloquée (429) même avec le bon code.
    for (let i = 0; i < 3; i++) await anon.register(bossReg.payload, undefined, "BBBB-BBBB-BBBB").catch(() => {});
    await expectStatus(
      "force brute : 6e essai bloqué (429)",
      anon.register(bossReg.payload, undefined, "CCCC-CCCC-CCCC"),
      429,
    );
    await expectStatus(
      "force brute : même le bon code est bloqué pendant le verrouillage",
      anon.register(bossReg.payload, undefined, activationCode),
      429,
    );
    resetActivationLimits();
    const bossRes = await anon.register(bossReg.payload, undefined, activationCode.toLowerCase().replace(/-/g, " "));
    ok("avec le bon code (saisie tolérante : minuscules, espaces) : compte propriétaire créé", !!bossRes.user.id);
    const boss: TestUser = {
      api: new DriveApi({ baseUrl: base }),
      keys: bossReg.keys,
      user: bossRes.user,
      password: "Motdepasse!42-Boss",
    };
    boss.api.setTokens({
      accessToken: bossRes.accessToken,
      accessTokenExpiresAt: bossRes.accessTokenExpiresAt,
      refreshToken: bossRes.refreshToken,
    });
    const orgKp = await generateRecipientKeypair();
    const wrappedOrgPrivate = JSON.parse(
      dec.decode(await encryptForRecipients(fromHex(orgKp.privateHex), [boss.keys.recipient.publicHex])),
    ) as Record<string, unknown>;
    await expectStatus(
      "créer le Drive sans code d'activation : refusé",
      boss.api.createOrg({ name: "ACME", slug: "acme", orgPublicHex: orgKp.publicHex, wrappedOrgPrivate }),
      403,
    );
    const created = await boss.api.createOrg({
      name: "ACME",
      slug: "acme",
      orgPublicHex: orgKp.publicHex,
      wrappedOrgPrivate,
      activationCode,
    });
    const consumed = await query<{ consumed_at: string | null }>(
      `SELECT consumed_at FROM site_activation WHERE id = 1`,
    );
    ok("le code est consommé à la création du Drive (usage unique)", consumed[0]?.consumed_at != null);
    const pol1b = await anon.sitePolicy();
    ok(
      "la politique n'exige plus de code une fois le Drive créé",
      pol1b?.activationRequired === false && pol1b.bootstrapped === true,
    );
    const org = created.org;
    const roleIdByKey: Record<string, string> = Object.fromEntries(created.roles.map((r: RoleDef) => [r.key, r.id]));
    ok("le propriétaire crée l'organisation du site", !!org.id);
    ok("politique : Drive désormais amorcé", (await anon.sitePolicy())?.bootstrapped === true);
    ok("GET /site/me : propriétaire", (await boss.api.siteMe()).isOwner === true);
    await expectStatus(
      "Drive unique : une 2e organisation est refusée",
      boss.api.createOrg({ name: "Autre", slug: "autre", orgPublicHex: orgKp.publicHex, wrappedOrgPrivate }),
      403,
    );

    // =========================================================================
    section("Inscription libre → membre simple avec espace privé");
    const alice = await newUser(base, "alice@acme.fr", "Alice");
    const carol = await newUser(base, "carol@acme.fr", "Carol");
    const aliceOrgs = (await alice.api.listOrgs()).organizations as { id: string; roleKey: string }[];
    ok(
      "Alice est automatiquement membre du Drive avec le rôle par défaut (éditeur)",
      aliceOrgs.length === 1 && aliceOrgs[0]!.id === org.id && aliceOrgs[0]!.roleKey === "editor",
      JSON.stringify(aliceOrgs),
    );
    const aliceRoles = (await alice.api.listRoles(org.id)).roles as RoleDef[];
    const ctxA: ops.OpsCtx = {
      api: alice.api,
      keys: alice.keys,
      userId: alice.user.id,
      orgId: org.id,
      orgPublicHex: org.orgPublicHex,
      roleIdByKey: Object.fromEntries(aliceRoles.map((r) => [r.key, r.id])),
    };
    const carolRoles = (await carol.api.listRoles(org.id)).roles as RoleDef[];
    const ctxC: ops.OpsCtx = {
      api: carol.api,
      keys: carol.keys,
      userId: carol.user.id,
      orgId: org.id,
      orgPublicHex: org.orgPublicHex,
      roleIdByKey: Object.fromEntries(carolRoles.map((r) => [r.key, r.id])),
    };

    const aliceSpace = await ops.createFolder(ctxA, null, "Espace d'Alice");
    ok("Alice crée son espace privé à la racine", !!aliceSpace.id);
    const carolRoot = await ops.listFolder(ctxC, null);
    ok("Carol ne voit pas l'espace d'Alice", !carolRoot.some((e) => e.id === aliceSpace.id));
    await ops.uploadFile(ctxA, aliceSpace.id, new File([enc.encode("v1") as unknown as BlobPart], "notes.txt"));

    section("Routes d'administration : réservées au propriétaire");
    await expectStatus("Alice : lecture des réglages refusée", alice.api.getSiteSettings(), 403);
    await expectStatus("Alice : liste des utilisateurs refusée", alice.api.siteUsers(), 403);
    const sAdmin = await boss.api.getSiteSettings();
    ok(
      "le propriétaire lit les réglages (défauts)",
      sAdmin.settings.signupMode === "open" && sAdmin.settings.defaultRoleKey === "editor" && sAdmin.roles.length >= 5,
      JSON.stringify(sAdmin.settings),
    );
    await expectStatus(
      "Alice : modification des réglages refusée",
      alice.api.putSiteSettings(sAdmin.settings, null),
      403,
    );
    const users = (await boss.api.siteUsers()).users;
    ok(
      "liste des utilisateurs : 3 comptes dont le propriétaire",
      users.length === 3 && users.some((u) => u.isOwner && u.email === "boss@acme.fr"),
      JSON.stringify(users.map((u) => u.email)),
    );
    await expectStatus(
      "réglages invalides refusés (mot de passe < 8)",
      boss.api.putSiteSettings({ ...sAdmin.settings, passwordMinLength: 3 }, null),
      400,
    );
    await expectStatus(
      "le rôle propriétaire ne peut pas être le rôle par défaut",
      boss.api.putSiteSettings({ ...sAdmin.settings, defaultRoleKey: "owner" }, null),
      400,
    );

    // =========================================================================
    section("Inscription fermée / sur invitation");
    let s: SiteSettings = { ...sAdmin.settings, signupMode: "closed" };
    await boss.api.putSiteSettings(s, null);
    ok("politique publique : inscription fermée", (await anon.sitePolicy())?.signupMode === "closed");
    await expectStatus("inscription fermée : refusée", anon.register(mallory.payload), 403);

    s = { ...s, signupMode: "invite" };
    await boss.api.putSiteSettings(s, null);
    await expectStatus("sur invitation : refusée sans jeton", anon.register(mallory.payload), 403);
    const wrong = await boss.api.invite(org.id, { email: "autre@acme.fr", roleId: roleIdByKey["viewer"]! });
    await expectStatus("jeton émis pour une autre adresse : refusé", anon.register(mallory.payload, wrong.token), 403);
    const inv = await boss.api.invite(org.id, { email: "mallory@evil.fr", roleId: roleIdByKey["viewer"]! });
    const mres = await anon.register(mallory.payload, inv.token);
    anon.setTokens({
      accessToken: mres.accessToken,
      accessTokenExpiresAt: mres.accessTokenExpiresAt,
      refreshToken: mres.refreshToken,
    });
    const joined = await anon.acceptInvite(inv.token);
    ok(
      "invitation valide : inscription puis adhésion avec le rôle de l'invitation (lecteur)",
      joined.orgId === org.id && joined.roleId === roleIdByKey["viewer"],
    );

    s = { ...s, signupMode: "open" };
    await boss.api.putSiteSettings(s, null);

    // =========================================================================
    section("Quotas : global, par utilisateur, individuel");
    const usedNow = (await boss.api.getSiteSettings()).usedBytes;
    ok(
      "usage global > 0 et quota global illimité",
      usedNow > 0 && (await boss.api.getSiteSettings()).globalQuotaBytes === null,
    );
    s = { ...s, perUserQuotaBytes: usedNow + 8192 };
    await boss.api.putSiteSettings(s, 500 * 1024 * 1024);
    ok("quota global enregistré", (await boss.api.getSiteSettings()).globalQuotaBytes === 500 * 1024 * 1024);
    const big = enc.encode("y".repeat(200_000));
    const over = await ops
      .uploadFile(ctxA, aliceSpace.id, new File([big as unknown as BlobPart], "gros.bin"))
      .then(() => null)
      .catch((e) => e);
    ok("quota par utilisateur dépassé → 507", over instanceof ApiError && over.status === 507, String(over));
    await boss.api.patchSiteUser(alice.user.id, { quotaBytes: 50 * 1024 * 1024 });
    await ops.uploadFile(ctxA, aliceSpace.id, new File([big as unknown as BlobPart], "gros-ok.bin"));
    ok("quota individuel relevé par le propriétaire → upload accepté", true);
    const aliceRow = (await boss.api.siteUsers()).users.find((u) => u.email === "alice@acme.fr")!;
    ok(
      "la liste affiche usage et quota individuel",
      aliceRow.usedBytes > 100_000 && aliceRow.quotaBytes === 50 * 1024 * 1024,
      JSON.stringify(aliceRow),
    );
    // Le global ne bloque pas les autres : on le remet illimité.
    await boss.api.putSiteSettings({ ...s, perUserQuotaBytes: null }, null);
    s = { ...s, perUserQuotaBytes: null };

    // =========================================================================
    section("Rétention des versions");
    const notes = (await ops.listFolder(ctxA, aliceSpace.id)).find((e) => e.name === "notes.txt")!;
    await ops.saveNewVersion(ctxA, notes.id, enc.encode("v2"));
    await ops.saveNewVersion(ctxA, notes.id, enc.encode("v3"));
    const vcount = async () =>
      Number(
        (await query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM node_versions WHERE node_id = $1`, [notes.id]))[0]!
          .n,
      );
    const before = await vcount();
    await query(
      `UPDATE node_versions SET created_at = now() - interval '40 days' WHERE node_id = $1 AND version_no = 1`,
      [notes.id],
    );
    await purgeOldVersions({ log: { debug() {}, warn() {} } } as never);
    ok("rétention illimitée (0) : rien n'est supprimé", (await vcount()) === before);
    await boss.api.putSiteSettings({ ...s, versionRetentionDays: 30 }, null);
    await purgeOldVersions({ log: { debug() {}, warn() {} } } as never);
    ok(
      "rétention 30 j : la version de 40 jours est supprimée, les récentes gardées",
      (await vcount()) === before - 1,
      `${before} → ${await vcount()}`,
    );
    const cur = await ops.downloadFile(
      ctxA,
      (await ops.listFolder(ctxA, aliceSpace.id)).find((e) => e.name === "notes.txt")!,
    );
    ok("la version courante reste lisible", dec.decode(cur.bytes) === "v3");
    s = { ...s, versionRetentionDays: 0 };
    await boss.api.putSiteSettings(s, null);

    // =========================================================================
    section("Journal collab : plus de 5000 mises à jour (pagination et compaction sûre)");
    await query(`DELETE FROM collab_updates WHERE node_id = $1`, [notes.id]);
    await query(
      `INSERT INTO collab_updates (node_id, update_ciphertext, update_nonce, author_user_id)
       SELECT $1, decode('aa', 'hex'), decode('000000000000000000000000', 'hex'), $2 FROM generate_series(1, 5300)`,
      [notes.id, alice.user.id],
    );
    const { readAllCollabUpdates } = await import("../src/drive-cloud/collab");
    const page1 = await boss.api.getCollabUpdates(notes.id, 0);
    ok("1re page : 5000 mises à jour et hasMore = true", page1.updates.length === 5000 && page1.hasMore === true);
    const all = await readAllCollabUpdates(boss.api, notes.id);
    ok(
      "lecture complète paginée : 5300 mises à jour, aucune perdue ni dupliquée",
      all.updates.length === 5300 && new Set(all.updates.map((u) => u.seq)).size === 5300,
    );
    const firstPageLast = page1.updates[4999]!.seq;
    // Une mise à jour arrive APRÈS la lecture (id > lastSeq) : la compaction ne doit pas l'effacer.
    const lateRow = await query<{ id: number }>(
      `INSERT INTO collab_updates (node_id, update_ciphertext, update_nonce, author_user_id)
       VALUES ($1, decode('bb','hex'), decode('000000000000000000000000','hex'), $2) RETURNING id`,
      [notes.id, alice.user.id],
    );
    await expectStatus(
      "compaction sans upToSeq : refusée (aucune suppression à l'aveugle)",
      fetch(`${base}/collab/${notes.id}/compact`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${boss.api.getTokens()!.accessToken}` },
        body: JSON.stringify({ ciphertext: "cc", nonce: "000000000000000000000000" }),
      }).then(async (r) => {
        if (!r.ok) throw new ApiError(r.status, "x", "x");
      }),
      400,
    );
    await boss.api.compactCollab(notes.id, "cc", "000000000000000000000000", all.lastSeq);
    const left = await query<{ id: number; c: string }>(
      `SELECT id, encode(update_ciphertext,'hex') AS c FROM collab_updates WHERE node_id = $1 ORDER BY id`,
      [notes.id],
    );
    ok(
      "compaction : seul ce qui a été lu est remplacé (la mise à jour tardive est conservée)",
      left.length === 2 && left[0]!.id === lateRow[0]!.id && left[0]!.c === "bb" && left[1]!.c === "cc",
      JSON.stringify(left.map((l) => l.c)),
    );
    ok("la 2e page du rattrapage existait bien (> 5000)", firstPageLast < all.lastSeq);
    await query(`DELETE FROM collab_updates WHERE node_id = $1`, [notes.id]);

    // =========================================================================
    section("Rôle, suspension, réactivation");
    await boss.api.patchSiteUser(carol.user.id, { roleId: roleIdByKey["viewer"]! });
    ok(
      "changement de rôle (Carol → lecteur)",
      ((await carol.api.listOrgs()).organizations as { roleKey: string }[])[0]!.roleKey === "viewer",
    );
    await expectStatus(
      "le propriétaire ne peut pas se suspendre",
      boss.api.patchSiteUser(boss.user.id, { suspended: true }),
      409,
    );
    const aliceRefresh = alice.api.getTokens()!.refreshToken;
    await boss.api.patchSiteUser(alice.user.id, { suspended: true });
    await expectStatus("compte suspendu : ses requêtes sont refusées", alice.api.listOrgs(), 401);
    const refreshRes = await fetch(`${base}/auth/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: aliceRefresh }),
    });
    ok("compte suspendu : sa session ne se rafraîchit plus", refreshRes.status === 401);
    await expectStatus("compte suspendu : connexion impossible", login(base, "alice@acme.fr", alice.password), 401);
    ok(
      "la liste signale la suspension",
      (await boss.api.siteUsers()).users.find((u) => u.email === "alice@acme.fr")!.suspended === true,
    );
    await boss.api.patchSiteUser(alice.user.id, { suspended: false });
    const a1 = await login(base, "alice@acme.fr", alice.password);
    ok("réactivation : Alice se reconnecte", !!(a1.res as { accessToken?: string }).accessToken);

    // =========================================================================
    section("Sessions et appareils");
    const a2 = await login(base, "alice@acme.fr", alice.password);
    const list = (await a2.api.listSessions()).sessions;
    ok(
      "2 appareils actifs, dont l'appareil courant marqué",
      list.length === 2 && list.filter((x) => x.current).length === 1,
      JSON.stringify(list.map((x) => x.current)),
    );
    const rev = await a2.api.revokeOtherSessions();
    ok("« déconnecter les autres appareils » révoque l'autre session", rev.revoked === 1);
    const r1 = await fetch(`${base}/auth/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: a1.api.getTokens()!.refreshToken }),
    });
    const r2 = await fetch(`${base}/auth/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: a2.api.getTokens()!.refreshToken }),
    });
    ok("l'autre appareil ne peut plus se rafraîchir, l'appareil courant oui", r1.status === 401 && r2.status === 200);
    const a2b = new DriveApi({ baseUrl: base, tokens: (await r2.json()) as never });
    const sessAfter = (await a2b.listSessions()).sessions;
    ok(
      "après rotation du jeton l'appareil courant est toujours reconnu",
      sessAfter.length === 1 && sessAfter[0]!.current === true,
    );
    const dev = (await boss.api.siteUsers()).users.find((u) => u.email === "alice@acme.fr")!;
    ok("le propriétaire voit le nombre de sessions actives", dev.activeSessions === 1);
    await boss.api.revokeUserSessions(alice.user.id);
    const r3 = await fetch(`${base}/auth/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: a2b.getTokens()!.refreshToken }),
    });
    ok("le propriétaire peut révoquer toutes les sessions d'un utilisateur", r3.status === 401);

    // =========================================================================
    section("Jauge de stockage réel et garde-fou disque");
    const alice2 = await login(base, "alice@acme.fr", alice.password);
    const ctxA2: ops.OpsCtx = { ...ctxA, api: alice2.api };
    const GB = 1024 ** 3;
    const fakeDisk = (totalGb: number, freeGb: number) =>
      setStatfsForTests(async () => ({ blocks: (totalGb * GB) / 4096, bsize: 4096, bavail: (freeGb * GB) / 4096 }));
    fakeDisk(100, 60);
    let adm = await boss.api.getSiteSettings();
    ok(
      "jauge : espace libre/total du disque et marge (max 5 % ou 2 Go) exposés",
      adm.disk.available === true &&
        adm.disk.totalBytes === 100 * GB &&
        adm.disk.freeBytes === 60 * GB &&
        adm.disk.marginBytes === 5 * GB &&
        !adm.disk.critical &&
        !adm.disk.low,
      JSON.stringify(adm.disk),
    );
    fakeDisk(100, 8);
    adm = await boss.api.getSiteSettings();
    ok(
      "disque proche de la limite : alerte « low » sans blocage",
      adm.disk.available && adm.disk.low && !adm.disk.critical,
      JSON.stringify(adm.disk),
    );
    fakeDisk(100, 3);
    adm = await boss.api.getSiteSettings();
    ok("disque sous la marge : alerte « critical »", adm.disk.available && adm.disk.critical);
    const small = new File([enc.encode("petit") as unknown as BlobPart], "refus-disque.txt");
    const refused = await ops
      .uploadFile(ctxA2, aliceSpace.id, small)
      .then(() => null)
      .catch((e) => e);
    ok(
      "envoi refusé (507) quand l'espace libre passe sous la marge",
      refused instanceof ApiError && refused.status === 507,
      String(refused),
    );
    await boss.api.putSiteSettings({ ...s, diskMarginPercent: 1, diskMarginBytes: 0 }, null);
    await ops.uploadFile(ctxA2, aliceSpace.id, small);
    ok("marge réglable : abaissée à 1 %, l'envoi repasse", true);
    await boss.api.putSiteSettings({ ...s }, null);
    fakeDisk(100, 60);
    await boss.api.putSiteSettings({ ...s, perUserQuotaBytes: 1024 * GB }, null);
    adm = await boss.api.getSiteSettings();
    ok(
      "sur-allocation signalée quand la somme des quotas dépasse le disque",
      adm.disk.available && adm.disk.overAllocated && (adm.disk.allocatedQuotaBytes ?? 0) > 100 * GB,
      JSON.stringify(adm.disk),
    );
    await boss.api.putSiteSettings({ ...s, perUserQuotaBytes: null }, null);
    adm = await boss.api.getSiteSettings();
    ok(
      "quotas illimités : pas de somme, pas de fausse alerte",
      adm.disk.available && adm.disk.quotaUnlimited && !adm.disk.overAllocated,
    );
    setStatfsForTests(null);

    // =========================================================================
    section("Sauvegarde obligatoire publiée");
    await boss.api.putSiteSettings({ ...s, backupRequired: true, passwordMinLength: 12, siteName: "ACME Drive" }, null);
    const pol1 = await anon.sitePolicy();
    ok(
      "la politique publique annonce sauvegarde obligatoire, mot de passe 12, nom du site",
      pol1?.backupRequired === true && pol1.passwordMinLength === 12 && pol1.siteName === "ACME Drive",
      JSON.stringify(pol1),
    );
    s = { ...s, backupRequired: true, passwordMinLength: 12, siteName: "ACME Drive" };

    // =========================================================================
    section("Réinitialisation de mot de passe par le propriétaire");
    await expectStatus(
      "le propriétaire ne peut pas se réinitialiser lui-même par ce lien",
      boss.api.createPasswordReset(boss.user.id),
      409,
    );
    await expectStatus("un membre ne peut pas générer de lien", carol.api.createPasswordReset(alice.user.id), 403);
    const rst = await boss.api.createPasswordReset(alice.user.id);
    const rinfo = await anon.resetInfo(rst.token);
    ok("le lien désigne bien le compte d'Alice", rinfo.email === "alice@acme.fr");
    await expectStatus("lien inconnu : refusé", anon.resetInfo("x".repeat(40)), 404);
    const newPw = "NouveauMotdepasse!77-Alice";
    const newReg = await buildRegistration("alice@acme.fr", newPw, "Alice");
    const wrongMail = await buildRegistration("intrus@acme.fr", newPw, "Intrus");
    await expectStatus(
      "clés destinées à une autre adresse : refusées",
      anon.resetComplete(rst.token, wrongMail.payload),
      400,
    );
    await anon.resetComplete(rst.token, newReg.payload);
    ok("réinitialisation menée à bien avec de nouvelles clés", true);
    await expectStatus(
      "lien à usage unique : le réutiliser est refusé",
      anon.resetComplete(rst.token, newReg.payload),
      404,
    );
    await expectStatus("l'ancien mot de passe ne fonctionne plus", login(base, "alice@acme.fr", alice.password), 401);
    const nl = await login(base, "alice@acme.fr", newPw);
    ok("le nouveau mot de passe ouvre le compte", !!(nl.res as { accessToken?: string }).accessToken);
    const ctxA3: ops.OpsCtx = { ...ctxA, api: nl.api, keys: newReg.keys };
    const notes3 = (await ops.listFolder(ctxA3, aliceSpace.id).catch(() => [])).find((e) => e.name === "notes.txt");
    const unreadable = notes3
      ? await ops
          .downloadFile(ctxA3, notes3)
          .then(() => false)
          .catch(() => true)
      : true;
    ok("avant rétablissement : les anciens fichiers privés d'Alice sont illisibles (nouvelles clés)", unreadable);
    const bossCtx = { api: boss.api, orgId: org.id, orgPublicHex: org.orgPublicHex, adminKeys: boss.keys.recipient };
    const restoredCount = await restoreOwnedNodes(
      bossCtx,
      { userId: alice.user.id, publicHex: newReg.keys.recipient.publicHex },
      roleIdByKey["owner"]!,
    );
    ok("le propriétaire rétablit ses accès via la clé d'organisation", restoredCount >= 2, String(restoredCount));
    const notes4 = (await ops.listFolder(ctxA3, aliceSpace.id)).find((e) => e.name === "notes.txt")!;
    ok(
      "après rétablissement : Alice relit son fichier avec ses nouvelles clés",
      dec.decode((await ops.downloadFile(ctxA3, notes4)).bytes) === "v3",
    );
    const exp = await boss.api.createPasswordReset(alice.user.id);
    await query(`UPDATE password_resets SET expires_at = now() - interval '1 minute' WHERE user_id = $1`, [
      alice.user.id,
    ]);
    await expectStatus("lien expiré : refusé", anon.resetInfo(exp.token), 404);
    const rAudits = new Set(
      (await query<{ action: string }>(`SELECT action FROM audit_log WHERE action LIKE '%password_reset%'`)).map(
        (a) => a.action,
      ),
    );
    ok(
      "génération et validation du lien sont journalisées",
      rAudits.has("site.user.password_reset") && rAudits.has("auth.password_reset.complete"),
      [...rAudits].join(","),
    );

    // =========================================================================
    section("2FA obligatoire");
    await expectStatus(
      "impossible d'imposer la 2FA sans avoir la sienne (anti-verrouillage)",
      boss.api.putSiteSettings({ ...s, mfaPolicy: "required" }, null),
      409,
    );
    const setup = await boss.api.mfaSetup();
    const enabled = await boss.api.mfaEnable(totpNow(setup.secret));
    await expectStatus(
      "imposer la 2FA SANS code (ré-authentification) : refusé",
      boss.api.putSiteSettings({ ...s, mfaPolicy: "required" }, null),
      403,
      "mfa_proof_required",
    );
    await expectStatus(
      "imposer la 2FA avec un MAUVAIS code : refusé",
      boss.api.putSiteSettings({ ...s, mfaPolicy: "required" }, null, "000000"),
      403,
      "mfa_proof_invalid",
    );
    ok("la politique n'a pas changé après ces refus", (await anon.sitePolicy())?.mfaPolicy === "optional");
    await boss.api.putSiteSettings({ ...s, mfaPolicy: "required" }, null, totpNow(setup.secret));
    ok("2FA imposée (le propriétaire a la sienne)", (await anon.sitePolicy())?.mfaPolicy === "required");
    await expectStatus(
      "Carol sans 2FA : accès bloqué (enrôlement requis)",
      carol.api.listOrgs(),
      403,
      "mfa_enrollment_required",
    );
    const me = await carol.api.siteMe();
    ok("Carol peut interroger /site/me et voit qu'elle doit s'enrôler", me.mfaEnrollmentRequired === true);
    const csetup = await carol.api.mfaSetup();
    await carol.api.mfaEnable(totpNow(csetup.secret));
    ok(
      "après enrôlement 2FA, Carol retrouve l'accès",
      ((await carol.api.listOrgs()).organizations as unknown[]).length === 1,
    );
    ok("/site/me n'exige plus l'enrôlement", (await carol.api.siteMe()).mfaEnrollmentRequired === false);

    section("Connexion avec 2FA : code de secours puis secours serveur");
    const bl = await login(base, "boss@acme.fr", boss.password);
    const blr = bl.res as { mfaRequired?: boolean; mfaToken?: string };
    ok("connexion du propriétaire : second facteur exigé", blr.mfaRequired === true);
    const bc = enabled.backupCodes[0]!;
    const viaBackup = await new DriveApi({ baseUrl: base }).loginMfa(blr.mfaToken!, bc.toUpperCase().replace("-", " "));
    ok("un code de secours (saisie tolérante : majuscules, espace) ouvre la session", !!viaBackup.accessToken);
    const bl2 = await login(base, "boss@acme.fr", boss.password);
    await expectStatus(
      "le même code de secours ne sert qu'une fois",
      new DriveApi({ baseUrl: base }).loginMfa((bl2.res as { mfaToken: string }).mfaToken, bc),
      401,
    );
    await expectStatus(
      "un mauvais code est refusé avec un message clair",
      new DriveApi({ baseUrl: base }).loginMfa((bl2.res as { mfaToken: string }).mfaToken, "zzzz-zzzz"),
      401,
    );

    // Le propriétaire a perdu application ET codes : procédure de secours en ligne de commande (côté serveur).
    const outcome = await resetOwnerAccess("boss@acme.fr");
    ok(
      "secours : 2FA retirée et politique remise à facultative",
      outcome.hadTotp && outcome.policyReset && (await anon.sitePolicy())?.mfaPolicy === "optional",
    );
    const bl3 = await login(base, "boss@acme.fr", boss.password);
    ok(
      "secours : le propriétaire se reconnecte avec son seul mot de passe",
      !!(bl3.res as { accessToken?: string }).accessToken,
    );
    const stillValid = await fetch(`${base}/auth/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: boss.api.getTokens()!.refreshToken }),
    });
    ok("secours : les anciennes sessions du propriétaire ont été révoquées", stillValid.status === 401);
    const ra = await query<{ action: string }>(`SELECT action FROM audit_log WHERE action = 'owner.access.reset'`);
    ok("secours : l'opération est inscrite au journal d'audit", ra.length === 1);

    // =========================================================================
    section("Journal d'audit");
    const audits = await query<{ action: string }>(
      `SELECT action FROM audit_log WHERE org_id = $1 AND action LIKE 'site.%'`,
      [org.id],
    );
    const acts = new Set(audits.map((a) => a.action));
    ok(
      "réglages, quotas, suspension et révocations sont journalisés",
      [
        "site.settings.update",
        "site.user.quota",
        "site.user.suspend",
        "site.user.reactivate",
        "site.user.revoke_sessions",
        "site.user.password_reset",
      ].every((a) => acts.has(a)),
      [...acts].join(","),
    );
  } finally {
    await app.close();
    await closePool();
    await pg.stop();
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
