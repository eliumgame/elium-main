/**
 * GET HTTPS « anti-SSRF » : le nom d'hôte est résolu UNE seule fois, toutes les
 * adresses sont vérifiées (aucune ne doit être privée / loopback / link-local /
 * IPv4-mappée vers du privé…), puis la connexion est ÉPINGLÉE sur l'adresse validée
 * (pas de seconde résolution exploitable par un DNS rebinding). Aucune redirection
 * n'est suivie (le 3xx est renvoyé tel quel) et la réponse est bornée.
 * Même politique d'adresses que le relais d'horodatage (routes/tsa.ts).
 */
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { isNonPublicAddress } from "../routes/tsa.js";

const MAX_BODY = 1024 * 1024;

export interface SafeFetchOptions {
  signal?: AbortSignal;
  headers?: Record<string, string>;
  /** Résolveur injectable (tests). */
  resolve?: (host: string) => Promise<{ address: string; family: number }[]>;
}

/** Signature compatible `fetch` (GET uniquement, https uniquement, `redirect: "manual"` implicite). */
export async function safeHttpsGet(uri: string, init: SafeFetchOptions = {}): Promise<Response> {
  const u = new URL(uri);
  if (u.protocol !== "https:" || u.username || u.password) throw new Error("URL non autorisée.");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const literal = isIP(host);
  const addresses = literal
    ? [{ address: host, family: literal }]
    : await (init.resolve ?? ((h: string) => lookup(h, { all: true })))(host);
  if (!addresses.length || addresses.some((a) => isNonPublicAddress(a.address))) {
    throw new Error("Adresse réseau non autorisée.");
  }
  const target = addresses[0]!;
  const pinned: LookupFunction = (_h, opts, cb) => {
    if (opts.all) {
      (cb as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [
        { address: target.address, family: target.family },
      ]);
    } else cb(null, target.address, target.family);
  };
  return new Promise<Response>((resolve, reject) => {
    const req = httpsRequest(
      {
        method: "GET",
        host,
        port: u.port || 443,
        path: `${u.pathname}${u.search}`,
        headers: { ...(init.headers ?? {}), "user-agent": "Elium" },
        lookup: pinned,
        agent: false,
        ...(literal ? {} : { servername: host }),
        signal: init.signal,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > MAX_BODY) {
            req.destroy();
            reject(new Error("Réponse trop volumineuse."));
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => {
          const headers = new Headers();
          for (const [k, v] of Object.entries(res.headers)) {
            if (typeof v === "string") headers.set(k, v);
            else if (Array.isArray(v)) headers.set(k, v.join(", "));
          }
          const status = res.statusCode ?? 0;
          // Un Response avec statut 204/3xx n'accepte pas toujours un corps : on le retire alors.
          const body = status === 204 || status === 205 || status === 304 ? null : Buffer.concat(chunks);
          resolve(new Response(body, { status, headers }));
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end();
  });
}
