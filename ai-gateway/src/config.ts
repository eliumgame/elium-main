/**
 * Configuration de la passerelle : fournisseurs, assistants, clients.
 *
 * Un seul fichier JSON (chemin `GATEWAY_CONFIG`, défaut `config/gateway.json`), validé au démarrage.
 * Les SECRETS n'y figurent jamais : un fournisseur nomme la variable d'environnement qui porte sa clé
 * (`apiKeyEnv`), et un client n'y est connu que par l'empreinte SHA-256 de sa clé (`keySha256`).
 */
import { readFileSync } from "node:fs";
import { z } from "zod";

const id = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, "identifiant : minuscules, chiffres, « . », « _ », « - » (64 max)");

export const ProviderSchema = z.object({
  /** URL de base d'une API compatible OpenAI, SANS le suffixe `/chat/completions`. */
  baseUrl: z.url(),
  /** Variable d'environnement contenant la clé d'API (absente = fournisseur sans clé, ex. Ollama local). */
  apiKeyEnv: z.string().optional(),
  /** Délai max pour recevoir les en-têtes de réponse du fournisseur. */
  timeoutMs: z.number().int().positive().max(600_000).default(30_000),
});

export const RouteStepSchema = z.object({
  provider: id,
  model: z.string().min(1).max(200),
  /**
   * Effort de raisonnement envoyé au fournisseur (`reasoning_effort`), s'il le prend en charge.
   * `none` = réponse directe (plus rapide, moins chère) : idéal pour reformuler, résumer, classer.
   */
  reasoningEffort: z.enum(["none", "low", "medium", "high", "xhigh"]).optional(),
  /** Prix indicatifs (€ par million de tokens) pour estimer la dépense ; facultatifs. */
  priceInPerMTok: z.number().nonnegative().optional(),
  priceOutPerMTok: z.number().nonnegative().optional(),
});

export const AssistantSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(1000).default(""),
  /** Consigne système ajoutée EN TÊTE de chaque conversation. Vide = accès « brut » au modèle. */
  systemPrompt: z.string().max(20_000).default(""),
  /** Fournisseurs essayés dans l'ordre : le suivant prend le relais si le précédent échoue (panne, 429, 5xx). */
  route: z.array(RouteStepSchema).min(1).max(5),
  temperature: z.number().min(0).max(2).optional(),
  /** Plafond de tokens générés par réponse (la demande du client est ramenée sous ce plafond). */
  maxTokens: z.number().int().positive().max(64_000).default(2048),
});

export const ClientSchema = z.object({
  name: z.string().min(1).max(120),
  /** Empreinte SHA-256 (hex) de la clé ; la clé elle-même n'est stockée nulle part. `npm run key:new`. */
  keySha256: z.string().regex(/^[0-9a-f]{64}$/, "empreinte SHA-256 hexadécimale attendue"),
  /** Assistants autorisés (`*` = tous). */
  assistants: z.array(z.union([id, z.literal("*")])).min(1),
  requestsPerMinute: z.number().int().positive().max(10_000).default(30),
  /** Plafond mensuel de tokens (entrée + sortie). 0 = illimité. */
  monthlyTokenQuota: z.number().int().nonnegative().default(2_000_000),
  disabled: z.boolean().default(false),
});

export const GatewayConfigSchema = z
  .object({
    providers: z.record(id, ProviderSchema),
    assistants: z.record(id, AssistantSchema),
    clients: z.record(id, ClientSchema),
    limits: z
      .object({
        /** Nombre max de messages par requête. */
        maxMessages: z.number().int().positive().default(100),
        /** Taille max cumulée du texte des messages (caractères). */
        maxInputChars: z.number().int().positive().default(400_000),
      })
      .prefault({}),
  })
  .superRefine((cfg, ctx) => {
    for (const [aid, a] of Object.entries(cfg.assistants)) {
      a.route.forEach((step, i) => {
        if (!cfg.providers[step.provider]) {
          ctx.addIssue({
            code: "custom",
            path: ["assistants", aid, "route", i, "provider"],
            message: `fournisseur inconnu « ${step.provider} »`,
          });
        }
      });
    }
    const seen = new Map<string, string>();
    for (const [cid, c] of Object.entries(cfg.clients)) {
      for (const a of c.assistants) {
        if (a !== "*" && !cfg.assistants[a]) {
          ctx.addIssue({ code: "custom", path: ["clients", cid, "assistants"], message: `assistant inconnu « ${a} »` });
        }
      }
      const other = seen.get(c.keySha256);
      if (other) {
        ctx.addIssue({
          code: "custom",
          path: ["clients", cid, "keySha256"],
          message: `même clé que le client « ${other} »`,
        });
      }
      seen.set(c.keySha256, cid);
    }
  });

export type GatewayConfig = z.infer<typeof GatewayConfigSchema>;
export type Provider = z.infer<typeof ProviderSchema>;
export type Assistant = z.infer<typeof AssistantSchema>;
export type Client = z.infer<typeof ClientSchema>;
export type RouteStep = z.infer<typeof RouteStepSchema>;

/** Valide un objet de configuration ; lève une erreur lisible (chemin + message) si invalide. */
export function parseConfig(raw: unknown): GatewayConfig {
  const res = GatewayConfigSchema.safeParse(raw);
  if (!res.success) {
    const lines = res.error.issues.map((i) => `  - ${i.path.join(".") || "(racine)"} : ${i.message}`);
    throw new Error(`Configuration de la passerelle invalide :\n${lines.join("\n")}`);
  }
  return res.data;
}

export function loadConfigFile(path: string): GatewayConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new Error(`Configuration introuvable : ${path} (copier config/gateway.example.json)`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`Configuration ${path} : JSON invalide (${(err as Error).message})`);
  }
  return parseConfig(raw);
}

/** Paramètres du processus (environnement). */
export function envSettings(env: NodeJS.ProcessEnv = process.env) {
  return {
    configPath: env.GATEWAY_CONFIG ?? "config/gateway.json",
    host: env.HOST ?? "0.0.0.0",
    port: Number(env.PORT ?? 8790),
    usageFile: env.USAGE_FILE ?? "data/usage.json",
    logLevel: env.LOG_LEVEL ?? "info",
  };
}
