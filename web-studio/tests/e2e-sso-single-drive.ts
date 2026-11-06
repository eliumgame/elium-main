/**
 * E2E du SSO (OIDC) en mode « un déploiement = un Drive » — SANS Docker.
 *
 * Le SSO n'est autorisé que si SINGLE_DRIVE=true ET une seule organisation existe (décision de
 * sécurité : un IdP contrôlé par une organisation ne doit pas pouvoir authentifier des comptes
 * globaux d'autres tenants). e2e-multiuser vérifie le refus en déploiement multi-organisations ;
 * ce scénario couvre le fonctionnel : configuration, nonce à usage unique, vérification du jeton
 * (audience, expiration, domaine, signature, membre), zéro-connaissance du bundle, 2FA locale,
 * liaison sso_subject (SRV-10) et déprovisionnement SCIM.
 *
 * Lancer :  npm run test:e2e:sso   (depuis web-studio/ ; ~1 min, Argon2id oblige)
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";

import { DriveApi, ApiError } from "../src/drive-cloud/api";
import { reauthenticate } from "../src/drive-cloud/reauth";
import { buildRegistration, prepareLogin, unlockAccount, type AccountKeys } from "../src/drive-cloud/account";
import type { RoleDef } from "../src/drive-cloud/types";
import { generateRecipientKeypair, encryptForRecipients } from "../src/crypto/recipients";
import { fromHex } from "../src/format/canonical";
import type { KdfParams } from "../src/drive-cloud/kdf";

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
async function expectStatus(name: string, p: Promise<unknown>, status: number): Promise<void> {
  try {
    await p;
    ok(name, false, `la requête aurait dû échouer (${status} attendu)`);
  } catch (e) {
    ok(name, e instanceof ApiError && e.status === status, `reçu ${e instanceof ApiError ? e.status : String(e)}`);
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

async function main(): Promise<void> {
  const pgPort = 54000 + Math.floor(Math.random() * 900);
  const dataDir = mkdtempSync(join(tmpdir(), "elium-sso-pg-"));
  const blobDir = mkdtempSync(join(tmpdir(), "elium-sso-blobs-"));

  process.env.NODE_ENV = "test";
  process.env.DATABASE_URL = `postgres://elium:elium@127.0.0.1:${pgPort}/elium`;
  process.env.TOKEN_SECRET = "e2e-secret-0123456789abcdef0123456789abcdef";
  process.env.STORAGE_DRIVER = "fs";
  process.env.STORAGE_FS_ROOT = blobDir;
  process.env.CORS_ORIGINS = "http://localhost";
  process.env.DB_STATEMENT_TIMEOUT_MS = "4000";
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
  const { totpNow } = await import("../../server/src/lib/totp");
  const { ensureActivationCode } = await import("../../server/src/lib/activation");
  const { issueReauthToken } = await import("../../server/src/lib/reauth");
  await migrate();
  const activationCode = (await ensureActivationCode())!;
  const app = await buildApp();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}/api`;
  ok("API démarrée", (await fetch(`${base}/health`)).ok);

  try {
    // =========================================================================
    section("Drive unique : propriétaire + membre");
    const boss = await newUser(base, "boss@acme.fr", "Boss", activationCode);
    const orgKp = await generateRecipientKeypair();
    const wrappedOrgPrivate = JSON.parse(
      dec.decode(await encryptForRecipients(fromHex(orgKp.privateHex), [boss.keys.recipient.publicHex])),
    ) as Record<string, unknown>;
    const created = await boss.api.createOrg({
      name: "ACME",
      slug: "acme",
      orgPublicHex: orgKp.publicHex,
      wrappedOrgPrivate,
      activationCode,
    });
    const org = created.org;
    const roles = created.roles as RoleDef[];
    ok("organisation unique créée", !!org.id && roles.length >= 7);
    const bob = await newUser(base, "bob@acme.fr", "Bob");
    ok(
      "Bob est membre du Drive unique",
      ((await bob.api.listOrgs()).organizations as { id: string }[]).some((o) => o.id === org.id),
    );

    const { generateKeyPairSync, createSign } = await import("node:crypto");
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = { ...(publicKey.export({ format: "jwk" }) as Record<string, unknown>), kid: "test-1" };
    const ISS = "https://idp.test";
    const AUD = "elium-drive";
    const reauthBoss = async () => issueReauthToken(boss.user.id);

    // =========================================================================
    section("Configuration SSO + nonce");
    ok("config publique SSO absente tant que le SSO n'est pas configuré", (await bob.api.ssoPublicConfig()) === null);
    await boss.api.setOrgSso(
      org.id,
      { issuer: ISS, clientId: AUD, jwks: [jwk], allowedDomains: ["acme.fr"] },
      await reauthBoss(),
    );
    ok("configuration SSO (OIDC) enregistrée", !!(await boss.api.getOrgSso(org.id)).sso);
    const pub = await new DriveApi({ baseUrl: base }).ssoPublicConfig();
    ok("config publique : orgId + issuer + clientId, sans jwks", pub?.orgId === org.id && !("jwks" in (pub ?? {})));

    const b64u = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const signIdToken = (claims: Record<string, unknown>, key = privateKey) => {
      const head = b64u({ alg: "RS256", typ: "JWT", kid: "test-1" });
      const body = b64u(claims);
      const sig = createSign("sha256").update(`${head}.${body}`).sign(key).toString("base64url");
      return `${head}.${body}.${sig}`;
    };
    const nowS = Math.floor(Date.now() / 1000);
    const ssoApi = new DriveApi({ baseUrl: base });
    const claimsFor = (email: string, nonce: string, extra: Record<string, unknown> = {}) => ({
      iss: ISS,
      aud: AUD,
      sub: "idp-bob-123",
      email,
      email_verified: true,
      nonce,
      iat: nowS,
      exp: nowS + 300,
      ...extra,
    });
    /** Un nonce frais par tentative (usage unique) : jeton signé par défaut, surcharges via `extra`. */
    const attempt = async (
      email: string,
      extra: Record<string, unknown> = {},
      key = privateKey,
      api: DriveApi = ssoApi,
    ) => {
      const { nonce } = await ssoApi.ssoNonce(org.id);
      return api.ssoVerify(org.id, signIdToken(claimsFor(email, nonce, extra), key), nonce);
    };

    // =========================================================================
    section("Vérification du jeton d'identité");
    const ssoRes = await attempt(bob.user.email);
    ok("SSO : session émise + bundle pour un membre", !!ssoRes.accessToken && !!ssoRes.keyBundle);
    const preBob = await new DriveApi({ baseUrl: base }).prelogin(bob.user.email);
    const ssoBobMk = (await prepareLogin(bob.password, preBob.kdfSalt, preBob.kdfParams as KdfParams)).masterKey;
    const ssoKeys = await unlockAccount(ssoRes.keyBundle, ssoBobMk, ssoRes.user);
    ok(
      "le bundle livré par SSO se déverrouille avec la phrase de passe (zéro-connaissance)",
      ssoKeys.recipient.privateHex === bob.keys.recipient.privateHex,
    );

    // Nonce : usage unique, obligatoire, lié au jeton.
    {
      const { nonce } = await ssoApi.ssoNonce(org.id);
      const tok = signIdToken(claimsFor(bob.user.email, nonce));
      ok(
        "SSO : nonce valide → session",
        !!(await new DriveApi({ baseUrl: base }).ssoVerify(org.id, tok, nonce)).accessToken,
      );
      await expectStatus(
        "SSO : rejeu du même nonce/jeton → 401",
        new DriveApi({ baseUrl: base }).ssoVerify(org.id, tok, nonce),
        401,
      );
      const { nonce: n2 } = await ssoApi.ssoNonce(org.id);
      await expectStatus(
        "SSO : jeton sans claim nonce → 401",
        ssoApi.ssoVerify(org.id, signIdToken({ ...claimsFor(bob.user.email, n2), nonce: undefined }), n2),
        401,
      );
      const { nonce: n3 } = await ssoApi.ssoNonce(org.id);
      await expectStatus(
        "SSO : nonce du jeton différent de celui présenté → 401",
        ssoApi.ssoVerify(org.id, signIdToken(claimsFor(bob.user.email, "x".repeat(32))), n3),
        401,
      );
      await expectStatus(
        "SSO : nonce jamais émis par le serveur → 401",
        ssoApi.ssoVerify(org.id, signIdToken(claimsFor(bob.user.email, "y".repeat(32))), "y".repeat(32)),
        401,
      );
    }

    await expectStatus("SSO : mauvaise audience → 401", attempt(bob.user.email, { aud: "autre" }), 401);
    await expectStatus("SSO : jeton expiré → 401", attempt(bob.user.email, { exp: nowS - 500 }), 401);
    await expectStatus("SSO : domaine e-mail non autorisé → 401", attempt("eve@evil.com"), 401);
    const { privateKey: otherKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    await expectStatus("SSO : signature forgée (autre clé) → 401", attempt(bob.user.email, {}, otherKey), 401);
    await expectStatus("SSO : e-mail sans compte membre → 401", attempt("inconnu@acme.fr"), 401);
    await expectStatus(
      "SSO : e-mail non vérifié par l'IdP → 401",
      attempt(bob.user.email, { email_verified: false }),
      401,
    );

    // =========================================================================
    section("2FA locale + liaison sso_subject (SRV-10)");
    // Un compte avec 2FA locale ne s'ouvre PAS sur le seul jeton d'identité (IdP faux/compromis).
    const bobSetup = await bob.api.mfaSetup(await reauthenticate(bob.api, bob.user.email, bob.password));
    const bobEnabled = await bob.api.mfaEnable(totpNow(bobSetup.secret));
    // On repart d'un compte NON lié, pour vérifier que le lien se fait à la réussite du 2e facteur.
    await query(`UPDATE users SET sso_subject = NULL WHERE id = $1`, [bob.user.id]);
    const ssoMfa = (await attempt(bob.user.email)) as unknown as {
      mfaRequired?: boolean;
      mfaToken?: string;
      accessToken?: string;
    };
    ok("SSO : un compte avec 2FA reçoit un défi, pas de session", ssoMfa.mfaRequired === true && !ssoMfa.accessToken);
    const ssoDone = await new DriveApi({ baseUrl: base }).loginMfa(
      ssoMfa.mfaToken!,
      totpNow(bobSetup.secret, Date.now() + 30_000), // pas suivant : le pas courant est consommé (anti-rejeu)
    );
    ok("SSO + code 2FA : session émise", !!ssoDone.accessToken);
    const bound = await query<{ sso_subject: string | null }>(`SELECT sso_subject FROM users WHERE id = $1`, [
      bob.user.id,
    ]);
    ok("SRV-10 : sso_subject lié après le 2e facteur", bound[0]?.sso_subject === "idp-bob-123");
    await expectStatus(
      "SRV-10 : un autre sub IdP ne passe plus sur le compte lié → 401",
      attempt(bob.user.email, { sub: "idp-usurpateur" }),
      401,
    );
    await bob.api.mfaDisable(bobEnabled.backupCodes[0]!);

    // =========================================================================
    section("Déprovisionnement SCIM : plus d'accès SSO");
    const { token: scimTok } = await boss.api.createScimToken(org.id, await reauthBoss());
    const scim = (path: string, method: string, body?: unknown) =>
      fetch(`${base}/scim/v2/Users${path}`, {
        method,
        headers: { authorization: `Bearer ${scimTok}`, "content-type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
    const list = (await (
      await scim(`?filter=${encodeURIComponent(`userName eq "${bob.user.email}"`)}`, "GET")
    ).json()) as { Resources: { id: string }[] };
    const bobScimId = list.Resources[0]!.id;
    await scim(`/${bobScimId}`, "PATCH", { Operations: [{ op: "replace", path: "active", value: false }] });
    await expectStatus("SCIM déprovisionné : login SSO refusé (401)", attempt(bob.user.email), 401);
    await scim(`/${bobScimId}`, "PATCH", { Operations: [{ op: "replace", path: "active", value: true }] });
    ok("SCIM réactivé : login SSO rétabli", !!(await attempt(bob.user.email)).accessToken);

    // =========================================================================
    section("Désactivation du SSO");
    await boss.api.disableOrgSso(org.id, await reauthBoss());
    await expectStatus("SSO désactivé : login SSO refusé", attempt(bob.user.email), 400);
  } finally {
    await app.close();
    await closePool();
    await pg.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(blobDir, { recursive: true, force: true });
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
