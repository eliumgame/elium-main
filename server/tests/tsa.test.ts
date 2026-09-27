import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

const lookupMock = vi.hoisted(() => vi.fn());
vi.mock("node:dns/promises", async (orig) => {
  const real = await orig<typeof import("node:dns/promises")>();
  return {
    ...real,
    lookup: (...args: Parameters<typeof real.lookup>) =>
      lookupMock.getMockImplementation() ? lookupMock(...args) : real.lookup(...args),
  };
});

import tsaRoutes, {
  isNonPublicAddress,
  relayTimestamp,
  resolveTsaTarget,
  TsaRefused,
  tsaTargetProblem,
  type TsaTarget,
} from "../src/routes/tsa.js";
import { ApiError } from "../src/lib/errors.js";

describe("timestamp relay", () => {
  it("never reaches loopback, private or link-local addresses", () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "172.20.0.1",
      "192.168.0.9",
      "169.254.169.254",
      "100.64.0.1",
      "::1",
      "fd00::1",
      "fe80::1",
      "::ffff:127.0.0.1",
    ])
      expect(isNonPublicAddress(ip), ip).toBe(true);
    for (const ip of ["93.184.216.34", "2606:4700::1111"]) expect(isNonPublicAddress(ip), ip).toBe(false);
  });

  it("sees through IPv4 embedded in IPv6 and knows every special-purpose range", () => {
    for (const ip of [
      "::ffff:7f00:1", // what WHATWG URL makes of [::ffff:127.0.0.1]
      "::ffff:a00:1",
      "::ffff:a9fe:a9fe",
      "::ffff:169.254.169.254",
      "0:0:0:0:0:ffff:7f00:1",
      "::7f00:1", // IPv4-compatible
      "::127.0.0.1",
      "::5db8:d822", // IPv4-compatible, even with a public v4: deprecated, not global
      "64:ff9b::7f00:1", // NAT64
      "64:ff9b::10.0.0.1",
      "64:ff9b:1::5db8:d822", // local-use NAT64
      "2002:7f00:1::1", // 6to4
      "2002:c0a8:0101::",
      "2001:0:4136:e378::1", // Teredo
      "2001:db8::1",
      "3fff::1",
      "fec0::1",
      "fe80::1%eth0",
      "ff02::1",
      "100::1",
      "::",
      "::0:1",
      "198.18.0.1",
      "198.19.255.255",
      "192.0.0.1",
      "192.0.2.1",
      "198.51.100.7",
      "203.0.113.9",
      "192.88.99.1",
      "0.0.0.0",
      "240.0.0.1",
      "255.255.255.255",
      "not-an-ip",
      "1:2:3:4:5:6:7:8:9",
    ])
      expect(isNonPublicAddress(ip), ip).toBe(true);
    for (const ip of ["::ffff:93.184.216.34", "::ffff:5db8:d822", "64:ff9b::5db8:d822", "2002:5db8:d822::1", "8.8.8.8"])
      expect(isNonPublicAddress(ip), ip).toBe(false);
  });

  it("refuses bracketed IPv4-mapped literals in the URL", async () => {
    for (const url of [
      "http://[::ffff:127.0.0.1]:8080/",
      "http://[::ffff:169.254.169.254]/latest/meta-data/",
      "http://[64:ff9b::127.0.0.1]/",
      "http://[fec0::1]/",
      "http://2130706433/",
    ])
      expect(await tsaTargetProblem(url), url).not.toBeNull();
  });

  it("refuses other schemes, credentials and internal hosts", async () => {
    for (const url of [
      "file:///etc/passwd",
      "ftp://tsa.example/",
      "http://user:pw@93.184.216.34/",
      "http://127.0.0.1:8080/",
      "http://[::1]/",
      "pas une url",
    ])
      expect(await tsaTargetProblem(url), url).not.toBeNull();
    expect(await tsaTargetProblem("http://93.184.216.34/tsr")).toBeNull();
  });

  it("rejects a body that is not a DER request, and an internal target, before any network call", async () => {
    const app = Fastify();
    app.setErrorHandler((err, _req, reply) =>
      reply
        .status(err instanceof ApiError ? err.statusCode : ((err as { statusCode?: number }).statusCode ?? 500))
        .send({ message: err.message }),
    );
    await app.register(tsaRoutes, { prefix: "/api" });
    const headers = { "content-type": "application/timestamp-query", "x-elium-tsa-url": "http://127.0.0.1:1/" };
    let res = await app.inject({ method: "POST", url: "/api/tsa", headers, payload: Buffer.from("hello") });
    expect(res.statusCode).toBe(400);
    res = await app.inject({
      method: "POST",
      url: "/api/tsa",
      headers,
      payload: Buffer.from([0x30, 0x03, 0x02, 0x01, 0x01]),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/non autorisée/);
    res = await app.inject({ method: "POST", url: "/api/tsa", headers, payload: Buffer.alloc(9000, 0x30) });
    expect(res.statusCode).toBe(413);
    await app.close();
  });

  it("refuses a loopback service reached through [::ffff:127.0.0.1]", async () => {
    let hits = 0;
    const internal = createServer((_q, s) => {
      hits++;
      s.end("INTERNAL");
    });
    await new Promise<void>((r) => internal.listen(0, "127.0.0.1", r));
    const port = (internal.address() as AddressInfo).port;
    const app = await appWithRoute();
    const res = await app.inject({
      method: "POST",
      url: "/api/tsa",
      payload: DER,
      headers: {
        "content-type": "application/timestamp-query",
        "x-elium-tsa-url": `http://[::ffff:127.0.0.1]:${port}/`,
      },
    });
    await app.close();
    internal.close();
    expect(res.statusCode).toBe(400);
    expect(hits).toBe(0);
  });
});

