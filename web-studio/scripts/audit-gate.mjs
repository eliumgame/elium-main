/**
 * Audit des dépendances de production (remplace `npm audit --audit-level=high` dans la CI).
 *
 * Même exigence : toute faille HIGH ou CRITICAL bloque. La SEULE différence : les failles listées
 * dans ACCEPTED, chacune avec sa raison et une date de réexamen. Passée cette date l'exception
 * échoue d'elle-même, pour qu'on la revoie (un correctif existe peut-être) au lieu de l'oublier.
 */
import { execFileSync } from "node:child_process";

/** @type {Record<string, { reason: string; until: string }>} */
const ACCEPTED = {};

let raw;
try {
  raw = execFileSync("npm", ["audit", "--omit=dev", "--json"], {
    encoding: "utf8",
    shell: process.platform === "win32",
  });
} catch (e) {
  // `npm audit` sort en erreur dès qu'il trouve une faille : le JSON est sur stdout.
  raw = e.stdout?.toString() ?? "";
}
const report = JSON.parse(raw);
if (report.error) {
  console.error("audit-gate: `npm audit` a échoué :", report.error.summary ?? report.error);
  process.exit(1);
}

const today = new Date().toISOString().slice(0, 10);
const blocking = [];
for (const [name, v] of Object.entries(report.vulnerabilities ?? {})) {
  if (v.severity !== "high" && v.severity !== "critical") continue;
  const advisories = v.via.filter((x) => typeof x === "object");
  // Une faille transitive (via = noms de paquets) est portée par l'entrée de ce paquet.
  if (!advisories.length) continue;
  for (const a of advisories) {
    if (a.severity !== "high" && a.severity !== "critical") continue;
    const id = String(a.url ?? "")
      .split("/")
      .pop();
    const ok = ACCEPTED[id];
    if (ok && today <= ok.until) {
      console.log(`audit-gate: ${name} — ${id} acceptée jusqu'au ${ok.until} (${ok.reason})`);
    } else {
      blocking.push(`${name}: ${a.title} — ${a.url}${ok ? ` (exception expirée le ${ok.until})` : ""}`);
    }
  }
}
if (blocking.length) {
  console.error("audit-gate: failles bloquantes :\n  - " + blocking.join("\n  - "));
  process.exit(1);
}
console.log("audit-gate: aucune faille haute ou critique non acceptée.");
