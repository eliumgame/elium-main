/**
 * Analyse et vérification d'un manifeste C2PA : parsing JUMBF/CBOR, signature
 * COSE_Sign1 (ES256/ES384/ES512/PS256/PS384/PS512/EdDSA) sur le claim, chaîne
 * X.509, liaison forte `c2pa.hash.data` contre les octets réels, hachages des
 * assertions, et rapprochement avec une liste de confiance.
 *
 * Limites assumées (affichées à l'utilisateur) : pas de vérification de
 * révocation (hors ligne), horodatage RFC 3161 non vérifié, usages de clé /
 * EKU non contrôlés, liaison `c2pa.hash.bmff` (MP4) non vérifiée.
 */
import * as ed from "@noble/ed25519";
import { hashes } from "@noble/ed25519";
import { sha256, sha384, sha512 } from "@noble/hashes/sha2.js";
import {
  CURVE_SIZE,
  DerError,
  children,
  content,
  ecdsaFromDer,
  hashOfOid,
  oidOf,
  parseCertificate,
  readTlv,
  sigAlgOf,
  type Certificate,
  type HashName,
} from "../../pdf/ops/der";
import { CborError, decodeCbor, encodeCbor, isTag, mapGet, type CborValue } from "./cbor";
import { JumbfError, extractManifestStore, parseJumbf, type ContainerKind, type JumbfNode } from "./jumbf";
import { allTrustAnchors, fingerprintOf, type TrustAnchor } from "./trust";

hashes.sha512 = sha512;

export type C2paStatus =
  | "absent" // aucun manifeste dans le fichier
  | "unverified" // manifeste présent mais impossible à vérifier (format/algorithme non pris en charge, illisible)
  | "invalid" // signature, chaîne, liaison ou hachage en échec : manifeste altéré ou falsifié
  | "valid_untrusted" // cryptographie correcte mais émetteur absent de la liste de confiance
  | "valid_trusted"; // cryptographie correcte et chaîne aboutissant à une racine de confiance

export interface C2paReport {
  status: C2paStatus;
  container?: ContainerKind;
  claimGenerator?: string;
  /** Nom (CN) du certificat signataire. */
  issuer?: string;
  algorithm?: string;
  signatureValid?: boolean;
  chainValid?: boolean;
  trustedAnchor?: string;
  /** `true`/`false` si la liaison forte a pu être vérifiée, `undefined` sinon. */
  bindingValid?: boolean;
  assertionsValid?: boolean;
  /** URI IPTC digitalSourceType relevées dans les assertions c2pa.actions. */
  digitalSourceTypes: string[];
  /** Le manifeste déclare un contenu (co)généré par un algorithme entraîné. */
  declaresAi: boolean;
  actions: string[];
  manifestCount: number;
  /** Raisons d'un statut invalide / non vérifié. */
  problems: string[];
  /** Réserves qui ne changent pas le statut (révocation, horodatage…). */
  warnings: string[];
}

export interface VerifyC2paOptions {
  anchors?: readonly TrustAnchor[];
  now?: Date;
}

interface Assertion {
  label: string;
  node: JumbfNode;
  data?: CborValue;
}
interface Manifest {
  label: string;
  claim?: CborValue;
  claimBytes?: Uint8Array;
  assertions: Assertion[];
  signature?: Uint8Array;
}

const baseLabel = (l: string) => l.replace(/__\d+$/, "");

function cborOf(node: JumbfNode): { value: CborValue; bytes: Uint8Array } | undefined {
  const box = (node.children ?? []).find((c) => c.type === "cbor");
  if (!box) return undefined;
  try {
    return { value: decodeCbor(box.payload).value, bytes: box.payload };
  } catch {
    return undefined;
  }
}