const DER = Buffer.from([0x30, 0x03, 0x02, 0x01, 0x01]);

async function appWithRoute() {
  const app = Fastify();
  app.setErrorHandler((err, _req, reply) =>
    reply
      .status(err instanceof ApiError ? err.statusCode : ((err as { statusCode?: number }).statusCode ?? 500))
      .send({ message: err.message }),
  );
  await app.register(tsaRoutes, { prefix: "/api" });
  return app;
}

describe("timestamp relay connection", () => {
  let server: Server | undefined;
  afterEach(async () => {
    lookupMock.mockReset();
    server?.closeAllConnections();
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    server = undefined;
  });

  /** A local stand-in TSA; the relay is handed its address as if it had been checked. */
  async function tsa(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<number> {
    server = createServer(handler);
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    return (server.address() as AddressInfo).port;
  }
  const LOOPBACK_OK = { allowAddress: (a: string) => a === "127.0.0.1" };
  const pinnedTo = (url: string): TsaTarget => {
    const u = new URL(url);
    return { url: u, host: u.hostname, address: "127.0.0.1", family: 4 };
  };

  it("resolves the name once, and connects to that address without resolving it again", async () => {
    lookupMock.mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }]);
    lookupMock.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]); // the rebind
    const resolved = await resolveTsaTarget("http://rebind.attacker.example/tsr");
    expect(resolved).toMatchObject({ target: { host: "rebind.attacker.example", address: "93.184.216.34" } });
    expect(lookupMock).toHaveBeenCalledTimes(1);

    let host: string | undefined;
    let path: string | undefined;
    const port = await tsa((req, res) => {
      host = req.headers.host;
      path = req.url;
      res.end(Buffer.from([0x30, 0x00]));
    });
    const data = await relayTimestamp(pinnedTo(`http://rebind.attacker.example:${port}/tsr?a=1`), DER, LOOPBACK_OK);
    expect(data).toEqual(Buffer.from([0x30, 0x00]));
    expect(host).toBe(`rebind.attacker.example:${port}`);
    expect(path).toBe("/tsr?a=1");
    expect(lookupMock).toHaveBeenCalledTimes(1); // the connection did not re-resolve the name
  });

  it("refuses to connect when the pinned address is not public", async () => {
    let hits = 0;
    const port = await tsa((_q, res) => {
      hits++;
      res.end("INTERNAL");
    });
    await expect(relayTimestamp(pinnedTo(`http://tsa.example:${port}/`), DER)).rejects.toThrow(/non-public/);
    const literal = new URL(`http://127.0.0.1:${port}/`);
    await expect(
      relayTimestamp({ url: literal, host: "127.0.0.1", address: "127.0.0.1", family: 4 }, DER),
    ).rejects.toThrow(/non-public/);
    expect(hits).toBe(0);
  });

  it("does not follow redirects", async () => {
    const port = await tsa((_q, res) => {
      res.writeHead(302, { location: "http://127.0.0.1:1/admin" }).end();
    });
    await expect(relayTimestamp(pinnedTo(`http://tsa.example:${port}/`), DER, LOOPBACK_OK)).rejects.toBeInstanceOf(
      TsaRefused,
    );
  });

  it("stops reading a reply past 64 KiB", async () => {
    let sent = 0;
    let closed = false;
    const port = await tsa((_q, res) => {
      res.on("close", () => (closed = true));
      const chunk = Buffer.alloc(16 * 1024, 0x30);
      const push = (): void => {
        while (!closed && sent < 50 * 1024 * 1024) {
          sent += chunk.length;
          if (!res.write(chunk)) return void res.once("drain", push);
        }
        res.end();
      };
      push();
    });
    await expect(relayTimestamp(pinnedTo(`http://tsa.example:${port}/`), DER, LOOPBACK_OK)).rejects.toBeInstanceOf(
      TsaRefused,
    );
    await vi.waitFor(() => expect(closed).toBe(true));
    expect(sent).toBeLessThan(8 * 1024 * 1024);
  });

  it("refuses a reply announcing more than 64 KiB", async () => {
    const port = await tsa((_q, res) => {
      res.writeHead(200, { "content-length": String(1024 * 1024) });
      res.write("0");
    });
    await expect(relayTimestamp(pinnedTo(`http://tsa.example:${port}/`), DER, LOOPBACK_OK)).rejects.toBeInstanceOf(
      TsaRefused,
    );
  });

  it("times out while the reply body is still being read", async () => {
    const port = await tsa((_q, res) => {
      res.writeHead(200, { "content-length": "100" });
      res.write("0"); // …and never the rest
    });
    const err = await relayTimestamp(pinnedTo(`http://tsa.example:${port}/`), DER, {
      ...LOOPBACK_OK,
      timeoutMs: 300,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(TsaRefused); // reported as unreachable, still a 502
    expect(String(err)).toMatch(/timeout/);
  });
});
