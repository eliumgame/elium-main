/**
 * RFC 3161 timestamp relay for PDF signatures (POST /api/tsa).
 *
 * Timestamp authorities rarely allow cross-origin calls, so a browser cannot
 * ask them directly: the Drive relays the request to the server the user
 * chose (header X-Elium-TSA-Url). A timestamp request only carries a hash, so
 * nothing about the document leaves; the route is public but tightly bounded —
 * rate limit, http(s) targets on public addresses only, small bodies, short
 * timeout — so it cannot be used to reach internal services or as a proxy.
 */
import type { FastifyInstance } from "fastify";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { badRequest } from "../lib/errors.js";

const MAX_REQUEST = 8 * 1024;
const MAX_REPLY = 64 * 1024;
const TIMEOUT_MS = 15_000;

/** True for addresses a relay must never reach (loopback, private, link-local…). */
export function isNonPublicAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith("::ffff:")) return isNonPublicAddress(v6.slice(7));
  return v6 === "::" || v6 === "::1" || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || v6.startsWith("ff");
}

/** Why `url` may not be relayed to, or null. */
export async function tsaTargetProblem(url: string): Promise<string | null> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "Adresse du serveur d'horodatage invalide.";
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return "Adresse du serveur d'horodatage invalide.";
  if (u.username || u.password) return "Adresse du serveur d'horodatage invalide.";
  const host = u.hostname.replace(/^\[|\]$/g, "");
  let addresses: string[];
  try {
    addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  } catch {
    return "Serveur d'horodatage introuvable.";
  }
  if (!addresses.length || addresses.some(isNonPublicAddress)) return "Adresse réseau non autorisée pour l'horodatage.";
  return null;
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
    const problem = await tsaTargetProblem(target);
    if (problem) throw badRequest(problem);
    let res: Response;
    try {
      res = await fetch(target, {
        method: "POST",
        headers: { "content-type": "application/timestamp-query", "user-agent": "Elium" },
        body: new Uint8Array(body),
        redirect: "error",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      return reply
        .status(502)
        .send({ error: { code: "tsa_unreachable", message: "Serveur d'horodatage injoignable." } });
    }
    const data = Buffer.from(await res.arrayBuffer());
    if (!res.ok || data.length > MAX_REPLY) {
      return reply
        .status(502)
        .send({ error: { code: "tsa_failed", message: "Le serveur d'horodatage a refusé la demande." } });
    }
    return reply.type("application/timestamp-reply").send(data);
  });
}
