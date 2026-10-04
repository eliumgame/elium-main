import { describe, it, expect } from "vitest";
import { decodeCbor, encodeCbor } from "../src/detector/c2pa/cbor";
import { extractManifestStore } from "../src/detector/c2pa/jumbf";
import { verifyC2pa } from "../src/detector/c2pa/verify";
import { anchorsFromFile, fingerprintOf, parseCertificateFile } from "../src/detector/c2pa/trust";
import { buildC2paFixture, type FixtureAlg, type FixtureContainer } from "./helpers/c2pa-fixtures";

describe("CBOR", () => {
  it("fait l'aller-retour sur les types d'un manifeste", () => {
    const v = new Map<unknown, unknown>([
      ["a", 1],
      ["b", [-5, 70000, 4294967296, "é", new Uint8Array([1, 2])]],
      ["c", { tag: 18, value: null }],
      ["d", true],
    ]);
    const back = decodeCbor(encodeCbor(v as never)).value as Map<string, unknown>;
    expect(back.get("a")).toBe(1);
    expect((back.get("b") as unknown[]).slice(0, 4)).toEqual([-5, 70000, 4294967296, "é"]);
    expect(back.get("c")).toEqual({ tag: 18, value: null });
  });
  it("refuse un CBOR tronqué ou à longueur absurde", () => {
    expect(() => decodeCbor(new Uint8Array([0x82, 0x01]))).toThrow();
    expect(() => decodeCbor(new Uint8Array([0x5a, 0xff, 0xff, 0xff, 0xff]))).toThrow();
  });
});

describe("C2PA : manifeste valide", () => {
  const cases: [FixtureContainer, FixtureAlg][] = [
    ["jpeg", "ES256"],
    ["jpeg", "ES384"],
    ["png", "PS256"],
    ["webp", "EdDSA"],
  ];
  for (const [container, alg] of cases) {
    it(`${container} / ${alg} : signature, chaîne et liaison valides, émetteur non reconnu`, async () => {
      const fx = await buildC2paFixture({ container, alg });
      const r = await verifyC2pa(fx.bytes, { anchors: [] });
      expect(r.problems).toEqual([]);
      expect(r.status).toBe("valid_untrusted");
      expect(r.signatureValid).toBe(true);
      expect(r.chainValid).toBe(true);
      expect(r.bindingValid).toBe(true);
      expect(r.assertionsValid).toBe(true);
      expect(r.declaresAi).toBe(true);
      expect(r.issuer).toBe("Elium Test Signer");
      expect(r.container).toBe(container);
    });
  }

  it("devient « de confiance » quand la racine est dans la liste", async () => {
    const fx = await buildC2paFixture();
    const r = await verifyC2pa(fx.bytes, {
      anchors: [{ fingerprint: fingerprintOf(fx.rootDer), name: "Racine de test" }],
    });
    expect(r.status).toBe("valid_trusted");
    expect(r.trustedAnchor).toBe("Racine de test");
  });

  it("recompose un manifeste JPEG fragmenté sur plusieurs segments APP11", async () => {
    const fx = await buildC2paFixture({ fragmentJpeg: true });
    expect(extractManifestStore(fx.bytes)).toBeDefined();
    expect((await verifyC2pa(fx.bytes, { anchors: [] })).status).toBe("valid_untrusted");
  });

  it("ne déclare pas d'IA pour une source de capture caméra", async () => {
    const fx = await buildC2paFixture({ digitalSourceType: "http://cv.iptc.org/newscodes/digitalsourcetype/digitalCapture" });
    const r = await verifyC2pa(fx.bytes, { anchors: [] });
    expect(r.status).toBe("valid_untrusted");
    expect(r.declaresAi).toBe(false);
  });

  it("n'est que « non vérifié » si la racine manque et que la chaîne est incomplète mais cohérente", async () => {
    const fx = await buildC2paFixture({ includeRoot: false });
    const r = await verifyC2pa(fx.bytes, { anchors: [] });
    expect(r.status).toBe("valid_untrusted"); // chaîne d'un seul certificat : rien à contredire
  });
});

