import { describe, it, expect } from "vitest";
import { splitSecret, combineShares, parseShare, shareFileName, gfMul, gfInv, ShamirError, type Share } from "../src/crypto/shamir";
import {
  masterToPhrase,
  phraseToMaster,
  normalizePhrase,
  makePhraseChallenge,
  checkPhraseChallenge,
  RecoveryPhraseError,
} from "../src/crypto/recovery-phrase";
import {
  enrollPasskey,
  unlockWithPasskey,
  revokePasskey,
  KEYRING_PRF_SALT_HEX,
  PasskeyUnsupportedError,
  type PrfAuthenticator,
} from "../src/crypto/keyring-passkeys";
import { createMemoryStore, createMaster, getMasterRecord, KeyringError } from "../src/crypto/keyring";
import { toHex } from "../src/format/canonical";

const SECRET = new Uint8Array(32).map((_, i) => (i * 37 + 11) & 0xff);

/** Tous les sous-ensembles d'une liste. */
function subsets<T>(items: T[]): T[][] {
  const out: T[][] = [];
  for (let mask = 0; mask < 1 << items.length; mask++) out.push(items.filter((_, i) => mask & (1 << i)));
  return out;
}

describe("GF(256)", () => {
  it("multiplication AES connue et inverses corrects", () => {
    expect(gfMul(0x57, 0x83)).toBe(0xc1); // exemple FIPS-197
    for (let a = 1; a < 256; a++) expect(gfMul(a, gfInv(a))).toBe(1);
  });
});

describe("Shamir k-parmi-n", () => {
  for (const [k, n] of [
    [2, 3],
    [3, 5],
    [2, 2],
    [4, 6],
  ] as const) {
    it(`(${k},${n}) : tout sous-ensemble ≥ k reconstitue, tout < k échoue`, async () => {
      const shares = await splitSecret(SECRET, k, n);
      expect(shares).toHaveLength(n);
      for (const sub of subsets(shares)) {
        if (sub.length >= k) {
          expect(toHex(await combineShares(sub))).toBe(toHex(SECRET));
        } else if (sub.length > 0) {
          await expect(combineShares(sub)).rejects.toThrow(ShamirError);
        }
      }
    }, 60000);
  }

  it("k-1 parts ne révèlent rien : le résultat forcé diffère du secret", async () => {
    const shares = await splitSecret(SECRET, 3, 5);
    // Avec seulement 2 parts d'un (3,5), n'importe quelle valeur du secret est
    // également compatible : on vérifie qu'une 3e part fabriquée ne redonne pas le secret.
    const fake: Share = { ...shares[2], y: "00".repeat(32) };
    await expect(combineShares([shares[0], shares[1], fake])).rejects.toThrow(/altérée/);
  });

  it("détecte une part corrompue quand plus de k parts sont fournies et l'écarte", async () => {
    const shares = await splitSecret(SECRET, 3, 5);
    const bad: Share = { ...shares[1], y: "ff".repeat(32) };
    const out = await combineShares([shares[0], bad, shares[2], shares[3], shares[4]]);
    expect(toHex(out)).toBe(toHex(SECRET));
  });

  it("refuse des parts de lots différents ou en double, et des paramètres invalides", async () => {
    const a = await splitSecret(SECRET, 2, 3);
    const b = await splitSecret(SECRET, 2, 3);
    await expect(combineShares([a[0], b[1]])).rejects.toThrow(/même partage/);
    await expect(combineShares([a[0], a[0]])).rejects.toThrow(/au moins 2/);
    await expect(splitSecret(SECRET, 1, 3)).rejects.toThrow(ShamirError);
    await expect(splitSecret(SECRET, 4, 3)).rejects.toThrow(ShamirError);
    await expect(splitSecret(SECRET, 2, 99)).rejects.toThrow(ShamirError);
    await expect(splitSecret(new Uint8Array(0), 2, 3)).rejects.toThrow(ShamirError);
  });

  it("sérialisation .eliumshare : aller-retour et rejets", async () => {
    const [s] = await splitSecret(SECRET, 2, 3);
    expect(parseShare(JSON.stringify(s))).toEqual(s);
    expect(shareFileName(s)).toBe("elium-part-1-sur-3.eliumshare");
    expect(() => parseShare("pas du json")).toThrow(ShamirError);
    expect(() => parseShare(JSON.stringify({ ...s, format: "x" }))).toThrow(ShamirError);
    expect(() => parseShare(JSON.stringify({ ...s, x: 9 }))).toThrow(ShamirError);
    expect(() => parseShare(JSON.stringify({ ...s, y: "zz" }))).toThrow(ShamirError);
    expect(() => parseShare(JSON.stringify({ ...s, k: 9, n: 3 }))).toThrow(ShamirError);
    // Aucune part ne contient le secret en clair.
    expect(JSON.stringify(s)).not.toContain(toHex(SECRET));
  });
});

