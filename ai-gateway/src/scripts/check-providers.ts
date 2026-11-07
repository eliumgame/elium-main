/**
 * Vérifie chaque fournisseur configuré : clé présente, API joignable, et modèles des routes
 * réellement proposés (`GET /models`). `npm run providers:check` (lit GATEWAY_CONFIG et l'environnement).
 */
import { envSettings, loadConfigFile } from "../config.js";

const cfg = loadConfigFile(envSettings().configPath);
let failures = 0;

for (const [pid, p] of Object.entries(cfg.providers)) {
  const wanted = new Set<string>();
  for (const a of Object.values(cfg.assistants)) for (const s of a.route) if (s.provider === pid) wanted.add(s.model);
  const headers: Record<string, string> = {};
  if (p.apiKeyEnv) {
    const key = process.env[p.apiKeyEnv];
    if (!key) {
      console.log(`– ${pid} : ignoré (variable ${p.apiKeyEnv} absente)`);
      continue;
    }
    headers.authorization = `Bearer ${key}`;
  }
  try {
    const res = await fetch(`${p.baseUrl.replace(/\/+$/, "")}/models`, { headers, signal: AbortSignal.timeout(15000) });
    if (!res.ok) {
      failures++;
      console.log(`✗ ${pid} : HTTP ${res.status}`);
      continue;
    }
    const j = (await res.json()) as { data?: { id: string }[] };
    const available = new Set((j.data ?? []).map((m) => m.id));
    const missing = [...wanted].filter((m) => !available.has(m));
    if (missing.length) failures++;
    console.log(
      `${missing.length ? "✗" : "✓"} ${pid} : ${available.size} modèles disponibles` +
        (missing.length
          ? ` — ABSENTS : ${missing.join(", ")}`
          : wanted.size
            ? ` — routes OK (${[...wanted].join(", ")})`
            : ""),
    );
  } catch (err) {
    failures++;
    console.log(`✗ ${pid} : injoignable (${(err as Error).message})`);
  }
}
process.exit(failures ? 1 : 0);