describe("C2PA : manifestes altérés", () => {
  it("détecte une image modifiée après signature (liaison forte)", async () => {
    const fx = await buildC2paFixture();
    const bytes = fx.bytes.slice();
    bytes[bytes.length - 20] ^= 0xff; // dans les données image
    const r = await verifyC2pa(bytes, { anchors: [] });
    expect(r.status).toBe("invalid");
    expect(r.bindingValid).toBe(false);
    expect(r.signatureValid).toBe(true);
  });

  it("détecte un claim modifié (signature invalide)", async () => {
    const fx = await buildC2paFixture({ claimGenerator: "Elium-Test/1.0" });
    const bytes = fx.bytes.slice();
    const at = new TextDecoder("latin1").decode(bytes).indexOf("Elium-Test/1.0");
    expect(at).toBeGreaterThan(0);
    bytes[at] = "X".charCodeAt(0);
    const r = await verifyC2pa(bytes, { anchors: [] });
    expect(r.status).toBe("invalid");
    expect(r.signatureValid).toBe(false);
  });

  it("détecte une assertion modifiée (digitalSourceType réécrit)", async () => {
    const fx = await buildC2paFixture();
    const bytes = fx.bytes.slice();
    const at = new TextDecoder("latin1").decode(bytes).indexOf("trainedAlgorithmicMedia");
    expect(at).toBeGreaterThan(0);
    bytes.set(new TextEncoder().encode("digitalCapture_________"), at); // même longueur (23)
    const r = await verifyC2pa(bytes, { anchors: [] });
    expect(r.status).toBe("invalid");
    expect(r.assertionsValid).toBe(false);
  });

  it("renvoie « absent » sans manifeste et « non vérifié » sur un JUMBF illisible", async () => {
    expect((await verifyC2pa(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))).status).toBe("absent");
    const fx = await buildC2paFixture();
    const bytes = fx.bytes.slice();
    const at = new TextDecoder("latin1").decode(bytes).indexOf("jumb");
    bytes[at - 1] = 0xff; // longueur de superboîte absurde
    const r = await verifyC2pa(bytes, { anchors: [] });
    expect(["unverified", "invalid"]).toContain(r.status);
    expect(r.problems.length).toBeGreaterThan(0);
  });
});

describe("C2PA : pondération dans l'analyse d'image", () => {
  it("le poids dépend du statut vérifié / non reconnu / invalide", async () => {
    const { analyzeImageSignals } = await import("../src/detector/imageSignals");
    const fx = await buildC2paFixture();
    const trusted = await verifyC2pa(fx.bytes, { anchors: [{ fingerprint: fingerprintOf(fx.rootDer), name: "R" }] });
    const untrusted = await verifyC2pa(fx.bytes, { anchors: [] });
    const tampered = fx.bytes.slice();
    tampered[tampered.length - 20] ^= 0xff;
    const invalid = await verifyC2pa(tampered, { anchors: [] });
    const run = (bytes: Uint8Array, r: typeof trusted) =>
      analyzeImageSignals([{ index: 0, bytes, mime: "image/jpeg" }], undefined, new Map([[0, r]]));
    const ai = (f: ReturnType<typeof run>) => f.find((x) => x.signal === "image_c2pa_ai_source");
    expect(ai(run(fx.bytes, trusted))?.severity).toBe("eleve");
    expect(ai(run(fx.bytes, untrusted))?.severity).toBe("moyen");
    expect(ai(run(fx.bytes, trusted))!.weight).toBeGreaterThan(ai(run(fx.bytes, untrusted))!.weight);
    const inv = run(tampered, invalid);
    expect(ai(inv)).toBeUndefined();
    expect(inv.find((x) => x.signal === "image_c2pa_invalid")?.severity).toBe("faible");
  });
});

describe("liste de confiance", () => {
  it("lit un PEM et un DER", async () => {
    const fx = await buildC2paFixture();
    const b64 = btoa(String.fromCharCode(...fx.rootDer)).replace(/(.{64})/g, "$1\n");
    const pem = new TextEncoder().encode(`-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`);
    expect(parseCertificateFile(pem)).toHaveLength(1);
    expect(anchorsFromFile(pem)[0]!.fingerprint).toBe(fingerprintOf(fx.rootDer));
    expect(anchorsFromFile(fx.rootDer)[0]!.name).toBe("Elium Test Root");
    expect(() => parseCertificateFile(new Uint8Array([1, 2, 3]))).toThrow();
  });
});
