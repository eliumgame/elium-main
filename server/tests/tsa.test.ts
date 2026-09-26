import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import tsaRoutes, { isNonPublicAddress, tsaTargetProblem } from "../src/routes/tsa.js";
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
});
