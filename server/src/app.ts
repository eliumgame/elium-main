/**
 * Fastify application: security plugins, a raw-buffer parser for encrypted blob
 * bodies, a uniform error handler that never leaks internals, and all route
 * modules. Each route module is `export default async (app) => void` and is
 * mounted under a prefix here.
 */
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import { ZodError } from "zod";
import { config } from "./config.js";
import { ApiError } from "./lib/errors.js";

import authRoutes from "./routes/auth.js";
import userRoutes from "./routes/users.js";
import orgRoutes from "./routes/orgs.js";
import roleRoutes from "./routes/roles.js";
import groupRoutes from "./routes/groups.js";
import auditRoutes from "./routes/audit.js";
import nodeRoutes from "./routes/nodes.js";
import shareRoutes from "./routes/shares.js";
import versionRoutes from "./routes/versions.js";
import ssoRoutes from "./routes/sso.js";
import scimRoutes from "./routes/scim.js";
import { registerCollab } from "./collab/relay.js";

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: config.isProd ? "info" : "debug" },
    bodyLimit: config.maxBlobBytes,
    trustProxy: true,
  });

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin: config.corsOrigins.length ? config.corsOrigins : true,
    credentials: true,
    exposedHeaders: ["x-content-nonce"],
  });
  // Global limiter (per IP). Sensitive auth routes tighten this via per-route
  // `config.rateLimit` (see routes/auth.ts).
  await app.register(rateLimit, { max: 600, timeWindow: "1 minute" });
  await app.register(websocket);

  // Encrypted blob uploads arrive as raw bytes — pass the request stream through
  // (no buffering) so multi-GB blobs stream straight to storage.
  app.addContentTypeParser("application/octet-stream", (_req, payload, done) => done(null, payload));

  // Uniform error handling.
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError) {
      return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: { code: "validation", message: "Requête invalide.", details: err.issues } });
    }
    if ((err as { statusCode?: number }).statusCode === 429) {
      return reply.status(429).send({ error: { code: "rate_limited", message: "Trop de requêtes." } });
    }
    req.log.error({ err }, "unhandled error");
    return reply.status(500).send({ error: { code: "internal", message: "Erreur interne du serveur." } });
  });

  app.get("/api/health", async () => ({ ok: true, service: "elium-server", version: "0.1.0" }));

  await app.register(authRoutes, { prefix: "/api/auth" });
  await app.register(userRoutes, { prefix: "/api/users" });
  await app.register(orgRoutes, { prefix: "/api/orgs" });
  await app.register(roleRoutes, { prefix: "/api/orgs" });
  await app.register(groupRoutes, { prefix: "/api/orgs" });
  await app.register(auditRoutes, { prefix: "/api/orgs" });
  await app.register(nodeRoutes, { prefix: "/api/nodes" });
  await app.register(shareRoutes, { prefix: "/api" });
  await app.register(versionRoutes, { prefix: "/api" });
  await app.register(ssoRoutes, { prefix: "/api" });
  await app.register(scimRoutes, { prefix: "/api" });
  await registerCollab(app);

  return app;
}
