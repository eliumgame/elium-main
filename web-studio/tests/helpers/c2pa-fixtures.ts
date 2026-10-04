/**
 * Fabrique de manifestes C2PA de test : une vraie PKI éphémère (racine ECDSA
 * P-256 + feuille de l'algorithme demandé), un manifeste JUMBF/CBOR complet
 * (actions, liaison c2pa.hash.data, hachages d'assertions) signé en COSE_Sign1,
 * incrusté dans un JPEG, un PNG ou un WebP synthétique.
 */
import * as ed from "@noble/ed25519";
import { hashes } from "@noble/ed25519";
import { sha256, sha512 } from "@noble/hashes/sha2.js";
import { ecdsaToDer, int, oid, seq, setOf, tlv } from "../../src/pdf/ops/der";
import { encodeCbor, type CborValue } from "../../src/detector/c2pa/cbor";
import { box, concatBytes, superBox } from "../../src/detector/c2pa/jumbf";

hashes.sha512 = sha512;

export type FixtureAlg = "ES256" | "ES384" | "PS256" | "EdDSA";
export type FixtureContainer = "jpeg" | "png" | "webp";

const te = new TextEncoder();
const subtle = globalThis.crypto.subtle;
const buf = (b: Uint8Array) => b.slice().buffer as ArrayBuffer;
const UUID = new Uint8Array(16).fill(0x11);

const M = (entries: [CborValue, CborValue][]) => new Map<CborValue, CborValue>(entries);

function name(cn: string): Uint8Array {
  return seq(setOf(seq(oid("2.5.4.3"), tlv(0x0c, te.encode(cn)))));
}
const utc = (s: string) => tlv(0x17, te.encode(s));

interface Signer {
  spki: Uint8Array;
  sigAlgDer: Uint8Array;
  sign(data: Uint8Array): Promise<Uint8Array>; // signature X.509 (DER pour ECDSA)
}

async function ecSigner(curve: "P-256" | "P-384"): Promise<Signer> {
  const kp = await subtle.generateKey({ name: "ECDSA", namedCurve: curve }, true, ["sign", "verify"]);
  const hash = curve === "P-256" ? "SHA-256" : "SHA-384";
  return {
    spki: new Uint8Array(await subtle.exportKey("spki", kp.publicKey)),
    sigAlgDer: seq(oid(curve === "P-256" ? "1.2.840.10045.4.3.2" : "1.2.840.10045.4.3.3")),
    sign: async (d) => ecdsaToDer(new Uint8Array(await subtle.sign({ name: "ECDSA", hash }, kp.privateKey, buf(d)))),
  };
}

function makeCert(subjectCn: string, issuerCn: string, subjectSpki: Uint8Array, issuer: Signer): Promise<Uint8Array> {
  const tbs = seq(
    tlv(0xa0, int(2)),
    int(Math.floor(Math.random() * 1e9) + 1),
    issuer.sigAlgDer,
    name(issuerCn),
    seq(utc("200101000000Z"), utc("491231235959Z")),
    name(subjectCn),
    subjectSpki,
  );
  return issuer.sign(tbs).then((sig) => seq(tbs, issuer.sigAlgDer, tlv(0x03, new Uint8Array([0]), sig)));
}

export interface Fixture {
  bytes: Uint8Array;
  rootDer: Uint8Array;
  leafDer: Uint8Array;
}

export interface FixtureOptions {
  alg?: FixtureAlg;
  container?: FixtureContainer;
  digitalSourceType?: string;
  claimGenerator?: string;
  /** Fragmenter le manifeste JPEG en plusieurs segments APP11. */
  fragmentJpeg?: boolean;
  /** Chaîne x5chain : inclure la racine ? (par défaut oui) */
  includeRoot?: boolean;
}

const COSE: Record<FixtureAlg, number> = { ES256: -7, ES384: -35, PS256: -37, EdDSA: -8 };

function pixelData(): Uint8Array {
  return Uint8Array.from({ length: 200 }, (_, i) => (i * 37 + 11) & 0xff);
}

