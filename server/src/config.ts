/**
 * Runtime configuration, read once from the environment. Fails fast on missing
 * critical values in production so misconfiguration never silently degrades
 * security (e.g. a default token secret).
 */

function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v !== undefined && v !== "") return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`Variable d'environnement manquante : ${name}`);
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Variable d'environnement invalide (nombre) : ${name}`);
  return n;
}

const isProd = process.env.NODE_ENV === "production";

const tokenSecret = env("TOKEN_SECRET", isProd ? undefined : "dev-only-change-me-please-32bytes-minimum-secret");
if (isProd && tokenSecret.length < 32) {
  throw new Error("TOKEN_SECRET doit faire au moins 32 caractères en production.");
}

// Guard against a placeholder committed to the repo (deploy/.env.example,
// docker-compose.yml's `${VAR:-default}` fallbacks) slipping unedited into a
// real deployment — `cp deploy/.env.example .env` without editing it passes
// the length/presence checks above (the placeholder IS 32+ chars) but is a
// PUBLIC, grep-able string, so the deployment would be trivially crackable
// regardless of TOKEN_SECRET's nominal length.
const KNOWN_PLACEHOLDER_SUBSTRINGS = ["CHANGE_ME", "change-me", "change_me"];
if (isProd && KNOWN_PLACEHOLDER_SUBSTRINGS.some((p) => tokenSecret.includes(p))) {
  throw new Error(
    "TOKEN_SECRET est encore une valeur d'exemple (deploy/.env.example) — générez un vrai secret aléatoire (voir install.sh).",
  );
}

const databaseUrl = env("DATABASE_URL", "postgres://elium:elium@localhost:5432/elium");
if (isProd && /:(elium|CHANGE_ME[^@]*|change-me[^@]*)@/i.test(databaseUrl)) {
  throw new Error(
    "DATABASE_URL utilise encore un mot de passe par défaut/exemple — définissez POSTGRES_PASSWORD dans .env (voir install.sh).",
  );
}

export const config = {
  isProd,
  port: num("PORT", 8787),
  host: env("HOST", "0.0.0.0"),
  corsOrigins: env("CORS_ORIGINS", "http://localhost:3100,http://localhost:5173")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  databaseUrl,

  tokenSecret,
  accessTokenTtl: num("ACCESS_TOKEN_TTL_SECONDS", 900),
  refreshTokenTtl: num("REFRESH_TOKEN_TTL_SECONDS", 2592000),

  storage: {
    driver: env("STORAGE_DRIVER", "fs") as "fs" | "s3",
    fsRoot: env("STORAGE_FS_ROOT", "./data/blobs"),
    s3: {
      endpoint: env("S3_ENDPOINT", "http://localhost:9000"),
      region: env("S3_REGION", "us-east-1"),
      bucket: env("S3_BUCKET", "elium-blobs"),
      accessKey: env("S3_ACCESS_KEY", "elium"),
      secretKey: env("S3_SECRET_KEY", "elium-secret"),
      forcePathStyle: env("S3_FORCE_PATH_STYLE", "true") === "true",
    },
  },

  maxBlobBytes: num("MAX_BLOB_BYTES", 2 * 1024 * 1024 * 1024),
  maxJsonBytes: num("MAX_JSON_BYTES", 1024 * 1024),
} as const;

export type Config = typeof config;
