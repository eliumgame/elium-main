/**
 * E2E multi-utilisateurs de la pile Drive entreprise — SANS Docker.
 *
 * Boote un VRAI PostgreSQL (embedded-postgres), la VRAIE API Fastify et pilote
 * le VRAI SDK client (web-studio/src/drive-cloud) avec sa cryptographie
 * (Argon2id, ECDH-ES P-256, AES-256-GCM) sur HTTP + WebSocket, comme deux
 * navigateurs le feraient. Vérifie : inscription/connexion zéro-connaissance,
 * organisation, invitation→équipe, dossiers/fichiers chiffrés, héritage des
 * clés, partage profond, permissions (403 attendus), versions, corbeille,
 * liens publics, journal d'audit, co-édition temps réel chiffrée (CRDT +
 * présence + lecture seule appliquée par le relais) et RÉVOCATION AVEC
 * ROTATION DE CLÉS (révocation profonde du sous-arbre, CEK en cache morte,
 * versions et backlog collab re-chiffrés, liens révoqués, garde d'époque 409).
 *
 * Lancer :  npm run test:e2e   (depuis web-studio/ ; ~1-2 min, Argon2id oblige)
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import * as Y from "yjs";

import { DriveApi, ApiError } from "../src/drive-cloud/api";
import { buildRegistration, prepareLogin, unlockAccount, signLoginChallenge, type AccountKeys } from "../src/drive-cloud/account";
import type { LoginResponse } from "../src/drive-cloud/types";
import * as ops from "../src/drive-cloud/ops";
import { encryptContent, decryptContent, decryptName } from "../src/drive-cloud/node-crypto";
import { promoteRecoveryAdmin, restoreNodeAccess, withOrgKey, decryptRecoveryNodeNames } from "../src/drive-cloud/recovery";
import type { RecoveryContext } from "../src/drive-cloud/recovery";
import { revokeShareWithRotation } from "../src/drive-cloud/rotate";
import { EncryptedYjsProvider } from "../src/drive-cloud/collab-provider";
import { generateRecipientKeypair, encryptForRecipients } from "../src/crypto/recipients";
import { fromHex } from "../src/format/canonical";
import type { KdfParams } from "../src/drive-cloud/kdf";
import type { RoleDef } from "../src/drive-cloud/types";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const enc = new TextEncoder();
const dec = new TextDecoder();
const eq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

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
function info(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(`  ℹ ${msg}`);
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
    ok(name, e instanceof ApiError && (e.status === status || (status === 403 && e.status === 404)), `reçu ${e instanceof ApiError ? e.status : e}`);
  }
}

interface TestUser {
  api: DriveApi;
  keys: AccountKeys;
  user: { id: string; email: string; displayName: string; p256PublicHex: string; ed25519PublicHex: string; fingerprint: string };
  password: string;
}

async function newUser(base: string, email: string, name: string): Promise<TestUser> {
  const api = new DriveApi({ baseUrl: base });
  const password = `Motdepasse!42-${name}`;
  const { payload, keys } = await buildRegistration(email, password, name);
  const res = await api.register(payload);
  api.setTokens({ accessToken: res.accessToken, accessTokenExpiresAt: res.accessTokenExpiresAt, refreshToken: res.refreshToken });
  return { api, keys, user: res.user, password };
}

/**
 * Full oracle-free login on a fresh client: prelogin → derive → init (challenge)
 * → sign → verify. Returns the raw server response (a session OR an MFA
 * challenge) plus the derived masterKey to unlock the bundle.
 */
async function loginFull(
  base: string,
  email: string,
  password: string,
): Promise<{ api: DriveApi; res: LoginResponse; masterKey: Uint8Array }> {
  const api = new DriveApi({ baseUrl: base });
  const pre = await api.prelogin(email);
  const { authSignSeedHex, masterKey } = await prepareLogin(password, pre.kdfSalt, pre.kdfParams as KdfParams);
  const { challengeId, challenge } = await api.loginInit(email);
  const signature = await signLoginChallenge(challenge, authSignSeedHex);
  const res = await api.loginVerify(email, challengeId, signature);
  return { api, res, masterKey };
}