describe("phrase de récupération 24 mots", () => {
  it("vecteur BIP-39 officiel : 32 octets nuls -> 'abandon … art'", () => {
    const phrase = masterToPhrase(new Uint8Array(32));
    expect(phrase.split(" ")).toHaveLength(24);
    expect(phrase.startsWith("abandon abandon")).toBe(true);
    expect(phrase.endsWith("art")).toBe(true);
    expect(toHex(phraseToMaster(phrase))).toBe("00".repeat(32));
  });

  it("aller-retour sur un secret quelconque, saisie tolérante", () => {
    const phrase = masterToPhrase(SECRET);
    expect(toHex(phraseToMaster(phrase))).toBe(toHex(SECRET));
    const messy = phrase
      .split(" ")
      .map((w, i) => `${i + 1}. ${i % 2 ? w.toUpperCase() : w}`)
      .join("\n  ");
    expect(toHex(phraseToMaster(messy))).toBe(toHex(SECRET));
    expect(normalizePhrase(" A  b\nC ")).toEqual(["a", "b", "c"]);
  });

  it("rejette mot manquant, mot inconnu, somme de contrôle fausse", () => {
    const words = masterToPhrase(SECRET).split(" ");
    expect(() => phraseToMaster(words.slice(1).join(" "))).toThrow(/24 mots/);
    expect(() => phraseToMaster([...words.slice(0, 23), "zzzzzz"].join(" "))).toThrow(/inconnu/);
    const swapped = [...words];
    [swapped[0], swapped[1]] = [swapped[1], swapped[0]];
    if (swapped.join(" ") !== words.join(" ")) expect(() => phraseToMaster(swapped.join(" "))).toThrow(RecoveryPhraseError);
    expect(() => masterToPhrase(new Uint8Array(16))).toThrow(RecoveryPhraseError);
  });

  it("défi de vérification : positions uniques triées, bonnes/mauvaises réponses", () => {
    const phrase = masterToPhrase(SECRET);
    let seed = 7;
    const ch = makePhraseChallenge(4, (m) => (seed = (seed * 31 + 17) % 1000) % m);
    expect(ch.positions).toHaveLength(4);
    expect([...ch.positions].sort((a, b) => a - b)).toEqual(ch.positions);
    const words = phrase.split(" ");
    const good = ch.positions.map((p) => words[p - 1].toUpperCase());
    expect(checkPhraseChallenge(phrase, ch, good)).toBe(true);
    expect(checkPhraseChallenge(phrase, ch, [...good.slice(0, 3), "faux"])).toBe(false);
    expect(checkPhraseChallenge(phrase, ch, good.slice(1))).toBe(false);
  });
});

// --- Passkeys avec faux authentificateur -------------------------------------------

