/**
 * Génère une clé de client : `npm run key:new -- <id-du-client>`.
 * Affiche la clé (à remettre au projet, une seule fois) et le bloc à coller dans config/gateway.json.
 */
import { generateKey } from "../auth.js";

const id = process.argv[2] ?? "mon-projet";
const { key, keySha256 } = generateKey();
console.log(`Clé à donner au projet « ${id} » (elle ne sera plus jamais affichée) :\n\n  ${key}\n`);
console.log(`À ajouter dans "clients" de config/gateway.json :\n`);
console.log(
  JSON.stringify(
    { [id]: { name: id, keySha256, assistants: ["*"], requestsPerMinute: 30, monthlyTokenQuota: 2000000 } },
    null,
    2,
  ),
);
