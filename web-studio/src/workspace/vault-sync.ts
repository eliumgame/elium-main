/**
 * Rechiffrement coordonné de TOUS les magasins protégés par le coffre local
 * (bibliothèque, Parapheur, classeurs, présentations, PDF, catalogue) quand le
 * coffre est activé, changé ou désactivé. Chaque magasin est atomique à lui
 * seul (une transaction) ; entre magasins on COMPENSE : si l'un échoue, ceux qui
 * avaient déjà réussi sont ramenés à l'état d'origine (dans l'ordre inverse),
 * de sorte qu'un échec laisse toujours le coffre exactement comme avant.
 */
import type { VaultSecret } from "../crypto/local-vault";

export interface VaultParticipant {
  name: string;
  reencrypt(from: VaultSecret | undefined, to: VaultSecret | undefined): Promise<void>;
}

export interface RollbackFailure {
  name: string;
  error: unknown;
}

export class VaultMigrationError extends Error {
  constructor(
    message: string,
    readonly failedAt: string,
    readonly cause_: unknown,
    readonly rollbackFailures: RollbackFailure[],
  ) {
    super(message);
  }
}

export async function reencryptAll(
  parts: VaultParticipant[],
  from: VaultSecret | undefined,
  to: VaultSecret | undefined,
): Promise<void> {
  const done: VaultParticipant[] = [];
  for (const p of parts) {
    try {
      await p.reencrypt(from, to);
      done.push(p);
    } catch (e) {
      const failures: RollbackFailure[] = [];
      for (const d of [...done].reverse()) {
        try {
          await d.reencrypt(to, from);
        } catch (err) {
          failures.push({ name: d.name, error: err });
        }
      }
      const msg = e instanceof Error ? e.message : String(e);
      throw new VaultMigrationError(
        failures.length ? `${msg} (retour arrière incomplet : ${failures.map((f) => f.name).join(", ")})` : msg,
        p.name,
        e,
        failures,
      );
    }
  }
}