function readManifests(store: Uint8Array): Manifest[] {
  const root = parseJumbf(store).find((n) => n.type === "jumb" && n.label === "c2pa");
  if (!root) throw new JumbfError("magasin de manifestes C2PA introuvable");
  const out: Manifest[] = [];
  for (const m of root.children ?? []) {
    if (m.type !== "jumb") continue;
    const manifest: Manifest = { label: m.label ?? "", assertions: [] };
    for (const part of m.children ?? []) {
      if (part.type !== "jumb") continue;
      if (part.label === "c2pa.assertions") {
        for (const a of part.children ?? []) {
          if (a.type !== "jumb" || !a.label) continue;
          manifest.assertions.push({ label: a.label, node: a, data: cborOf(a)?.value });
        }
      } else if (part.label === "c2pa.claim" || part.label === "c2pa.claim.v2") {
        const c = cborOf(part);
        if (c) {
          manifest.claim = c.value;
          manifest.claimBytes = c.bytes;
        }
      } else if (part.label === "c2pa.signature") {
        // COSE_Sign1 (étiquette 18 ou tableau nu) : décodé plus tard.
        manifest.signature = cborOf(part)?.bytes;
      }
    }
    out.push(manifest);
  }
  return out;
}

// ---- Hachage ---------------------------------------------------------------

function hashBytes(alg: string, data: Uint8Array): Uint8Array {
  switch (alg.toLowerCase().replace("-", "")) {
    case "sha256":
      return sha256(data);
    case "sha384":
      return sha384(data);
    case "sha512":
      return sha512(data);
    default:
      throw new Error(`algorithme de hachage non pris en charge : ${alg}`);
  }
}

const eq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

function asBytes(v: CborValue | undefined): Uint8Array | undefined {
  return v instanceof Uint8Array ? v : undefined;
}
function asNumber(v: CborValue | undefined): number | undefined {
  return typeof v === "number" ? v : typeof v === "bigint" ? Number(v) : undefined;
}