/** Fichier hôte sans manifeste ; renvoie aussi l'offset d'insertion du manifeste. */
function host(container: FixtureContainer): { before: Uint8Array; after: Uint8Array } {
  if (container === "jpeg") {
    const app0 = Uint8Array.from([0xff, 0xe0, 0x00, 0x06, 0x4a, 0x46, 0x49, 0x46]);
    return {
      before: Uint8Array.from([0xff, 0xd8]),
      after: concatBytes([app0, Uint8Array.from([0xff, 0xda, 0x00, 0x02]), pixelData(), Uint8Array.from([0xff, 0xd9])]),
    };
  }
  if (container === "png") {
    const chunk = (t: string, d: Uint8Array) => {
      const out = new Uint8Array(12 + d.length);
      new DataView(out.buffer).setUint32(0, d.length);
      for (let i = 0; i < 4; i++) out[4 + i] = t.charCodeAt(i);
      out.set(d, 8);
      return out;
    };
    const sig = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const ihdr = chunk("IHDR", new Uint8Array(13));
    return {
      before: concatBytes([sig, ihdr]),
      after: concatBytes([chunk("IDAT", pixelData()), chunk("IEND", new Uint8Array(0))]),
    };
  }
  return { before: new Uint8Array(0), after: new Uint8Array(0) }; // WebP géré à part
}

function wrapManifest(container: FixtureContainer, jumbf: Uint8Array, fragment: boolean): Uint8Array {
  if (container === "jpeg") {
    const frags = fragment ? [jumbf.subarray(0, 120), jumbf.subarray(120)] : [jumbf];
    // Fragments suivants : répètent LBox/TBox (8 octets) du premier.
    const header = jumbf.subarray(0, 8);
    return concatBytes(
      frags.map((f, i) => {
        const payload = i === 0 ? f : concatBytes([header, f]);
        const seg = new Uint8Array(2 + 2 + 8 + payload.length);
        seg[0] = 0xff;
        seg[1] = 0xeb;
        new DataView(seg.buffer).setUint16(2, 2 + 8 + payload.length);
        seg[4] = 0x4a;
        seg[5] = 0x50;
        new DataView(seg.buffer).setUint16(6, 0x0211);
        new DataView(seg.buffer).setUint32(8, i + 1);
        seg.set(payload, 12);
        return seg;
      }),
    );
  }
  if (container === "png") {
    const out = new Uint8Array(12 + jumbf.length);
    new DataView(out.buffer).setUint32(0, jumbf.length);
    out.set(te.encode("caBX"), 4);
    out.set(jumbf, 8);
    return out;
  }
  const out = new Uint8Array(8 + jumbf.length + (jumbf.length & 1));
  out.set(te.encode("C2PA"), 0);
  new DataView(out.buffer).setUint32(4, jumbf.length, true);
  out.set(jumbf, 8);
  return out;
}

function assemble(container: FixtureContainer, manifest: Uint8Array): Uint8Array {
  if (container === "webp") {
    const vp8 = concatBytes([te.encode("VP8 "), Uint8Array.from([200, 0, 0, 0]), pixelData()]);
    const body = concatBytes([te.encode("WEBP"), vp8, manifest]);
    const out = new Uint8Array(8 + body.length);
    out.set(te.encode("RIFF"), 0);
    new DataView(out.buffer).setUint32(4, body.length, true);
    out.set(body, 8);
    return out;
  }
  const h = host(container);
  return concatBytes([h.before, manifest, h.after]);
}

