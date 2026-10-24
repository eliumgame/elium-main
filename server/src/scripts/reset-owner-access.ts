/**
 * Secours : rendre l'accès à un compte bloqué par sa 2FA (typiquement le
 * propriétaire du Drive). À lancer SUR LE SERVEUR, jamais depuis le site :
 *
 *   docker compose exec api node dist/scripts/reset-owner-access.js proprietaire@exemple.fr
 *   docker compose exec -T api node dist/scripts/reset-owner-access.js proprietaire@exemple.fr --yes
 *
 * Désactive la 2FA du compte (application, codes de secours, clés d'accès), remet
 * la politique « 2FA obligatoire » à « facultative » si besoin, coupe ses sessions
 * et écrit une entrée dans le journal d'audit. Ne touche ni au mot de passe ni aux
 * clés. Sans `--yes`, demande de retaper l'adresse pour confirmer.
 */
import { createInterface } from "node:readline/promises";
import { closePool } from "../db/pool.js";
import { resetOwnerAccess } from "../lib/owner-access.js";

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const yes = args.includes("--yes");
  const email = args.find((a) => !a.startsWith("--"));
  if (!email) {
    console.error("Usage : node dist/scripts/reset-owner-access.js <e-mail> [--yes]");
    return 2;
  }
  if (!yes) {
    if (!process.stdin.isTTY) {
      console.error("Entrée non interactive : relancez avec --yes pour confirmer explicitement.");
      return 2;
    }
    console.log(`Cette action désactive la 2FA de « ${email} », coupe ses sessions et est journalisée.`);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question("Retapez l'adresse e-mail pour confirmer : ")).trim().toLowerCase();
    rl.close();
    if (answer !== email.toLowerCase()) {
      console.error("Confirmation différente : abandon, rien n'a été modifié.");
      return 1;
    }
  }
  const r = await resetOwnerAccess(email);
  console.log(
    `OK — 2FA désactivée pour ${r.email}` +
      (r.hadTotp ? " (application d'authentification retirée)" : "") +
      (r.passkeysRemoved ? `, ${r.passkeysRemoved} clé(s) d'accès retirée(s)` : "") +
      (r.policyReset ? ". La politique « 2FA obligatoire » a été remise à « facultative »." : ".") +
      " Sessions révoquées. Reconnectez-vous avec votre mot de passe, puis réactivez la 2FA.",
  );
  return 0;
}

main()
  .then(async (code) => {
    await closePool();
    process.exit(code);
  })
  .catch(async (err) => {
    console.error("Échec :", err instanceof Error ? err.message : err);
    await closePool().catch(() => {});
    process.exit(1);
  });