function withoutExclusions(bytes: Uint8Array, ex: { start: number; length: number }[]): Uint8Array {
  const sorted = [...ex].sort((a, b) => a.start - b.start);
  const parts: Uint8Array[] = [];
  let at = 0;
  for (const e of sorted) {
    if (e.start < at || e.start + e.length > bytes.length) throw new Error("exclusion hors limites");
    parts.push(bytes.subarray(at, e.start));
    at = e.start + e.length;
  }
  parts.push(bytes.subarray(at));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// ---- Signature -------------------------------------------------------------

const COSE_ALGS: Record<number, { name: string; hash: HashName }> = {
  [-7]: { name: "ES256", hash: "SHA-256" },
  [-35]: { name: "ES384", hash: "SHA-384" },
  [-36]: { name: "ES512", hash: "SHA-512" },
  [-37]: { name: "PS256", hash: "SHA-256" },
  [-38]: { name: "PS384", hash: "SHA-384" },
  [-39]: { name: "PS512", hash: "SHA-512" },
  [-8]: { name: "EdDSA", hash: "SHA-512" },
};

const buf = (b: Uint8Array): ArrayBuffer => b.slice().buffer as ArrayBuffer;

interface CoseSign1 {
  protectedBytes: Uint8Array;
  alg: number;
  chain: Uint8Array[];
  signature: Uint8Array;
}

function parseCose(bytes: Uint8Array): CoseSign1 {
  let v = decodeCbor(bytes).value;
  if (isTag(v)) v = v.value;
  if (!Array.isArray(v) || v.length !== 4) throw new CborError("COSE_Sign1 invalide");
  const protectedBytes = asBytes(v[0]);
  const signature = asBytes(v[3]);
  if (!protectedBytes || !signature) throw new CborError("COSE_Sign1 invalide");
  const prot = protectedBytes.length ? decodeCbor(protectedBytes).value : new Map();
  const alg = asNumber(mapGet(prot, 1));
  if (alg === undefined) throw new CborError("algorithme COSE absent");
  const x5 = mapGet(v[1], 33) ?? mapGet(prot, 33);
  const chain = (Array.isArray(x5) ? x5 : [x5]).map(asBytes).filter((b): b is Uint8Array => !!b);
  return { protectedBytes, alg, chain, signature };
}

/** Vérifie `signature` sur `data` avec la clé du certificat `cert`. */
async function verifyCoseWithCert(
  cert: Certificate,
  alg: { name: string; hash: HashName },
  signature: Uint8Array,
  data: Uint8Array,
): Promise<boolean> {
  const s = globalThis.crypto.subtle;
  if (alg.name === "EdDSA") {
    const spki = children(readTlv(cert.spki));
    const bits = content(spki[1]!);
    if (bits.length !== 33) return false;
    return ed.verifyAsync(signature, data, bits.subarray(1));
  }
  if (alg.name.startsWith("ES")) {
    if (cert.keyType !== "ec" || !cert.curve) return false;
    const key = await s.importKey("spki", buf(cert.spki), { name: "ECDSA", namedCurve: cert.curve }, false, ["verify"]);
    // COSE : r‖s brut, directement le format WebCrypto.
    if (signature.length !== CURVE_SIZE[cert.curve] * 2) return false;
    return s.verify({ name: "ECDSA", hash: alg.hash }, key, buf(signature), buf(data));
  }
  if (cert.keyType !== "rsa") return false;
  const key = await s.importKey("spki", buf(cert.spki), { name: "RSA-PSS", hash: alg.hash }, false, ["verify"]);
  const salt = { "SHA-256": 32, "SHA-384": 48, "SHA-512": 64, "SHA-1": 20 }[alg.hash];
  return s.verify({ name: "RSA-PSS", saltLength: salt }, key, buf(signature), buf(data));
}

/** `cert` est-il bien signé par `issuer` ? (signature X.509 du TBS) */
async function certSignedBy(cert: Certificate, issuer: Certificate): Promise<boolean> {
  try {
    const s = globalThis.crypto.subtle;
    const parts = children(readTlv(cert.sigAlgDer));
    const info = sigAlgOf(oidOf(parts[0]!));
    if (issuer.keyType === "ec") {
      if (!issuer.curve) return false;
      const key = await s.importKey("spki", buf(issuer.spki), { name: "ECDSA", namedCurve: issuer.curve }, false, [
        "verify",
      ]);
      return s.verify(
        { name: "ECDSA", hash: info?.hash ?? "SHA-256" },
        key,
        buf(ecdsaFromDer(cert.signature, CURVE_SIZE[issuer.curve])),
        buf(cert.tbs),
      );
    }
    if (issuer.keyType !== "rsa") return false;
    if (info?.key === "rsa-pss") {
      let hash: HashName = "SHA-1";
      let salt = 20;
      if (parts[1]) {
        for (const p of children(parts[1])) {
          if (p.tag === 0xa0) hash = hashOfOid(oidOf(children(children(p)[0]!)[0]!)) ?? hash;
          if (p.tag === 0xa2) salt = content(children(p)[0]!).reduce((n, b) => n * 256 + b, 0);
        }
      }
      const key = await s.importKey("spki", buf(issuer.spki), { name: "RSA-PSS", hash }, false, ["verify"]);
      return s.verify({ name: "RSA-PSS", saltLength: salt }, key, buf(cert.signature), buf(cert.tbs));
    }
    const key = await s.importKey(
      "spki",
      buf(issuer.spki),
      { name: "RSASSA-PKCS1-v1_5", hash: info?.hash ?? "SHA-256" },
      false,
      ["verify"],
    );
    return s.verify("RSASSA-PKCS1-v1_5", key, buf(cert.signature), buf(cert.tbs));
  } catch {
    return false;
  }
}

// ---- Vérification complète --------------------------------------------------

const AI_SOURCE_RE = /trainedalgorithmicmedia/i;

function collectActions(m: Manifest): { actions: string[]; sources: string[] } {
  const actions: string[] = [];
  const sources: string[] = [];
  for (const a of m.assertions) {
    if (!/^c2pa\.actions(\.v2)?$/.test(baseLabel(a.label))) continue;
    const list = mapGet(a.data, "actions");
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const act = mapGet(item, "action");
      if (typeof act === "string" && !actions.includes(act)) actions.push(act);
      const dst = mapGet(item, "digitalSourceType");
      if (typeof dst === "string" && !sources.includes(dst)) sources.push(dst);
    }
  }
  return { actions, sources };
}