async function main(): Promise<void> {
  const pgPort = 54000 + Math.floor(Math.random() * 900);
  const dataDir = mkdtempSync(join(tmpdir(), "elium-e2e-pg-"));
  const blobDir = mkdtempSync(join(tmpdir(), "elium-e2e-blobs-"));

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
  const { query, closePool } = await import("../../server/src/db/pool");

  await migrate();
  await migrate(); // ré-exécution : doit être idempotente (bug corrigé)
  const tpl = await query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM roles WHERE org_id IS NULL`);
  ok("migrations idempotentes (7 modèles de rôles, pas de doublons)", tpl[0]?.n === 7, `n=${tpl[0]?.n}`);

  const app = await buildApp();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = (app.server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}/api`;

  const health = await fetch(`${base}/health`);
  ok("API démarrée (/api/health)", health.ok);

  let provA: InstanceType<typeof EncryptedYjsProvider> | null = null;
  let provB: InstanceType<typeof EncryptedYjsProvider> | null = null;
  let provB2: InstanceType<typeof EncryptedYjsProvider> | null = null;

  try {
    // =========================================================================
    section("Comptes zéro-connaissance (2 utilisateurs)");
    const alice = await newUser(base, "alice@acme.fr", "Alice");
    const bob = await newUser(base, "bob@acme.fr", "Bob");
    ok("inscription d'Alice et Bob", !!alice.user.id && !!bob.user.id);

    // Connexion « autre appareil », login SANS oracle : le serveur ne reçoit
    // qu'une signature sur un défi aléatoire, jamais d'équivalent-mot-de-passe.
    const { res: loginRes, masterKey } = await loginFull(base, alice.user.email, alice.password);
    const login = loginRes as { keyBundle: import("../src/drive-cloud/kdf").KeyBundle; user: typeof alice.user; accessToken: string };
    const keysAgain = await unlockAccount(login.keyBundle, masterKey, login.user);
    ok("login multi-appareil (défi-réponse Ed25519) : mêmes clés privées restituées",
      keysAgain.recipient.privateHex === alice.keys.recipient.privateHex
      && keysAgain.identity.privateKeyHex === alice.keys.identity.privateKeyHex);

    const rt = alice.api.getTokens()?.refreshToken ?? "";
    const refreshed = await fetch(`${base}/auth/refresh`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ refreshToken: rt }) });
    ok("rotation du refresh token", refreshed.ok);
    const rot = (await refreshed.json()) as { accessToken: string; accessTokenExpiresAt: number; refreshToken: string };
    alice.api.setTokens(rot);

    // Mauvaise signature (mauvais mot de passe) → 401.
    const apiWrong = new DriveApi({ baseUrl: base });
    const preW = await apiWrong.prelogin(alice.user.email);
    const wrongSeed = await prepareLogin("MauvaisMotDePasse!", preW.kdfSalt, preW.kdfParams as KdfParams);
    const initWrong = await apiWrong.loginInit(alice.user.email);
    const wrongSig = await signLoginChallenge(initWrong.challenge, wrongSeed.authSignSeedHex);
    await expectStatus("mauvais mot de passe (signature invalide) refusé (401)",
      apiWrong.loginVerify(alice.user.email, initWrong.challengeId, wrongSig), 401);

    // Un défi est à usage unique : le rejouer est refusé.
    const apiReplay = new DriveApi({ baseUrl: base });
    const preR = await apiReplay.prelogin(alice.user.email);
    const goodSeed = await prepareLogin(alice.password, preR.kdfSalt, preR.kdfParams as KdfParams);
    const initReplay = await apiReplay.loginInit(alice.user.email);
    const goodSig = await signLoginChallenge(initReplay.challenge, goodSeed.authSignSeedHex);
    await apiReplay.loginVerify(alice.user.email, initReplay.challengeId, goodSig);
    await expectStatus("rejouer le même défi est refusé (usage unique)",
      new DriveApi({ baseUrl: base }).loginVerify(alice.user.email, initReplay.challengeId, goodSig), 401);

    // =========================================================================
    section("Organisation, invitation, équipe");
    const orgKp = await generateRecipientKeypair();
    const wrappedOrgPrivate = JSON.parse(dec.decode(await encryptForRecipients(fromHex(orgKp.privateHex), [alice.keys.recipient.publicHex]))) as Record<string, unknown>;
    const created = await alice.api.createOrg({ name: "ACME SARL", slug: "acme", orgPublicHex: orgKp.publicHex, wrappedOrgPrivate });
    const org = created.org;
    const roleIdByKey: Record<string, string> = Object.fromEntries(created.roles.map((r) => [r.key, r.id]));
    ok("création de l'organisation + rôles système clonés", !!org.id && !!roleIdByKey["owner"] && !!roleIdByKey["editor"] && !!roleIdByKey["viewer"]);

    const ctxA: ops.OpsCtx = { api: alice.api, keys: alice.keys, userId: alice.user.id, orgId: org.id, orgPublicHex: org.orgPublicHex, roleIdByKey };

    // Bob n'est pas membre : la liste des rôles doit être refusée.
    await expectStatus("non-membre : accès aux rôles refusé", bob.api.listRoles(org.id), 403);

    const invite = await alice.api.invite(org.id, { email: bob.user.email, roleId: roleIdByKey["editor"]! });
    const joined = await bob.api.acceptInvite(invite.token);
    ok("invitation acceptée → Bob rejoint l'équipe", joined.orgId === org.id);
    const bobRoles = (await bob.api.listRoles(org.id)).roles as RoleDef[];
    const bobRoleIdByKey: Record<string, string> = Object.fromEntries(bobRoles.map((r) => [r.key, r.id]));
    ok("Bob (membre) lit les rôles de l'org", bobRoles.length >= 7);
    const ctxB: ops.OpsCtx = { api: bob.api, keys: bob.keys, userId: bob.user.id, orgId: org.id, orgPublicHex: org.orgPublicHex, roleIdByKey: bobRoleIdByKey };

    await expectStatus("invitation réutilisée refusée", bob.api.acceptInvite(invite.token), 400);

    // =========================================================================
    section("Fichiers chiffrés, héritage des clés, partage profond");
    const folder = await ops.createFolder(ctxA, null, "Dossier Projet X");
    const content1 = enc.encode(`Contenu SECRET v1 — ${"forêt".repeat(200)}`);
    await ops.uploadFile(ctxA, folder.id, new File([content1 as unknown as BlobPart], "rapport.txt"));
    const folderEntryA = (await ops.listFolder(ctxA, null)).find((e) => e.id === folder.id)!;
    let rapportA = (await ops.listFolder(ctxA, folder.id)).find((e) => e.name === "rapport.txt")!;
    ok("Alice crée dossier + fichier chiffrés (nom déchiffré OK)", !!folderEntryA && !!rapportA);

    const back = await ops.downloadFile(ctxA, rapportA);
    ok("aller-retour chiffrement : contenu téléchargé identique", eq(back.bytes, content1));

    // Permissions : Bob (éditeur d'org) ne peut PAS créer à la racine (space.create).
    await expectStatus("Bob : création à la racine refusée", ops.createFolder(ctxB, null, "pirate"), 403);
    // Ni voir le dossier d'Alice avant partage.
    await expectStatus("Bob : dossier non partagé invisible (404)", bob.api.getNode(folder.id), 404);

    // Partage PROFOND du dossier (le fichier existant doit être ré-emballé pour Bob).
    await ops.shareWithUser(ctxA, folderEntryA, bob.user as never, roleIdByKey["editor"]!);
    const bobChildren = await ops.listFolder(ctxB, folder.id);
    const rapportB = bobChildren.find((e) => e.name === "rapport.txt");
    ok("partage profond : Bob voit le fichier existant ET déchiffre son nom", !!rapportB);
    if (rapportB) {
      const dlB = await ops.downloadFile(ctxB, rapportB);
      ok("Bob déchiffre le contenu du fichier pré-existant", eq(dlB.bytes, content1));
    }

    // Héritage à la création : Bob crée un fichier DANS le dossier partagé →
    // Alice doit pouvoir le déchiffrer sans re-partage.
    const contentBob = enc.encode("Note de Bob — héritage des clés");
    await ops.uploadFile(ctxB, folder.id, new File([contentBob as unknown as BlobPart], "note-bob.txt"));
    const noteA = (await ops.listFolder(ctxA, folder.id)).find((e) => e.name === "note-bob.txt");
    ok("héritage : Alice déchiffre le fichier créé par Bob", !!noteA);
    if (noteA) ok("…et son contenu", eq((await ops.downloadFile(ctxA, noteA)).bytes, contentBob));

    // Renommage propagé (même clé de nœud, nouveau nom chiffré).
    await ops.renameNode(ctxA, rapportA, "rapport-final.txt");
    const renamedB = (await ops.listFolder(ctxB, folder.id)).find((e) => e.id === rapportA.id);
    ok("renommage visible et déchiffrable par Bob", renamedB?.name === "rapport-final.txt");
    rapportA = (await ops.listFolder(ctxA, folder.id)).find((e) => e.id === rapportA.id)!;

    // =========================================================================
    section("Versions");
    const key = await ops.nodeKeyFrom(ctxA, rapportA.myWrappedKey);
    const content2 = enc.encode("Contenu v2 — remplacé");
    const enc2 = await encryptContent(key!, content2);
    await alice.api.putContent(rapportA.id, enc2.ciphertext, enc2.nonceHex);
    const versions = (await alice.api.listVersions(rapportA.id)).versions as { id: string; versionNo: number }[];
    ok("2 versions après ré-upload", versions.length === 2, `n=${versions.length}`);
    const v1 = versions.find((v) => v.versionNo === 1);
    if (v1) {
      const dlv1 = await ops.downloadVersion(ctxA, rapportA, v1.id);
      ok("téléchargement de la v1 = contenu d'origine", eq(dlv1.bytes, content1));
      await alice.api.restoreVersion(rapportA.id, v1.id);
      rapportA = (await ops.listFolder(ctxA, folder.id)).find((e) => e.id === rapportA.id)!;
      ok("restauration v1 = contenu courant", eq((await ops.downloadFile(ctxA, rapportA)).bytes, content1));
    }

    // =========================================================================
    section("Lien de partage public (anonyme)");
    const link = await ops.createShareLink(ctxA, rapportA, roleIdByKey["viewer"]!);
    const anon = new DriveApi({ baseUrl: base });
    const opened = await ops.openSharedLink(anon, link.token, link.secret, link.publicHex);
    ok("résolution anonyme du lien + nom déchiffré", opened.name === "rapport-final.txt", opened.name);
    ok("téléchargement + déchiffrement anonymes", eq((await opened.download()).bytes, content1));
    await expectStatus("lien invalide → 404", anon.resolveLink("jeton-bidon"), 404);

    // =========================================================================
    section("Permissions d'organisation");
    await expectStatus("Bob : liste des membres refusée (member.view)", bob.api.listMembers(org.id), 403);
    await expectStatus("Bob : création de rôle refusée (role.create)", bob.api.createRole(org.id, { name: "X", permissions: ["node.view"] }), 403);
    const cat = await bob.api.permissionCatalog();
    const catList = Array.isArray(cat) ? cat : cat.permissions;
    ok("catalogue de permissions lisible par tout membre", catList.length >= 30, `n=${catList.length}`);

    // =========================================================================
    section("Co-édition temps réel chiffrée (CRDT + présence + relais)");
    const doc = await ops.createCollabDoc(ctxA, folder.id, "Doc de réunion");
    const docA = (await ops.listFolder(ctxA, folder.id)).find((e) => e.id === doc.id)!;
    const docB = (await ops.listFolder(ctxB, folder.id)).find((e) => e.id === doc.id)!;
    const keyA = await ops.nodeKeyFrom(ctxA, docA.myWrappedKey);
    const keyB = await ops.nodeKeyFrom(ctxB, docB.myWrappedKey);
    ok("héritage : Bob détient la clé du doc collaboratif", !!keyB);

    const ydocA = new Y.Doc();
    const ydocB = new Y.Doc();
    let canWriteB: boolean | null = null;
    provA = new EncryptedYjsProvider(alice.api, doc.id, keyA!, ydocA, { name: "Alice", color: "#e11d48" }, {});
    provB = new EncryptedYjsProvider(bob.api, doc.id, keyB!, ydocB, { name: "Bob", color: "#16a34a" }, { onReady: (c) => { canWriteB = c; } });
    await provA.connect();
    await provB.connect();
    await sleep(600);

    ydocA.getText("t").insert(0, "Bonjour multi-utilisateurs !");
    await sleep(1200);
    ok("convergence CRDT A→B (updates chiffrés via le relais)", ydocB.getText("t").toString() === "Bonjour multi-utilisateurs !", ydocB.getText("t").toString());

    ydocB.getText("t").insert(0, "Re : ");
    await sleep(1200);
    ok("convergence CRDT B→A", ydocA.getText("t").toString() === "Re : Bonjour multi-utilisateurs !", ydocA.getText("t").toString());
    ok("Bob peut écrire (rôle éditeur)", canWriteB === true, String(canWriteB));

    const seenByB = [...provB.awareness.getStates().values()].map((s) => (s as { user?: { name?: string } }).user?.name).filter(Boolean);
    ok("présence : Bob voit Alice", seenByB.includes("Alice"), seenByB.join(","));

    provB.destroy(); provB = null;
    provA.destroy(); provA = null;

    // Lecture seule appliquée PAR LE RELAIS. Doc dédié à la RACINE partagé
    // DIRECTEMENT à Bob en « viewer » (pas d'éditeur hérité d'un dossier parent).
    const roDoc = await ops.createCollabDoc(ctxA, null, "Note lecture seule");
    const roDocA = (await ops.listFolder(ctxA, null)).find((e) => e.id === roDoc.id)!;
    await ops.shareWithUser(ctxA, roDocA, bob.user as never, roleIdByKey["viewer"]!);
    const roDocB = (await ops.listFolder(ctxB, null)).find((e) => e.id === roDoc.id);
    ok("Bob (lecteur) voit le doc partagé en lecture seule", !!roDocB);
    const roKeyA = await ops.nodeKeyFrom(ctxA, roDocA.myWrappedKey);
    const roKeyB = roDocB ? await ops.nodeKeyFrom(ctxB, roDocB.myWrappedKey) : null;

    const ydocRA = new Y.Doc();
    const ydocRB = new Y.Doc();
    let canWriteRB: boolean | null = null;
    provA = new EncryptedYjsProvider(alice.api, roDoc.id, roKeyA!, ydocRA, { name: "Alice", color: "#e11d48" }, {});
    provB2 = new EncryptedYjsProvider(bob.api, roDoc.id, roKeyB!, ydocRB, { name: "Bob", color: "#16a34a" }, { onReady: (c) => { canWriteRB = c; } });
    await provA.connect();
    await provB2.connect();
    await sleep(600);
    ok("Bob connecté en lecture seule (canWrite=false)", canWriteRB === false, String(canWriteRB));

    ydocRA.getText("t").insert(0, "Officiel. ");
    await sleep(900);
    ok("le lecteur reçoit bien les updates de l'éditeur", ydocRB.getText("t").toString() === "Officiel. ", ydocRB.getText("t").toString());

    const before = ydocRA.getText("t").toString();
    ydocRB.getText("t").insert(0, "SABOTAGE-");
    await sleep(1000);
    ok("le relais REJETTE les écritures d'un lecteur", ydocRA.getText("t").toString() === before, ydocRA.getText("t").toString());
    provA.destroy(); provA = null;
    provB2.destroy(); provB2 = null;

    // =========================================================================
    section("Corbeille et purge");
    await ops.uploadFile(ctxA, null, new File([enc.encode("brouillon") as unknown as BlobPart], "scratch.txt"));
    const scratch = (await ops.listFolder(ctxA, null)).find((e) => e.name === "scratch.txt")!;
    await alice.api.trashNode(scratch.id);
    const trash1 = await ops.listTrash(ctxA);
    ok("corbeille : élément présent, nom déchiffré", trash1.some((e) => e.id === scratch.id && e.name === "scratch.txt"));
    await alice.api.restoreNode(scratch.id);
    ok("restauration depuis la corbeille", (await ops.listTrash(ctxA)).every((e) => e.id !== scratch.id));
    await alice.api.trashNode(scratch.id);
    await alice.api.purgeNode(scratch.id);
    await expectStatus("purge définitive → nœud introuvable", alice.api.getNode(scratch.id), 404);

    // =========================================================================
    section("Révocation + rotation de clés (durcissement P2)");
    // Bob met en cache les clés qu'il détient LÉGITIMEMENT avant sa révocation
    // — exactement ce qu'un client malveillant conserverait pour plus tard.
    const bobFolderEntry = (await ops.listFolder(ctxB, null)).find((e) => e.id === folder.id)!;
    const bobFolderKey = (await ops.nodeKeyFrom(ctxB, bobFolderEntry.myWrappedKey))!;
    const bobRapportEntry = (await ops.listFolder(ctxB, folder.id)).find((e) => e.id === rapportA.id)!;
    const bobRapportKey = (await ops.nodeKeyFrom(ctxB, bobRapportEntry.myWrappedKey))!;
    ok("préparation : Bob détient les CEK du dossier et du fichier", !!bobFolderKey && !!bobRapportKey);

    const folderShares = (await alice.api.listShares(folder.id)).shares as { id: string; principalType: string; principalId: string }[];
    const bobFolderShare = folderShares.find((s) => s.principalType === "user" && s.principalId === bob.user.id)!;
    const folderEntryFresh = (await ops.listFolder(ctxA, null)).find((e) => e.id === folder.id)!;
    const stats = await revokeShareWithRotation(ctxA, folderEntryFresh, bobFolderShare.id);
    ok("révocation + rotation en cascade sans échec", stats.rotated >= 4 && stats.skipped === 0, JSON.stringify(stats));

    // --- Autorisation : révocation PROFONDE --------------------------------
    await expectStatus("Bob perd l'accès au dossier", bob.api.getNode(folder.id), 404);
    await expectStatus("révocation profonde : Bob perd AUSSI l'accès direct aux enfants", bob.api.getNode(rapportA.id), 404);
    ok("…mais garde l'accès au fichier dont il est PROPRIÉTAIRE",
      await bob.api.getNode(noteA!.id).then(() => true).catch(() => false));
    ok("…et garde son partage direct indépendant (autre sous-arbre)",
      await bob.api.getNode(roDoc.id).then(() => true).catch(() => false));

    // --- Cryptographie : la CEK en cache de Bob est morte -------------------
    const rapportAfter = (await ops.listFolder(ctxA, folder.id)).find((e) => e.id === rapportA.id)!;
    ok("époque de clé incrémentée", (rapportAfter.keyEpoch ?? 1) >= 2, `epoch=${rapportAfter.keyEpoch}`);
    ok("Alice déchiffre toujours nom + contenu après rotation",
      rapportAfter.name === "rapport-final.txt" && eq((await ops.downloadFile(ctxA, rapportAfter)).bytes, content1));

    const freshCt = await alice.api.getContent(rapportA.id);
    const bobKeyDead = await decryptContent(bobRapportKey, freshCt.nonceHex, freshCt.bytes).then(() => false).catch(() => true);
    ok("la CEK en cache de Bob ne déchiffre PLUS le contenu re-chiffré", bobKeyDead);
    const folderAfter = (await ops.listFolder(ctxA, null)).find((e) => e.id === folder.id)!;
    const bobFolderKeyDead = await decryptName(bobFolderKey, folderAfter.nameEncrypted, folderAfter.nameNonce).then(() => false).catch(() => true);
    ok("…ni le nom re-chiffré du dossier", bobFolderKeyDead);

    // --- Versions : l'historique complet a tourné aussi ---------------------
    const versAfter = (await alice.api.listVersions(rapportA.id)).versions as { id: string; versionNo: number; keyEpoch: number }[];
    ok("toutes les versions sont à la nouvelle époque de clé",
      versAfter.length === 2 && versAfter.every((v) => v.keyEpoch === (rapportAfter.keyEpoch ?? 2)),
      versAfter.map((v) => `v${v.versionNo}:e${v.keyEpoch}`).join(","));
    const v1After = versAfter.find((v) => v.versionNo === 1)!;
    ok("la v1 re-chiffrée restitue toujours le contenu d'origine",
      eq((await ops.downloadVersion(ctxA, rapportAfter, v1After.id)).bytes, content1));

    // --- Liens externes : porteurs de l'ancienne CEK → révoqués -------------
    await expectStatus("le lien public créé avant la rotation est révoqué", anon.resolveLink(link.token), 404);

    // --- Collaboration : backlog compacté sous la nouvelle clé --------------
    const docAfter = (await ops.listFolder(ctxA, folder.id)).find((e) => e.id === doc.id)!;
    const docKeyA2 = (await ops.nodeKeyFrom(ctxA, docAfter.myWrappedKey))!;
    const { updates: compacted } = await alice.api.getCollabUpdates(doc.id, 0);
    ok("backlog collab compacté en un seul snapshot", compacted.length === 1, `n=${compacted.length}`);
    const ydocA2 = new Y.Doc();
    Y.applyUpdate(ydocA2, await decryptContent(docKeyA2, compacted[0]!.nonce, fromHex(compacted[0]!.ciphertext)));
    ok("le snapshot re-chiffré restitue l'état complet du document",
      ydocA2.getText("t").toString() === "Re : Bonjour multi-utilisateurs !", ydocA2.getText("t").toString());
    const bobDocKeyDead = await decryptContent(keyB!, compacted[0]!.nonce, fromHex(compacted[0]!.ciphertext)).then(() => false).catch(() => true);
    ok("l'ancienne clé collab de Bob ne déchiffre pas le snapshot", bobDocKeyDead);
    await expectStatus("Bob : backlog collab refusé après révocation", bob.api.getCollabUpdates(doc.id, 0), 403);

    // --- Concurrence : écrire avec une époque périmée est rejeté (409) ------
    const staleWrite = await encryptContent(docKeyA2, enc.encode("écriture périmée"));
    await expectStatus("écriture avec une époque de clé périmée → 409",
      alice.api.putContent(rapportA.id, staleWrite.ciphertext, staleWrite.nonceHex, 1), 409);

    // =========================================================================
    section("MFA — authentification à deux facteurs (TOTP)");
    const { totpNow } = await import("../../server/src/lib/totp");
    // Bob starts without MFA.
    ok("statut initial : MFA désactivée", (await bob.api.mfaStatus()).enabled === false);

    // Enroll: setup → confirm with a live code.
    const setup = await bob.api.mfaSetup();
    ok("setup renvoie un secret + une URI otpauth", /^[A-Z2-7]+$/.test(setup.secret) && setup.otpauthUri.startsWith("otpauth://totp/"));
    await expectStatus("activation refusée avec un mauvais code", bob.api.mfaEnable("000000"), 401);
    const enabled = await bob.api.mfaEnable(totpNow(setup.secret));
    ok("activation avec un code TOTP valide → 10 codes de secours", enabled.enabled === true && enabled.backupCodes.length === 10);
    const st = await bob.api.mfaStatus();
    ok("statut : MFA activée, 10 codes de secours", st.enabled === true && st.backupCodesRemaining === 10);

    // A fresh login now stops at the MFA challenge (no session, no key bundle).
    const { res: chal, masterKey: bobMk } = await loginFull(base, bob.user.email, bob.password);
    ok("login (facteur 1 OK) exige le 2e facteur, sans livrer le bundle",
      (chal as { mfaRequired?: boolean }).mfaRequired === true && !(chal as { keyBundle?: unknown }).keyBundle);
    const mfaToken = (chal as { mfaToken: string }).mfaToken;

    const apiMfa = new DriveApi({ baseUrl: base });
    await expectStatus("2e étape refusée avec un mauvais code", apiMfa.loginMfa(mfaToken, "000000"), 401);
    const done = await apiMfa.loginMfa(mfaToken, totpNow(setup.secret));
    ok("2e étape avec code TOTP valide → session + bundle", !!done.accessToken && !!done.keyBundle);
    const bobKeysAgain = await unlockAccount(done.keyBundle, bobMk, done.user);
    ok("le bundle livré après MFA déverrouille bien les clés", bobKeysAgain.recipient.privateHex === bob.keys.recipient.privateHex);

    // Backup code path: single-use.
    const { res: chal2 } = await loginFull(base, bob.user.email, bob.password);
    const mfaToken2 = (chal2 as { mfaToken: string }).mfaToken;
    const backup = enabled.backupCodes[0]!;
    const apiBackup = new DriveApi({ baseUrl: base });
    const withBackup = await apiBackup.loginMfa(mfaToken2, backup);
    ok("un code de secours ouvre la session", !!withBackup.accessToken);
    ok("…et il est décompté (9 restants)", (await bob.api.mfaStatus()).backupCodesRemaining === 9);
    const { res: chal3 } = await loginFull(base, bob.user.email, bob.password);
    await expectStatus("réutiliser un code de secours est refusé", new DriveApi({ baseUrl: base }).loginMfa((chal3 as { mfaToken: string }).mfaToken, backup), 401);

    // Disable → login is single-step again.
    await expectStatus("désactivation refusée avec un mauvais code", bob.api.mfaDisable("000000"), 401);
    await bob.api.mfaDisable(totpNow(setup.secret));
    ok("MFA désactivée", (await bob.api.mfaStatus()).enabled === false);
    const { res: plain } = await loginFull(base, bob.user.email, bob.password);
    ok("login redevenu direct (session immédiate)", !!(plain as { accessToken?: string }).accessToken && !(plain as { mfaRequired?: boolean }).mfaRequired);

    // =========================================================================
    section("Padding des tailles (réduction de fuite)");
    // Deux fichiers de tailles TRÈS différentes mais petites doivent produire la
    // MÊME taille chiffrée stockée (padding Padmé → même bucket) : la taille
    // réelle ne fuit plus au serveur.
    const padFolder = await ops.createFolder(ctxA, null, "padding");
    await ops.uploadFile(ctxA, padFolder.id, new File([enc.encode("a") as unknown as BlobPart], "un-octet.bin"));
    await ops.uploadFile(ctxA, padFolder.id, new File([enc.encode("z".repeat(40)) as unknown as BlobPart], "quarante.bin"));
    const padKids = await ops.listFolder(ctxA, padFolder.id);
    const s1 = padKids.find((e) => e.name === "un-octet.bin")!.sizeBytes;
    const s40 = padKids.find((e) => e.name === "quarante.bin")!.sizeBytes;
    ok("1 octet et 40 octets → même taille chiffrée stockée (bucket identique)", s1 === s40 && s1 > 0, `s1=${s1} s40=${s40}`);
    const back1 = await ops.downloadFile(ctxA, padKids.find((e) => e.name === "un-octet.bin")!);
    ok("le padding est transparent : contenu 1 octet restitué exactement", eq(back1.bytes, enc.encode("a")));

    // =========================================================================
    section("Quotas de stockage");
    const usage0 = await alice.api.getOrgUsage(org.id);
    ok("usage de l'org lisible et non nul (des blobs ont été stockés)", usage0.usedBytes > 0 && usage0.quotaBytes === null, JSON.stringify(usage0));

    // Serre le quota avec une petite marge : un petit ajout passe, un gros
    // dépassement est refusé (507). Marges choisies pour rester valides malgré
    // le padding (un petit fichier ≤ ~4 Ko chiffré).
    await alice.api.setOrgQuota(org.id, usage0.usedBytes + 4096);
    await ops.uploadFile(ctxA, null, new File([enc.encode("x".repeat(10)) as unknown as BlobPart], "petit.bin"));
    ok("upload sous le quota accepté", (await alice.api.getOrgUsage(org.id)).usedBytes <= usage0.usedBytes + 4096);

    const big = enc.encode("y".repeat(200000));
    const quotaNode = await ops.uploadFile(ctxA, null, new File([big as unknown as BlobPart], "gros-placeholder.bin")).then(() => null).catch((e) => e);
    // uploadFile crée d'abord le nœud puis PUT le contenu : le PUT doit échouer en 507.
    ok("upload au-dessus du quota refusé (507)", quotaNode instanceof ApiError && quotaNode.status === 507, String(quotaNode));

    const usedBefore = (await alice.api.getOrgUsage(org.id)).usedBytes;
    await alice.api.setOrgQuota(org.id, null);
    await ops.uploadFile(ctxA, null, new File([big as unknown as BlobPart], "gros-ok.bin"));
    ok("quota remis à illimité → gros upload accepté", (await alice.api.getOrgUsage(org.id)).usedBytes > usedBefore + 100000);

    await expectStatus("Bob (éditeur) ne peut pas changer le quota (storage.quota.manage)", bob.api.setOrgQuota(org.id, 1), 403);

    // =========================================================================
    section("Rate-limiting (anti-brute-force)");
    // /auth/login/init est plafonné (25/min/IP). Un flood serré doit déclencher
    // un 429 applicatif (code propre, pas une fuite interne).
    let got429 = false;
    for (let k = 0; k < 40 && !got429; k++) {
      try {
        await new DriveApi({ baseUrl: base }).loginInit(`flood-${k}@nobody.example`);
      } catch (e) {
        if (e instanceof ApiError && e.status === 429) got429 = true;
      }
    }
    ok("le flood de /auth/login/init finit par être limité (429)", got429);

    // =========================================================================
    section("SSO (OIDC) + SCIM entreprise");
    const { generateKeyPairSync, createSign } = await import("node:crypto");
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = { ...(publicKey.export({ format: "jwk" }) as Record<string, unknown>), kid: "test-1" };
    const ISS = "https://idp.test";
    const AUD = "elium-drive";

    await alice.api.setOrgSso(org.id, { issuer: ISS, clientId: AUD, jwks: [jwk], allowedDomains: ["acme.fr"] });
    ok("configuration SSO (OIDC) enregistrée", !!(await alice.api.getOrgSso(org.id)).sso);

    const b64u = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const signIdToken = (claims: Record<string, unknown>, key = privateKey) => {
      const head = b64u({ alg: "RS256", typ: "JWT", kid: "test-1" });
      const body = b64u(claims);
      const sig = createSign("sha256").update(`${head}.${body}`).sign(key).toString("base64url");
      return `${head}.${body}.${sig}`;
    };
    const nowS = Math.floor(Date.now() / 1000);
    const claimsFor = (email: string, extra: Record<string, unknown> = {}) =>
      ({ iss: ISS, aud: AUD, sub: "idp-bob-123", email, email_verified: true, exp: nowS + 300, ...extra });

    // Bob is an active member → SSO verifies his identity and opens a session.
    const ssoApi = new DriveApi({ baseUrl: base });
    const ssoRes = await ssoApi.ssoVerify(org.id, signIdToken(claimsFor(bob.user.email)));
    ok("SSO : session émise + bundle pour un membre", !!ssoRes.accessToken && !!ssoRes.keyBundle);
    // Zero-knowledge : le bundle ne se déverrouille qu'avec la phrase de passe.
    const preBob = await new DriveApi({ baseUrl: base }).prelogin(bob.user.email);
    const ssoBobMk = (await prepareLogin(bob.password, preBob.kdfSalt, preBob.kdfParams as KdfParams)).masterKey;
    const ssoKeys = await unlockAccount(ssoRes.keyBundle, ssoBobMk, ssoRes.user);
    ok("le bundle livré par SSO se déverrouille avec la phrase de passe (zéro-connaissance)",
      ssoKeys.recipient.privateHex === bob.keys.recipient.privateHex);

    await expectStatus("SSO : mauvaise audience → 401", ssoApi.ssoVerify(org.id, signIdToken(claimsFor(bob.user.email, { aud: "autre" }))), 401);
    await expectStatus("SSO : jeton expiré → 401", ssoApi.ssoVerify(org.id, signIdToken(claimsFor(bob.user.email, { exp: nowS - 500 }))), 401);
    await expectStatus("SSO : domaine e-mail non autorisé → 401", ssoApi.ssoVerify(org.id, signIdToken(claimsFor("eve@evil.com"))), 401);
    const { privateKey: otherKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    await expectStatus("SSO : signature forgée (autre clé) → 401", ssoApi.ssoVerify(org.id, signIdToken(claimsFor(bob.user.email), otherKey)), 401);
    await expectStatus("SSO : e-mail sans compte membre → 401", ssoApi.ssoVerify(org.id, signIdToken(claimsFor("inconnu@acme.fr"))), 401);

    // --- SCIM : provisioning + DÉ-provisioning --------------------------------
    const { token: scimTok } = await alice.api.createScimToken(org.id);
    const scim = (path: string, method: string, body?: unknown, tok = scimTok) =>
      fetch(`${base}/scim/v2/Users${path}`, {
        method,
        headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });

    ok("SCIM : jeton invalide → 401", (await scim("", "GET", undefined, "mauvais-jeton")).status === 401);

    const listResp = await scim(`?filter=${encodeURIComponent(`userName eq "${bob.user.email}"`)}`, "GET");
    const list = (await listResp.json()) as { totalResults: number; Resources: { id: string; userName: string }[] };
    ok("SCIM : liste filtrée par userName trouve le membre", list.totalResults === 1 && list.Resources[0]!.userName === bob.user.email);
    const bobScimId = list.Resources[0]!.id;

    const createResp = await scim("", "POST", { userName: "carol@acme.fr" });
    const scimCreated = (await createResp.json()) as { active: boolean } & Record<string, unknown>;
    ok("SCIM : provisioning d'un nouvel utilisateur crée une invitation (201, active=false)",
      createResp.status === 201 && scimCreated.active === false && !!(scimCreated["urn:elium:params:scim:invite"] as { token?: string })?.token);

    // Deprovision Bob → il perd TOUT accès (SSO ET session existante).
    await scim(`/${bobScimId}`, "PATCH", { Operations: [{ op: "replace", path: "active", value: false }] });
    await expectStatus("SCIM déprovisionné : login SSO refusé (401)", new DriveApi({ baseUrl: base }).ssoVerify(org.id, signIdToken(claimsFor(bob.user.email))), 401);
    await expectStatus("SCIM déprovisionné : accès org immédiatement perdu (403)", bob.api.listRoles(org.id), 403);

    // Re-provision → accès rétabli (l'IdP peut réactiver un compte).
    await scim(`/${bobScimId}`, "PATCH", { Operations: [{ op: "replace", path: "active", value: true }] });
    ok("SCIM réactivé : accès org rétabli", ((await bob.api.listRoles(org.id)).roles as unknown[]).length >= 7);

    // =========================================================================
    section("Recouvrement d'organisation (clé d'org)");
    // A third user, Carol, joins as ADMIN (admin role includes recovery.perform),
    // but holds NO wrapped org key yet — only the creator (Alice) got one.
    const carol = await newUser(base, "carol@acme.fr", "Carol");
    const inviteC = await alice.api.invite(org.id, { email: carol.user.email, roleId: roleIdByKey["admin"]! });
    await carol.api.acceptInvite(inviteC.token);
    const carolRoles = (await carol.api.listRoles(org.id)).roles as RoleDef[];
    const carolRoleIdByKey: Record<string, string> = Object.fromEntries(carolRoles.map((r) => [r.key, r.id]));

    await expectStatus("recouvrement : admin sans clé encore → 404", carol.api.getRecoveryKey(org.id), 404);
    await expectStatus("recouvrement : éditeur (Bob) refusé (recovery.perform)", bob.api.getRecoveryKey(org.id), 403);
    await expectStatus("recouvrement : liste des nœuds refusée à l'éditeur", bob.api.listRecoveryNodes(org.id), 403);

    // Alice (owner, holds the org key since creation) promotes Carol — the org
    // private key is unwrapped in Alice's browser and re-wrapped to Carol.
    const ctxAliceRec: RecoveryContext = { api: alice.api, orgId: org.id, orgPublicHex: org.orgPublicHex, adminKeys: alice.keys.recipient };
    await promoteRecoveryAdmin(ctxAliceRec, { userId: carol.user.id, publicHex: carol.user.p256PublicHex });
    const recAdmins = (await alice.api.listRecoveryAdmins(org.id)).admins;
    ok("Carol promue administratrice de recouvrement (Alice + Carol listées)",
      recAdmins.some((a) => a.userId === carol.user.id) && recAdmins.some((a) => a.userId === alice.user.id),
      recAdmins.map((a) => a.email).join(","));

    // Carol can now unwrap the org key — byte-identical to the real one.
    const ctxCarolRec: RecoveryContext = { api: carol.api, orgId: org.id, orgPublicHex: org.orgPublicHex, adminKeys: carol.keys.recipient };
    const carolOrgPriv = await withOrgKey(ctxCarolRec, async (kp) => kp.privateHex);
    ok("Carol déballe la clé privée d'org (identique à l'originale)", carolOrgPriv === orgKp.privateHex);

    // Alice creates a private file Bob cannot see.
    const rhFolder = await ops.createFolder(ctxA, null, "RH confidentiel");
    const payslip = enc.encode("Fiche de paie — CONFIDENTIEL");
    await ops.uploadFile(ctxA, rhFolder.id, new File([payslip as unknown as BlobPart], "paie.txt"));
    const payslipFile = (await ops.listFolder(ctxA, rhFolder.id)).find((e) => e.name === "paie.txt")!;
    await expectStatus("Bob ne voit pas le fichier RH non partagé (404)", bob.api.getNode(payslipFile.id), 404);

    // Carol browses the org tree through recovery and decrypts names with the org key.
    const recNodes = (await carol.api.listRecoveryNodes(org.id)).nodes;
    const recPayslip = recNodes.find((n) => n.id === payslipFile.id)!;
    ok("recouvrement : le fichier RH figure dans l'arborescence, avec sa clé d'org", !!recPayslip && !!recPayslip.orgWrappedKey);
    const recNames = await decryptRecoveryNodeNames(ctxCarolRec, recNodes);
    ok("recouvrement : Carol déchiffre le nom du fichier via la clé d'org", recNames.get(payslipFile.id) === "paie.txt", recNames.get(payslipFile.id));

    // Carol restores Bob's cryptographic access to that file.
    await restoreNodeAccess(ctxCarolRec, {
      nodeId: payslipFile.id,
      orgWrappedKey: recPayslip.orgWrappedKey,
      targetUserId: bob.user.id,
      targetPublicHex: bob.user.p256PublicHex,
      roleId: carolRoleIdByKey["editor"]!,
    });

    // Bob now decrypts the file — via the org recovery path, without Alice sharing.
    const bobPayslipNode = await bob.api.getNode(payslipFile.id);
    ok("recouvrement : Bob a désormais accès au fichier RH", !!bobPayslipNode.myWrappedKey);
    const bobPayslipKey = bobPayslipNode.myWrappedKey ? await ops.nodeKeyFrom(ctxB, bobPayslipNode.myWrappedKey) : null;
    const bobPayslipCt = await bob.api.getContent(payslipFile.id);
    ok("recouvrement : Bob déchiffre le contenu restauré (identique à l'original)",
      !!bobPayslipKey && eq(await decryptContent(bobPayslipKey, bobPayslipCt.nonceHex, bobPayslipCt.bytes), payslip));

    // An editor cannot perform a grant himself (recovery.perform is required).
    await expectStatus("recouvrement : grant refusé à l'éditeur (recovery.perform)",
      bob.api.recoveryGrant(org.id, { nodeId: payslipFile.id, targetUserId: bob.user.id, roleId: carolRoleIdByKey["editor"]!, wrappedKey: {} }), 403);

    // =========================================================================
    section("Journal d'audit");
    const audit = await alice.api.listAudit(org.id, { limit: 200 });
    const actions = new Set((audit.entries as { action: string }[]).map((e) => e.action));
    ok("audit non vide", (audit.entries as unknown[]).length > 5, `n=${(audit.entries as unknown[]).length}`);
    ok("audit trace création/partage/révocation/rotation",
      actions.has("node.create") && actions.has("node.share") && actions.has("node.unshare")
      && actions.has("node.key.rotate") && actions.has("collab.compact"), [...actions].join(","));
    ok("audit trace le recouvrement (promotion + grant)",
      actions.has("recovery.admin.grant") && actions.has("recovery.grant"), [...actions].join(","));
    await expectStatus("Bob : audit refusé (audit.view)", bob.api.listAudit(org.id), 403);
  } finally {
    provA?.destroy();
    provB?.destroy();
    provB2?.destroy();
    await app.close().catch(() => {});
    await closePool().catch(() => {});
    await pg.stop().catch(() => {});
    try { rmSync(dataDir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* verrou Windows */ }
    try { rmSync(blobDir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* idem */ }
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