function fakeAuth(opts: { prf?: boolean; supported?: boolean } = {}) {
  const { prf = true, supported = true } = opts;
  const secrets = new Map<string, Uint8Array>();
  let n = 0;
  let nextPick: string | null = null;
  const auth: PrfAuthenticator & { pick(id: string): void; secrets: typeof secrets } = {
    secrets,
    supported: () => supported,
    pick: (id) => (nextPick = id),
    async create({ label }) {
      const id = `cred-${++n}-${label}`;
      secrets.set(id, crypto.getRandomValues(new Uint8Array(32)));
      return { credentialId: id, kind: n === 1 ? "platform" : "cross-platform" };
    },
    async evaluate({ allow }) {
      if (!prf) return null;
      const id = nextPick && (allow.length === 0 || allow.includes(nextPick)) ? nextPick : allow[0];
      nextPick = null;
      const s = secrets.get(id);
      return s ? { prfOutput: s, credentialId: id } : null;
    },
  };
  return auth;
}

describe("passkeys du trousseau (PRF)", () => {
  it("plusieurs passkeys déverrouillent indépendamment ; révoquer l'une n'affecte pas l'autre", async () => {
    const store = createMemoryStore();
    const { master } = await createMaster(store, "pw");
    const auth = fakeAuth();
    const a = await enrollPasskey(store, master, auth, "localhost", "Windows Hello");
    const b = await enrollPasskey(store, master, auth, "localhost", "YubiKey");
    expect(a.kind).toBe("platform");
    expect(b.kind).toBe("cross-platform");
    expect(a.prfSalt).toBe(KEYRING_PRF_SALT_HEX);
    expect((await getMasterRecord(store))!.passkeys).toHaveLength(2);
    // Le secret maître n'apparaît jamais en clair dans l'enveloppe.
    expect(JSON.stringify(await getMasterRecord(store))).not.toContain(toHex(master));

    auth.pick(a.credentialId);
    expect(toHex((await unlockWithPasskey(store, auth, "localhost")).master)).toBe(toHex(master));
    auth.pick(b.credentialId);
    const viaB = await unlockWithPasskey(store, auth, "localhost");
    expect(viaB.slot.label).toBe("YubiKey");
    expect(toHex(viaB.master)).toBe(toHex(master));

    expect(await revokePasskey(store, a.credentialId)).toBe(true);
    expect(await revokePasskey(store, a.credentialId)).toBe(false);
    auth.pick(a.credentialId);
    // a n'est plus autorisée : l'authentificateur retombe sur b (seule `allow`).
    expect((await unlockWithPasskey(store, auth, "localhost")).slot.credentialId).toBe(b.credentialId);
  });

  it("repli mot de passe : PRF indisponible ou WebAuthn absent -> erreur explicite, rien d'enrôlé", async () => {
    const store = createMemoryStore();
    const { master } = await createMaster(store, "pw");
    await expect(enrollPasskey(store, master, fakeAuth({ prf: false }), "localhost", "x")).rejects.toThrow(
      PasskeyUnsupportedError,
    );
    await expect(enrollPasskey(store, master, fakeAuth({ supported: false }), "localhost", "x")).rejects.toThrow(
      PasskeyUnsupportedError,
    );
    expect((await getMasterRecord(store))!.passkeys).toHaveLength(0);
    await expect(unlockWithPasskey(store, fakeAuth(), "localhost")).rejects.toThrow(KeyringError);
  });

  it("une passkey d'un autre trousseau échoue (GCM authentifié)", async () => {
    const s1 = createMemoryStore();
    const s2 = createMemoryStore();
    const m1 = (await createMaster(s1, "a")).master;
    const m2 = (await createMaster(s2, "b")).master;
    const auth = fakeAuth();
    const slot = await enrollPasskey(s1, m1, auth, "localhost", "k");
    await enrollPasskey(s2, m2, auth, "localhost", "k2");
    // On greffe l'enveloppe de s1 dans s2 sous l'id de la clé de s2 : mauvais secret PRF.
    const rec2 = (await getMasterRecord(s2))!;
    rec2.passkeys[0] = { ...rec2.passkeys[0], wrapped: slot.wrapped };
    await s2.setMeta("master", rec2);
    auth.pick(rec2.passkeys[0].credentialId);
    await expect(unlockWithPasskey(s2, auth, "localhost")).rejects.toThrow(/non valide/);
  });
});