export async function buildC2paFixture(opts: FixtureOptions = {}): Promise<Fixture> {
  const alg = opts.alg ?? "ES256";
  const container = opts.container ?? "jpeg";
  const dst = opts.digitalSourceType ?? "http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia";

  // PKI
  const rootCn = "Elium Test Root";
  const leafCn = "Elium Test Signer";
  const root = await ecSigner("P-256");
  const rootDer = await makeCert(rootCn, rootCn, root.spki, root);
  let leafSpki: Uint8Array;
  let signClaim: (d: Uint8Array) => Promise<Uint8Array>;
  if (alg === "ES256" || alg === "ES384") {
    const curve = alg === "ES256" ? "P-256" : "P-384";
    const kp = await subtle.generateKey({ name: "ECDSA", namedCurve: curve }, true, ["sign"]);
    leafSpki = new Uint8Array(await subtle.exportKey("spki", kp.publicKey));
    signClaim = async (d) =>
      new Uint8Array(
        await subtle.sign({ name: "ECDSA", hash: alg === "ES256" ? "SHA-256" : "SHA-384" }, kp.privateKey, buf(d)),
      );
  } else if (alg === "PS256") {
    const kp = await subtle.generateKey(
      { name: "RSA-PSS", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign"],
    );
    leafSpki = new Uint8Array(await subtle.exportKey("spki", kp.publicKey));
    signClaim = async (d) => new Uint8Array(await subtle.sign({ name: "RSA-PSS", saltLength: 32 }, kp.privateKey, buf(d)));
  } else {
    const priv = ed.utils.randomSecretKey();
    const pub = await ed.getPublicKeyAsync(priv);
    leafSpki = seq(seq(oid("1.3.101.112")), tlv(0x03, new Uint8Array([0]), pub));
    signClaim = (d) => ed.signAsync(d, priv);
  }
  const leafDer = await makeCert(leafCn, rootCn, leafSpki, root);

  const actions = encodeCbor(
    M([
      [
        "actions",
        [M([["action", "c2pa.created"], ["digitalSourceType", dst]])],
      ],
    ]),
  );

  // Résolution du point fixe (longueur de l'exclusion = taille du manifeste).
  let exclLen = 0;
  for (let attempt = 0; attempt < 6; attempt++) {
    const actionsBox = superBox(UUID, "c2pa.actions", box("cbor", actions));
    const h = container === "webp" ? undefined : host(container);
    const exclStart = container === "webp" ? 12 + 8 + 200 : h!.before.length;

    // Hachage de liaison : fichier sans le manifeste (taille exclLen).
    const stub = assemble(container, new Uint8Array(exclLen));
    const without = concatBytes([stub.subarray(0, exclStart), stub.subarray(exclStart + exclLen)]);
    const dataBoxFixed = encodeCbor(
      M([
        ["exclusions", [M([["start", exclStart], ["length", exclLen]])]],
        ["alg", "sha256"],
        ["hash", sha256(without)],
        ["name", "jumbf manifest"],
      ]),
    );
    const hashDataBox = superBox(UUID, "c2pa.hash.data", box("cbor", dataBoxFixed));

    const assertionsSuper = superBox(UUID, "c2pa.assertions", actionsBox, hashDataBox);
    const ref = (label: string, node: Uint8Array) =>
      M([["url", `self#jumbf=c2pa.assertions/${label}`], ["hash", sha256(node.subarray(8))]]);
    const claim = encodeCbor(
      M([
        ["claim_generator", opts.claimGenerator ?? "Elium-Test/1.0"],
        ["dc:format", container === "jpeg" ? "image/jpeg" : container === "png" ? "image/png" : "image/webp"],
        ["instanceID", "xmp:iid:test"],
        ["alg", "sha256"],
        ["signature", "self#jumbf=c2pa.signature"],
        ["assertions", [ref("c2pa.actions", actionsBox), ref("c2pa.hash.data", hashDataBox)]],
      ]),
    );
    const protectedBytes = encodeCbor(M([[1, COSE[alg]]]));
    const sigStructure = encodeCbor(["Signature1", protectedBytes, new Uint8Array(0), claim]);
    const signature = await signClaim(sigStructure);
    const chain = opts.includeRoot === false ? [leafDer] : [leafDer, rootDer];
    const cose = encodeCbor({
      tag: 18,
      value: [protectedBytes, M([[33, chain.length === 1 ? chain[0]! : chain]]), null, signature],
    });
    const store = superBox(
      UUID,
      "c2pa",
      superBox(
        UUID,
        "urn:uuid:00000000-0000-0000-0000-000000000001",
        assertionsSuper,
        superBox(UUID, "c2pa.claim", box("cbor", claim)),
        superBox(UUID, "c2pa.signature", box("cbor", cose)),
      ),
    );
    const manifest = wrapManifest(container, store, opts.fragmentJpeg === true);
    if (manifest.length === exclLen) {
      return { bytes: assemble(container, manifest), rootDer, leafDer };
    }
    exclLen = manifest.length;
  }
  throw new Error("le manifeste de test ne converge pas");
}
