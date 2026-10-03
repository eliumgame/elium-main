/**
 * Partage de secret de Shamir k-parmi-n sur GF(2^8) (polynôme AES 0x11b),
 * octet par octet. Aucune dépendance : l'arithmétique tient en vingt lignes et
 * se vérifie exhaustivement (tous les sous-ensembles sont testés).
 *
 * Utilisé pour répartir le SECRET MAÎTRE du trousseau entre plusieurs
 * personnes/supports : k parts quelconques le reconstituent, k-1 n'en
 * apprennent RIEN (sécurité inconditionnelle). Chaque part s'exporte en fichier
 * `.eliumshare` (JSON) portant l'identifiant du lot, k, n et un témoin
 * d'intégrité (début de SHA-256 du secret — 8 octets, insuffisant pour retrouver
 * le secret mais permettant de détecter une part erronée).
 */
import { fromHex, toHex, sha256Hex } from "../format/canonical";

export const SHARE_FORMAT = "elium-share";
export const SHARE_VERSION = 1;
export const MAX_SHARES = 16;

export class ShamirError extends Error {}

// --- GF(256) ------------------------------------------------------------------

/** Multiplication dans GF(2^8) modulo x^8+x^4+x^3+x+1. */
export function gfMul(a: number, b: number): number {
  let p = 0;
  for (let i = 0; i < 8; i++) {
    if (b & 1) p ^= a;
    const hi = a & 0x80;
    a = (a << 1) & 0xff;
    if (hi) a ^= 0x1b;
    b >>= 1;
  }
  return p;
}

export function gfInv(a: number): number {
  if (a === 0) throw new ShamirError("Inverse de zéro.");
  // a^254 par carrés-multiplications.
  let result = 1;
  let base = a;
  let e = 254;
  while (e > 0) {
    if (e & 1) result = gfMul(result, base);
    base = gfMul(base, base);
    e >>= 1;
  }
  return result;
}

// --- Partage -------------------------------------------------------------------

export interface Share {
  format: typeof SHARE_FORMAT;
  version: typeof SHARE_VERSION;
  /** Identifiant du lot (toutes les parts d'un même partage le partagent). */
  setId: string;
  k: number;
  n: number;
  /** Abscisse de la part (1..n). */
  x: number;
  /** Ordonnées (une par octet du secret), hex. */
  y: string;
  /** 8 premiers octets de SHA-256(secret), hex. */
  check: string;
  createdAt: string;
}

export type RandomBytes = (n: number) => Uint8Array;
const defaultRandom: RandomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));

async function checkOf(secret: Uint8Array): Promise<string> {
  return (await sha256Hex(secret)).slice(0, 16);
}

export async function splitSecret(
  secret: Uint8Array,
  k: number,
  n: number,
  random: RandomBytes = defaultRandom,
  now: Date = new Date(),
): Promise<Share[]> {
  if (!Number.isInteger(k) || !Number.isInteger(n) || k < 2 || n < k || n > MAX_SHARES) {
    throw new ShamirError(`Paramètres invalides : 2 ≤ k ≤ n ≤ ${MAX_SHARES} attendu.`);
  }
  if (secret.length === 0) throw new ShamirError("Secret vide.");
  const ys: Uint8Array[] = Array.from({ length: n }, () => new Uint8Array(secret.length));
  for (let i = 0; i < secret.length; i++) {
    // Polynôme de degré k-1 dont le terme constant est l'octet du secret.
    const coeffs = new Uint8Array(k);
    coeffs[0] = secret[i];
    coeffs.set(random(k - 1), 1);
    for (let s = 0; s < n; s++) {
      const x = s + 1;
      let y = 0;
      for (let c = k - 1; c >= 0; c--) y = gfMul(y, x) ^ coeffs[c]; // Horner
      ys[s][i] = y;
    }
  }
  const setId = toHex(random(8));
  const check = await checkOf(secret);
  return ys.map((y, s) => ({
    format: SHARE_FORMAT,
    version: SHARE_VERSION,
    setId,
    k,
    n,
    x: s + 1,
    y: toHex(y),
    check,
    createdAt: now.toISOString(),
  }));
}

