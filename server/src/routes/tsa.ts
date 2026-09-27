/**
 * RFC 3161 timestamp relay for PDF signatures (POST /api/tsa).
 *
 * Timestamp authorities rarely allow cross-origin calls, so a browser cannot
 * ask them directly: the Drive relays the request to the server the user
 * chose (header X-Elium-TSA-Url). A timestamp request only carries a hash, so
 * nothing about the document leaves; the route is public but tightly bounded —
 * rate limit, http(s) targets on public addresses only, small bodies, short
 * timeout — so it cannot be used to reach internal services or as a proxy.
 *
 * The target name is resolved exactly once: the connection is made to the
 * address that was checked (no second resolution a DNS rebinding could
 * exploit), redirects are never followed, and the reply is bounded while it is
 * read.
 */
import type { FastifyInstance } from "fastify";
import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { badRequest } from "../lib/errors.js";

const MAX_REQUEST = 8 * 1024;
const MAX_REPLY = 64 * 1024;
const TIMEOUT_MS = 15_000;

// IANA special-purpose registries: everything that is not globally reachable
// (or is documentation / benchmarking / protocol plumbing).
const NON_GLOBAL_V4: [string, number][] = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // shared address space (CGNAT)
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.31.196.0", 24], // AS112
  ["192.52.193.0", 24], // AMT
  ["192.88.99.0", 24], // 6to4 relay anycast (deprecated)
  ["192.168.0.0", 16], // private
  ["192.175.48.0", 24], // AS112 direct delegation
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved + limited broadcast
];
// Within 2000::/3 (the only global unicast block); anything outside it is refused.
const NON_GLOBAL_V6: [string, number][] = [
  ["2001::", 23], // IETF protocol assignments (Teredo, ORCHID, benchmarking…)
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4 (checked through its embedded IPv4 instead, see below)
  ["3fff::", 20], // documentation
];

const nonGlobal = new BlockList();
for (const [net, prefix] of NON_GLOBAL_V4) nonGlobal.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of NON_GLOBAL_V6) nonGlobal.addSubnet(net, prefix, "ipv6");
const globalUnicastV6 = new BlockList();
globalUnicastV6.addSubnet("2000::", 3, "ipv6");

/** The eight 16-bit groups of an IPv6 address, or null if it is not one. */
function parseIPv6(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  let tail: number[] = [];
  const dotted = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (dotted) {
    if (isIP(dotted[2]!) !== 4) return null;
    const [a, b, c, d] = dotted[2]!.split(".").map(Number) as [number, number, number, number];
    tail = [(a << 8) | b, (c << 8) | d];
    s = dotted[1]!.endsWith("::") ? dotted[1]! : dotted[1]!.slice(0, -1);
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const groups = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    for (const g of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = groups(halves[0]!);
  const rest = halves.length === 2 ? groups(halves[1]!) : [];
  if (!head || !rest) return null;
  const known = head.length + rest.length + tail.length;
  if (halves.length === 2) {
    if (known > 7) return null;
    return [...head, ...new Array<number>(8 - known).fill(0), ...rest, ...tail];
  }
  return known === 8 ? [...head, ...tail] : null;
}

const v4From = (hi: number, lo: number): string => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;

/** True for addresses a relay must never reach (loopback, private, link-local…). */
export function isNonPublicAddress(ip: string): boolean {
  if (isIP(ip) === 4) return nonGlobal.check(ip, "ipv4");
  const g = parseIPv6(ip);
  if (!g) return true; // not an address we understand: refuse
  const zeros = (from: number, to: number): boolean => g.slice(from, to).every((x) => x === 0);
  // IPv4-mapped ::ffff:0:0/96 — judged on the embedded IPv4.
  if (zeros(0, 5) && g[5] === 0xffff) return isNonPublicAddress(v4From(g[6]!, g[7]!));
  // NAT64 well-known prefix 64:ff9b::/96 — the gateway reaches the embedded IPv4.
  if (g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6)) return isNonPublicAddress(v4From(g[6]!, g[7]!));
  // 6to4 2002:V4ADDR::/48 — relays route to the embedded IPv4.
  if (g[0] === 0x2002) return isNonPublicAddress(v4From(g[1]!, g[2]!));
  // Everything else outside 2000::/3 (::, ::1, IPv4-compatible ::/96, fc00::/7,
  // fe80::/10, fec0::/10, ff00::/8, 64:ff9b:1::/48, 100::/64…) is not global.
  const full = g.map((x) => x.toString(16)).join(":");
  if (!globalUnicastV6.check(full, "ipv6")) return true;
  return nonGlobal.check(full, "ipv6");
}

export interface TsaTarget {
  url: URL;
  /** Host name or IP literal, without IPv6 brackets. */
  host: string;
  /** The single, already checked address the relay connects to. */
  address: string;
  family: 4 | 6;
}

/** Resolves `url` once and checks every address; the problem, or the target to connect to. */
export async function resolveTsaTarget(url: string): Promise<{ problem: string } | { target: TsaTarget }> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { problem: "Adresse du serveur d'horodatage invalide." };
  }
  if (u.protocol !== "https:" && u.protocol !== "http:")
    return { problem: "Adresse du serveur d'horodatage invalide." };
  if (u.username || u.password) return { problem: "Adresse du serveur d'horodatage invalide." };
  const host = u.hostname.replace(/^\[|\]$/g, "");
  let addresses: { address: string; family: number }[];
  try {
    const literal = isIP(host);
    addresses = literal ? [{ address: host, family: literal }] : await lookup(host, { all: true });
  } catch {
    return { problem: "Serveur d'horodatage introuvable." };
  }
  if (!addresses.length || addresses.some((a) => isNonPublicAddress(a.address)))
    return { problem: "Adresse réseau non autorisée pour l'horodatage." };
  const first = addresses[0]!;
  return { target: { url: u, host, address: first.address, family: first.family === 6 ? 6 : 4 } };
}

