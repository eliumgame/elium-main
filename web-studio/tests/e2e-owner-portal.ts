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

async function login(base: string, email: string, password: string): Promise<{ api: DriveApi; res: LoginResponse }> {
  const api = new DriveApi({ baseUrl: base });
  const pre = await api.prelogin(email);
  const { authSignSeedHex } = await prepareLogin(password, pre.kdfSalt, pre.kdfParams as KdfParams);
  const { challengeId, challenge } = await api.loginInit(email);
  const res = await api.loginVerify(email, challengeId, await signLoginChallenge(challenge, authSignSeedHex));
  const r = res as { accessToken?: string; accessTokenExpiresAt?: number; refreshToken?: string };
  if (r.accessToken) {
    api.setTokens({ accessToken: r.accessToken, accessTokenExpiresAt: r.accessTokenExpiresAt!, refreshToken: r.refreshToken! });
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
  await migrate();
  const app = await buildApp();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}/api`;
  ok("API démarrée", (await fetch(`${base}/health`)).ok);

  const anon = new DriveApi({ baseUrl: base });

  try {
    // =========================================================================
    section("Amorçage : le premier compte attendu devient propriétaire");
    const pol0 = await anon.sitePolicy();
    ok("politique publique lisible sans compte, Drive pas encore créé", pol0?.deployed === true && pol0.bootstrapped === false, JSON.stringify(pol0));

    const mallory = await buildRegistration("mallory@evil.fr", "Motdepasse!42-Mallory", "Mallory");
    await expectStatus("un inconnu ne peut pas s'inscrire avant le propriétaire (OWNER_EMAIL)", anon.register(mallory.payload), 403);

    const boss = await newUser(base, "boss@acme.fr", "Boss");
    const orgKp = await generateRecipientKeypair();
    const wrappedOrgPrivate = JSON.parse(dec.decode(await encryptForRecipients(fromHex(orgKp.privateHex), [boss.keys.recipient.publicHex]))) as Record<string, unknown>;
    const created = await boss.api.createOrg({ name: "ACME", slug: "acme", orgPublicHex: orgKp.publicHex, wrappedOrgPrivate });
    const org = created.org;
    const roleIdByKey: Record<string, string> = Object.fromEntries(created.roles.map((r: RoleDef) => [r.key, r.id]));
    ok("le propriétaire crée l'organisation du site", !!org.id);
    ok("politique : Drive désormais amorcé", (await anon.sitePolicy())?.bootstrapped === true);
    ok("GET /site/me : propriétaire", (await boss.api.siteMe()).isOwner === true);
    await expectStatus("Drive unique : une 2e organisation est refusée", boss.api.createOrg({ name: "Autre", slug: "autre", orgPublicHex: orgKp.publicHex, wrappedOrgPrivate }), 403);

    // =========================================================================
    section("Inscription libre → membre simple avec espace privé");
    const alice = await newUser(base, "alice@acme.fr", "Alice");
    const carol = await newUser(base, "carol@acme.fr", "Carol");
    const aliceOrgs = (await alice.api.listOrgs()).organizations as { id: string; roleKey: string }[];
    ok("Alice est automatiquement membre du Drive avec le rôle par défaut (éditeur)", aliceOrgs.length === 1 && aliceOrgs[0]!.id === org.id && aliceOrgs[0]!.roleKey === "editor", JSON.stringify(aliceOrgs));
    const aliceRoles = (await alice.api.listRoles(org.id)).roles as RoleDef[];
    const ctxA: ops.OpsCtx = { api: alice.api, keys: alice.keys, userId: alice.user.id, orgId: org.id, orgPublicHex: org.orgPublicHex, roleIdByKey: Object.fromEntries(aliceRoles.map((r) => [r.key, r.id])) };
    const carolRoles = (await carol.api.listRoles(org.id)).roles as RoleDef[];
    const ctxC: ops.OpsCtx = { api: carol.api, keys: carol.keys, userId: carol.user.id, orgId: org.id, orgPublicHex: org.orgPublicHex, roleIdByKey: Object.fromEntries(carolRoles.map((r) => [r.key, r.id])) };

    const aliceSpace = await ops.createFolder(ctxA, null, "Espace d'Alice");
    ok("Alice crée son espace privé à la racine", !!aliceSpace.id);
    const carolRoot = await ops.listFolder(ctxC, null);
    ok("Carol ne voit pas l'espace d'Alice", !carolRoot.some((e) => e.id === aliceSpace.id));
    await ops.uploadFile(ctxA, aliceSpace.id, new File([enc.encode("v1") as unknown as BlobPart], "notes.txt"));

    section("Routes d'administration : réservées au propriétaire");
    await expectStatus("Alice : lecture des réglages refusée", alice.api.getSiteSettings(), 403);
    await expectStatus("Alice : liste des utilisateurs refusée", alice.api.siteUsers(), 403);
    const sAdmin = await boss.api.getSiteSettings();
    ok("le propriétaire lit les réglages (défauts)", sAdmin.settings.signupMode === "open" && sAdmin.settings.defaultRoleKey === "editor" && sAdmin.roles.length >= 5, JSON.stringify(sAdmin.settings));
    await expectStatus("Alice : modification des réglages refusée", alice.api.putSiteSettings(sAdmin.settings, null), 403);
    const users = (await boss.api.siteUsers()).users;
    ok("liste des utilisateurs : 3 comptes dont le propriétaire", users.length === 3 && users.some((u) => u.isOwner && u.email === "boss@acme.fr"), JSON.stringify(users.map((u) => u.email)));
    await expectStatus("réglages invalides refusés (mot de passe < 8)", boss.api.putSiteSettings({ ...sAdmin.settings, passwordMinLength: 3 }, null), 400);
    await expectStatus("le rôle propriétaire ne peut pas être le rôle par défaut", boss.api.putSiteSettings({ ...sAdmin.settings, defaultRoleKey: "owner" }, null), 400);

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
    anon.setTokens({ accessToken: mres.accessToken, accessTokenExpiresAt: mres.accessTokenExpiresAt, refreshToken: mres.refreshToken });
    const joined = await anon.acceptInvite(inv.token);
    ok("invitation valide : inscription puis adhésion avec le rôle de l'invitation (lecteur)", joined.orgId === org.id && joined.roleId === roleIdByKey["viewer"]);

    s = { ...s, signupMode: "open" };
    await boss.api.putSiteSettings(s, null);

    // =========================================================================
    section("Quotas : global, par utilisateur, individuel");
    const usedNow = (await boss.api.getSiteSettings()).usedBytes;
    ok("usage global > 0 et quota global illimité", usedNow > 0 && (await boss.api.getSiteSettings()).globalQuotaBytes === null);
    s = { ...s, perUserQuotaBytes: usedNow + 8192 };
    await boss.api.putSiteSettings(s, 500 * 1024 * 1024);
    ok("quota global enregistré", (await boss.api.getSiteSettings()).globalQuotaBytes === 500 * 1024 * 1024);
    const big = enc.encode("y".repeat(200_000));
    const over = await ops.uploadFile(ctxA, aliceSpace.id, new File([big as unknown as BlobPart], "gros.bin")).then(() => null).catch((e) => e);
    ok("quota par utilisateur dépassé → 507", over instanceof ApiError && over.status === 507, String(over));
    await boss.api.patchSiteUser(alice.user.id, { quotaBytes: 50 * 1024 * 1024 });
    await ops.uploadFile(ctxA, aliceSpace.id, new File([big as unknown as BlobPart], "gros-ok.bin"));
    ok("quota individuel relevé par le propriétaire → upload accepté", true);
    const aliceRow = (await boss.api.siteUsers()).users.find((u) => u.email === "alice@acme.fr")!;
    ok("la liste affiche usage et quota individuel", aliceRow.usedBytes > 100_000 && aliceRow.quotaBytes === 50 * 1024 * 1024, JSON.stringify(aliceRow));
    // Le global ne bloque pas les autres : on le remet illimité.
    await boss.api.putSiteSettings({ ...s, perUserQuotaBytes: null }, null);
    s = { ...s, perUserQuotaBytes: null };

    // =========================================================================
    section("Rétention des versions");
    const notes = (await ops.listFolder(ctxA, aliceSpace.id)).find((e) => e.name === "notes.txt")!;
    await ops.saveNewVersion(ctxA, notes.id, enc.encode("v2"));
    await ops.saveNewVersion(ctxA, notes.id, enc.encode("v3"));
    const vcount = async () => Number((await query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM node_versions WHERE node_id = $1`, [notes.id]))[0]!.n);
    const before = await vcount();
    await query(`UPDATE node_versions SET created_at = now() - interval '40 days' WHERE node_id = $1 AND version_no = 1`, [notes.id]);
    await purgeOldVersions({ log: { debug() {}, warn() {} } } as never);
    ok("rétention illimitée (0) : rien n'est supprimé", (await vcount()) === before);
    await boss.api.putSiteSettings({ ...s, versionRetentionDays: 30 }, null);
    await purgeOldVersions({ log: { debug() {}, warn() {} } } as never);
    ok("rétention 30 j : la version de 40 jours est supprimée, les récentes gardées", (await vcount()) === before - 1, `${before} → ${await vcount()}`);
    const cur = await ops.downloadFile(ctxA, (await ops.listFolder(ctxA, aliceSpace.id)).find((e) => e.name === "notes.txt")!);
    ok("la version courante reste lisible", dec.decode(cur.bytes) === "v3");
    s = { ...s, versionRetentionDays: 0 };
    await boss.api.putSiteSettings(s, null);

    // =========================================================================
    section("Rôle, suspension, réactivation");
    await boss.api.patchSiteUser(carol.user.id, { roleId: roleIdByKey["viewer"]! });
    ok("changement de rôle (Carol → lecteur)", ((await carol.api.listOrgs()).organizations as { roleKey: string }[])[0]!.roleKey === "viewer");
    await expectStatus("le propriétaire ne peut pas se suspendre", boss.api.patchSiteUser(boss.user.id, { suspended: true }), 409);
    const aliceRefresh = alice.api.getTokens()!.refreshToken;
    await boss.api.patchSiteUser(alice.user.id, { suspended: true });
    await expectStatus("compte suspendu : ses requêtes sont refusées", alice.api.listOrgs(), 401);
    const refreshRes = await fetch(`${base}/auth/refresh`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ refreshToken: aliceRefresh }) });
    ok("compte suspendu : sa session ne se rafraîchit plus", refreshRes.status === 401);
    await expectStatus("compte suspendu : connexion impossible", login(base, "alice@acme.fr", alice.password), 401);
    ok("la liste signale la suspension", (await boss.api.siteUsers()).users.find((u) => u.email === "alice@acme.fr")!.suspended === true);
    await boss.api.patchSiteUser(alice.user.id, { suspended: false });
    const a1 = await login(base, "alice@acme.fr", alice.password);
    ok("réactivation : Alice se reconnecte", !!(a1.res as { accessToken?: string }).accessToken);

    // =========================================================================
    section("Sessions et appareils");
    const a2 = await login(base, "alice@acme.fr", alice.password);
    const list = (await a2.api.listSessions()).sessions;
    ok("2 appareils actifs, dont l'appareil courant marqué", list.length === 2 && list.filter((x) => x.current).length === 1, JSON.stringify(list.map((x) => x.current)));
    const rev = await a2.api.revokeOtherSessions();
    ok("« déconnecter les autres appareils » révoque l'autre session", rev.revoked === 1);
    const r1 = await fetch(`${base}/auth/refresh`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ refreshToken: a1.api.getTokens()!.refreshToken }) });
    const r2 = await fetch(`${base}/auth/refresh`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ refreshToken: a2.api.getTokens()!.refreshToken }) });
    ok("l'autre appareil ne peut plus se rafraîchir, l'appareil courant oui", r1.status === 401 && r2.status === 200);
    const a2b = new DriveApi({ baseUrl: base, tokens: (await r2.json()) as never });
    const sessAfter = (await a2b.listSessions()).sessions;
    ok("après rotation du jeton l'appareil courant est toujours reconnu", sessAfter.length === 1 && sessAfter[0]!.current === true);
    const dev = (await boss.api.siteUsers()).users.find((u) => u.email === "alice@acme.fr")!;
    ok("le propriétaire voit le nombre de sessions actives", dev.activeSessions === 1);
    await boss.api.revokeUserSessions(alice.user.id);
    const r3 = await fetch(`${base}/auth/refresh`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ refreshToken: a2b.getTokens()!.refreshToken }) });
    ok("le propriétaire peut révoquer toutes les sessions d'un utilisateur", r3.status === 401);

    // =========================================================================
    section("Sauvegarde obligatoire publiée");
    await boss.api.putSiteSettings({ ...s, backupRequired: true, passwordMinLength: 12, siteName: "ACME Drive" }, null);
    const pol1 = await anon.sitePolicy();
    ok("la politique publique annonce sauvegarde obligatoire, mot de passe 12, nom du site", pol1?.backupRequired === true && pol1.passwordMinLength === 12 && pol1.siteName === "ACME Drive", JSON.stringify(pol1));
    s = { ...s, backupRequired: true, passwordMinLength: 12, siteName: "ACME Drive" };

    // =========================================================================
    section("2FA obligatoire");
    await expectStatus("impossible d'imposer la 2FA sans avoir la sienne (anti-verrouillage)", boss.api.putSiteSettings({ ...s, mfaPolicy: "required" }, null), 409);
    const setup = await boss.api.mfaSetup();
    await boss.api.mfaEnable(totpNow(setup.secret));
    await boss.api.putSiteSettings({ ...s, mfaPolicy: "required" }, null);
    ok("2FA imposée (le propriétaire a la sienne)", (await anon.sitePolicy())?.mfaPolicy === "required");
    await expectStatus("Carol sans 2FA : accès bloqué (enrôlement requis)", carol.api.listOrgs(), 403, "mfa_enrollment_required");
    const me = await carol.api.siteMe();
    ok("Carol peut interroger /site/me et voit qu'elle doit s'enrôler", me.mfaEnrollmentRequired === true);
    const csetup = await carol.api.mfaSetup();
    await carol.api.mfaEnable(totpNow(csetup.secret));
    ok("après enrôlement 2FA, Carol retrouve l'accès", ((await carol.api.listOrgs()).organizations as unknown[]).length === 1);
    ok("/site/me n'exige plus l'enrôlement", (await carol.api.siteMe()).mfaEnrollmentRequired === false);

    // =========================================================================
    section("Journal d'audit");
    const audits = await query<{ action: string }>(`SELECT action FROM audit_log WHERE org_id = $1 AND action LIKE 'site.%'`, [org.id]);
    const acts = new Set(audits.map((a) => a.action));
    ok("réglages, quotas, suspension et révocations sont journalisés", ["site.settings.update", "site.user.quota", "site.user.suspend", "site.user.reactivate", "site.user.revoke_sessions"].every((a) => acts.has(a)), [...acts].join(","));
  } finally {
    await app.close();
    await closePool();
    await pg.stop();
  }

  // eslint-disable-next-line no-console
  console.log(`\n=== RÉSULTAT : ${checks - failures}/${checks} vérifications réussies${failures ? ` — ${failures} ÉCHEC(S)` : " ✅"} ===`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error("ERREUR FATALE E2E:", e);
  process.exit(1);
});