function interpolateAtZero(points: { x: number; y: Uint8Array }[], length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < points.length; i++) {
    // Coefficient de Lagrange en 0 : Π_{j≠i} x_j / (x_i ^ x_j)
    let num = 1;
    let den = 1;
    for (let j = 0; j < points.length; j++) {
      if (i === j) continue;
      num = gfMul(num, points[j].x);
      den = gfMul(den, points[i].x ^ points[j].x);
    }
    const lag = gfMul(num, gfInv(den));
    for (let b = 0; b < length; b++) out[b] ^= gfMul(points[i].y[b], lag);
  }
  return out;
}

function* combinations<T>(items: T[], k: number, start = 0, acc: T[] = []): Generator<T[]> {
  if (acc.length === k) {
    yield [...acc];
    return;
  }
  for (let i = start; i < items.length; i++) {
    acc.push(items[i]);
    yield* combinations(items, k, i + 1, acc);
    acc.pop();
  }
}

/**
 * Reconstitue le secret. Exige un lot homogène (même setId/k/n/témoin), au moins
 * k parts d'abscisses distinctes. Si une part est corrompue mais que plus de k
 * parts sont fournies, cherche un sous-ensemble cohérent avec le témoin.
 */
export async function combineShares(shares: Share[]): Promise<Uint8Array> {
  if (shares.length === 0) throw new ShamirError("Aucune part fournie.");
  const ref = shares[0];
  for (const s of shares) {
    if (s.format !== SHARE_FORMAT || s.version !== SHARE_VERSION) throw new ShamirError("Format de part non pris en charge.");
    if (s.setId !== ref.setId || s.k !== ref.k || s.n !== ref.n || s.check !== ref.check) {
      throw new ShamirError("Ces parts ne proviennent pas du même partage.");
    }
  }
  const unique = new Map<number, Share>();
  for (const s of shares) unique.set(s.x, s);
  if (unique.size < ref.k) {
    throw new ShamirError(`Il faut au moins ${ref.k} parts distinctes (${unique.size} fournie(s)).`);
  }
  const pts = [...unique.values()].map((s) => ({ x: s.x, y: fromHex(s.y) }));
  const length = pts[0].y.length;
  if (pts.some((p) => p.y.length !== length)) throw new ShamirError("Parts de longueurs différentes.");

  for (const subset of combinations(pts, ref.k)) {
    const secret = interpolateAtZero(subset, length);
    if ((await checkOf(secret)) === ref.check) return secret;
  }
  throw new ShamirError("Les parts fournies ne reconstituent pas un secret valide (part altérée ou erronée).");
}

// --- Fichier .eliumshare ---------------------------------------------------------

export function shareFileName(share: Pick<Share, "x" | "n">): string {
  return `elium-part-${share.x}-sur-${share.n}.eliumshare`;
}

export function parseShare(text: string): Share {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new ShamirError("Ce fichier n'est pas une part Elium valide (JSON illisible).");
  }
  if (!o || o.format !== SHARE_FORMAT) throw new ShamirError("Ce fichier n'est pas une part Elium (.eliumshare).");
  if (o.version !== SHARE_VERSION) throw new ShamirError(`Version de part non prise en charge (${String(o.version)}).`);
  const int = (v: unknown, lo: number, hi: number) => typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;
  const hex = (v: unknown, even = true) => typeof v === "string" && /^[0-9a-f]*$/.test(v) && (!even || v.length % 2 === 0);
  if (
    !int(o.k, 2, MAX_SHARES) ||
    !int(o.n, 2, MAX_SHARES) ||
    (o.k as number) > (o.n as number) ||
    !int(o.x, 1, o.n as number) ||
    !hex(o.y) ||
    (o.y as string).length === 0 ||
    typeof o.setId !== "string" ||
    !/^[0-9a-f]{16}$/.test(o.setId) ||
    typeof o.check !== "string" ||
    !/^[0-9a-f]{16}$/.test(o.check)
  ) {
    throw new ShamirError("Part corrompue ou incomplète.");
  }
  return {
    format: SHARE_FORMAT,
    version: SHARE_VERSION,
    setId: o.setId,
    k: o.k as number,
    n: o.n as number,
    x: o.x as number,
    y: o.y as string,
    check: o.check,
    createdAt: typeof o.createdAt === "string" ? o.createdAt : "",
  };
}