/** Why `url` may not be relayed to, or null. */
export async function tsaTargetProblem(url: string): Promise<string | null> {
  const r = await resolveTsaTarget(url);
  return "problem" in r ? r.problem : null;
}

/** The TSA answered, but not with an acceptable reply (status, redirect, size). */
export class TsaRefused extends Error {}

export interface RelayOptions {
  timeoutMs?: number;
  /** Address policy; only tests loosen it (to talk to a stand-in TSA on loopback). */
  allowAddress?: (address: string) => boolean;
}

/**
 * POSTs `body` to the checked address of `target` (Host header and TLS name =
 * the original host name). Never follows redirects; aborts past MAX_REPLY bytes
 * or `timeoutMs` for the whole exchange, body included.
 */
export function relayTimestamp(target: TsaTarget, body: Buffer, options: RelayOptions = {}): Promise<Buffer> {
  const { timeoutMs = TIMEOUT_MS, allowAddress = (a: string) => !isNonPublicAddress(a) } = options;
  if (!allowAddress(target.address)) return Promise.reject(new Error("non-public address"));
  // Only ever hand the socket the pre-validated address, whatever name it asks for.
  const pinned: LookupFunction = (_hostname, lookupOptions, callback) => {
    if (!allowAddress(target.address)) {
      callback(new Error("non-public address"), "", 0);
      return;
    }
    if (lookupOptions.all) {
      (callback as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [
        { address: target.address, family: target.family },
      ]);
    } else callback(null, target.address, target.family);
  };
  const https = target.url.protocol === "https:";
  return new Promise<Buffer>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(new Error("timeout")), timeoutMs);
    const finish = (err: Error | null, data?: Buffer): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        req.destroy();
        reject(err);
      } else resolve(data!);
    };
    const req = (https ? httpsRequest : httpRequest)(
      {
        method: "POST",
        host: target.host,
        port: target.url.port || (https ? 443 : 80),
        path: `${target.url.pathname}${target.url.search}`,
        headers: {
          "content-type": "application/timestamp-query",
          "content-length": body.length,
          "user-agent": "Elium",
        },
        lookup: pinned,
        agent: false,
        ...(https && !isIP(target.host) ? { servername: target.host } : {}),
      },
      (res: IncomingMessage) => {
        const status = res.statusCode ?? 0;
        if (status < 200 || status >= 300) return finish(new TsaRefused(`HTTP ${status}`));
        if (Number(res.headers["content-length"] ?? 0) > MAX_REPLY) return finish(new TsaRefused("reply too large"));
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_REPLY) return finish(new TsaRefused("reply too large"));
          chunks.push(chunk);
        });
        res.on("end", () => finish(null, Buffer.concat(chunks)));
        res.on("close", () => finish(new Error("reply interrupted"))); // no-op once "end" settled it
        res.on("error", (e) => finish(e));
      },
    );
    req.on("error", (e) => finish(e));
    req.end(body);
  });
}

export default async function tsaRoutes(app: FastifyInstance): Promise<void> {
  app.addContentTypeParser(
    "application/timestamp-query",
    { parseAs: "buffer", bodyLimit: MAX_REQUEST },
    (_req, body, done) => done(null, body),
  );

  app.post("/tsa", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req, reply) => {
    const target = String(req.headers["x-elium-tsa-url"] ?? "").trim();
    const body = req.body;
    // A TimeStampReq is a DER SEQUENCE.
    if (!Buffer.isBuffer(body) || !body.length || body[0] !== 0x30) throw badRequest("Demande d'horodatage invalide.");
    const resolved = await resolveTsaTarget(target);
    if ("problem" in resolved) throw badRequest(resolved.problem);
    let data: Buffer;
    try {
      data = await relayTimestamp(resolved.target, body);
    } catch (e) {
      return e instanceof TsaRefused
        ? reply
            .status(502)
            .send({ error: { code: "tsa_failed", message: "Le serveur d'horodatage a refusé la demande." } })
        : reply.status(502).send({ error: { code: "tsa_unreachable", message: "Serveur d'horodatage injoignable." } });
    }
    return reply.type("application/timestamp-reply").send(data);
  });
}
