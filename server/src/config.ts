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

/**
 * `trustProxy` pour Fastify. `trustProxy: true` ferait confiance à un
 * `X-Forwarded-For` fourni par N'IMPORTE QUI : un client peut alors usurper son
 * IP et se donner un compartiment de rate-limit neuf à chaque requête,
 * contournant l'anti-brute-force par IP sur l'authentification. Un simple nombre
 * de sauts ne suffit pas non plus (un attaquant joignant l'API en direct est
 * alors traité comme le proxy de confiance). Défaut robuste : ne faire confiance
 * qu'aux proxys sur adresses PRIVÉES/loopback (le reverse-proxy Caddy
 * co-localisé) — une connexion publique directe voit son X-Forwarded-For ignoré
 * et retombe sur l'IP réelle de la socket. Surchargeable via TRUST_PROXY :
 * "false", "true", un nombre de sauts, ou une liste d'IP/sous-réseaux.
 */
export const TRUSTED_LOCAL_PROXIES = ["loopback", "linklocal", "uniquelocal"];
export function parseTrustProxy(raw: string | undefined): boolean | number | string[] {
  if (raw === undefined) return TRUSTED_LOCAL_PROXIES; // défaut : proxys privés/loopback
  const v = raw.trim();
  if (v === "" || v === "false") return false;
  if (v === "true") return true;
  if (/^\d+$/.test(v)) return Number(v);
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

const databaseUrl = env("DATABASE_URL", "postgres://elium:elium@localhost:5432/elium");
if (isProd && /:(elium|CHANGE_ME[^@]*|change-me[^@]*)@/i.test(databaseUrl)) {
  throw new Error(
    "DATABASE_URL utilise encore un mot de passe par défaut/exemple — définissez POSTGRES_PASSWORD dans .env (voir install.sh).",
  );
}

export const config = {
  isProd,
  // Deployed application version, stamped into .env by install.sh (from
  // src/elium/__init__.py) and surfaced at /api/health so operators — and the
  // VPS auto-updater — can confirm which version is actually running. "dev"
  // when unset (local `npm run dev`).
  version: env("ELIUM_VERSION", "dev"),
  port: num("PORT", 8787),
  host: env("HOST", "0.0.0.0"),
  corsOrigins: env("CORS_ORIGINS", "http://localhost:3100,http://localhost:5173")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  databaseUrl,

  // Défaut : ne faire confiance qu'aux proxys privés/loopback — voir parseTrustProxy.
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),

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

  // Bornes du relais collaboratif (anti-DoS). Un update chiffré est plafonné en
  // octets (le ciphertext hex fait 2× cette taille sur le fil) ; le débit de
  // messages par connexion est plafonné (bien au-dessus d'une frappe humaine)
  // pour qu'un pair ne puisse pas inonder le relais et la base.
  maxCollabMessageBytes: num("MAX_COLLAB_MESSAGE_BYTES", 512 * 1024),
  maxCollabMessagesPerSec: num("MAX_COLLAB_MESSAGES_PER_SEC", 300),
  // Connexions WS collab simultanées par utilisateur (anti-épuisement). Large
  // pour un usage réel (onglets/appareils/documents multiples).
  maxCollabConnectionsPerUser: num("MAX_COLLAB_CONNECTIONS_PER_USER", 40),
} as const;

export type Config = typeof config;