function emptyReport(over: Partial<C2paReport> = {}): C2paReport {
  return {
    status: "absent",
    digitalSourceTypes: [],
    declaresAi: false,
    actions: [],
    manifestCount: 0,
    problems: [],
    warnings: [],
    ...over,
  };
}

export async function verifyC2pa(bytes: Uint8Array, opts: VerifyC2paOptions = {}): Promise<C2paReport> {
  let extracted;
  try {
    extracted = extractManifestStore(bytes);
  } catch (e) {
    return emptyReport({
      status: "unverified",
      problems: [`Manifeste C2PA illisible : ${e instanceof Error ? e.message : "structure invalide"}.`],
    });
  }
  if (!extracted) return emptyReport();

  const report = emptyReport({ container: extracted.container, status: "unverified" });
  let manifests: Manifest[];
  try {
    manifests = readManifests(extracted.store);
  } catch (e) {
    report.problems.push(`Manifeste C2PA illisible : ${e instanceof Error ? e.message : "structure invalide"}.`);
    return report;
  }
  report.manifestCount = manifests.length;
  const active = manifests[manifests.length - 1];
  if (!active || !active.claim || !active.claimBytes || !active.signature) {
    report.problems.push("Le manifeste actif est incomplet (claim ou signature absent).");
    return report;
  }

  const { actions, sources } = collectActions(active);
  report.actions = actions;
  report.digitalSourceTypes = sources;
  report.declaresAi = sources.some((s) => AI_SOURCE_RE.test(s));
  const gen = mapGet(active.claim, "claim_generator") ?? mapGet(active.claim, "claim_generator_info");
  report.claimGenerator =
    typeof gen === "string"
      ? gen
      : typeof mapGet(gen, "name") === "string"
        ? (mapGet(gen, "name") as string)
        : Array.isArray(gen) && typeof mapGet(gen[0], "name") === "string"
          ? (mapGet(gen[0], "name") as string)
          : undefined;

  const claimAlg = (mapGet(active.claim, "alg") as string | undefined) ?? "sha256";
  const invalid: string[] = [];

  // 1. Hachages des assertions référencées par le claim.
  const refs = (mapGet(active.claim, "assertions") ?? mapGet(active.claim, "created_assertions")) as
    | CborValue[]
    | undefined;
  if (Array.isArray(refs)) {
    let ok = true;
    for (const ref of refs) {
      const url = mapGet(ref, "url");
      const hash = asBytes(mapGet(ref, "hash"));
      if (typeof url !== "string" || !hash) continue;
      const label = url.split("/").pop() ?? "";
      const target = active.assertions.find((a) => a.label === label);
      if (!target) {
        ok = false;
        invalid.push(`Assertion référencée introuvable : ${label}.`);
        continue;
      }
      try {
        const alg = (mapGet(ref, "alg") as string | undefined) ?? claimAlg;
        if (!eq(hashBytes(alg, target.node.payload), hash)) {
          ok = false;
          invalid.push(`Le contenu de l'assertion « ${baseLabel(label)} » ne correspond plus à son empreinte.`);
        }
      } catch (e) {
        report.warnings.push(e instanceof Error ? e.message : "hachage d'assertion impossible");
      }
    }
    report.assertionsValid = ok;
  }

  // 2. Liaison forte au contenu.
  const hardBinding = active.assertions.find((a) => baseLabel(a.label) === "c2pa.hash.data");
  if (hardBinding) {
    try {
      const rawEx = mapGet(hardBinding.data, "exclusions");
      const ex = (Array.isArray(rawEx) ? rawEx : []).map((e) => ({
        start: asNumber(mapGet(e, "start")) ?? -1,
        length: asNumber(mapGet(e, "length")) ?? -1,
      }));
      if (ex.some((e) => e.start < 0 || e.length < 0)) throw new Error("exclusions invalides");
      const alg = (mapGet(hardBinding.data, "alg") as string | undefined) ?? claimAlg;
      const expected = asBytes(mapGet(hardBinding.data, "hash"));
      if (!expected) throw new Error("empreinte absente");
      const got = hashBytes(alg, withoutExclusions(bytes, ex));
      report.bindingValid = eq(got, expected);
      if (!report.bindingValid) invalid.push("Les pixels/octets de l'image ne correspondent plus à la signature : fichier modifié après signature.");
    } catch (e) {
      report.warnings.push(`Liaison au contenu non vérifiable : ${e instanceof Error ? e.message : "erreur"}.`);
    }
  } else if (active.assertions.some((a) => /^c2pa\.hash\.(bmff|boxes|collection)/.test(a.label))) {
    report.warnings.push("Liaison au contenu (c2pa.hash.bmff/boxes) non vérifiée par cette version : seule c2pa.hash.data l'est.");
  } else {
    report.warnings.push("Aucune assertion de liaison au contenu (c2pa.hash.data) : l'intégrité de l'image n'est pas garantie.");
  }

  // 3. Signature COSE sur le claim.
  let cose: CoseSign1 | undefined;
  try {
    cose = parseCose(active.signature);
  } catch (e) {
    report.problems.push(`Signature illisible : ${e instanceof Error ? e.message : "COSE invalide"}.`);
  }
  let chainCerts: Certificate[] = [];
  if (cose) {
    const alg = COSE_ALGS[cose.alg];
    report.algorithm = alg?.name ?? `COSE ${cose.alg}`;
    try {
      chainCerts = cose.chain.map((c) => parseCertificate(c));
    } catch (e) {
      report.problems.push(`Chaîne de certificats illisible : ${e instanceof DerError ? e.message : "X.509 invalide"}.`);
    }
    if (!alg) report.problems.push(`Algorithme de signature non pris en charge (${report.algorithm}).`);
    else if (!chainCerts.length) report.problems.push("Aucun certificat (x5chain) dans la signature.");
    else {
      report.issuer = chainCerts[0]!.commonName;
      const sigStructure = encodeCbor(["Signature1", cose.protectedBytes, new Uint8Array(0), active.claimBytes]);
      try {
        report.signatureValid = await verifyCoseWithCert(chainCerts[0]!, alg, cose.signature, sigStructure);
      } catch (e) {
        report.problems.push(`Vérification de signature impossible : ${e instanceof Error ? e.message : "erreur"}.`);
      }
      if (report.signatureValid === false) invalid.push("La signature ne correspond pas au manifeste (altéré ou falsifié).");
    }
  }

  // 4. Chaîne de certificats et confiance.
  if (chainCerts.length) {
    let chainOk = true;
    for (let i = 0; i < chainCerts.length - 1; i++) {
      if (!(await certSignedBy(chainCerts[i]!, chainCerts[i + 1]!))) {
        chainOk = false;
        invalid.push(`Le certificat « ${chainCerts[i]!.commonName} » n'est pas signé par le suivant de la chaîne.`);
        break;
      }
    }
    report.chainValid = chainOk;
    const anchors = opts.anchors ?? allTrustAnchors();
    const anchor = anchors.find((a) => chainCerts.some((c) => fingerprintOf(c.der) === a.fingerprint));
    if (anchor) report.trustedAnchor = anchor.name;
    const now = opts.now ?? new Date();
    if (chainCerts.some((c) => now < c.notBefore || now > c.notAfter)) {
      report.warnings.push("Un certificat de la chaîne est hors de sa période de validité (horodatage non vérifié).");
    }
  }
  report.warnings.push("Révocation des certificats non vérifiée (hors ligne). Horodatage éventuel non vérifié.");

  if (invalid.length) {
    report.status = "invalid";
    report.problems.push(...invalid);
  } else if (report.signatureValid && report.chainValid) {
    report.status = report.trustedAnchor ? "valid_trusted" : "valid_untrusted";
  } else {
    report.status = "unverified";
  }
  return report;
}
