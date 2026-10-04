import { describe, it, expect } from "vitest";
import { VaultMigrationError, reencryptAll, type VaultParticipant } from "../src/workspace/vault-sync";
import type { VaultSecret } from "../src/crypto/local-vault";

const A: VaultSecret = { password: "a" };
const B: VaultSecret = { password: "b" };

function part(name: string, log: string[], failOn?: "forward" | "back"): VaultParticipant {
  return {
    name,
    async reencrypt(from, to) {
      const dir = from === A && to === B ? "forward" : "back";
      log.push(`${name}:${from?.password ?? "-"}>${to?.password ?? "-"}`);
      if (failOn === dir) throw new Error(`${name} échoue`);
    },
  };
}

describe("rechiffrement coordonné", () => {
  it("exécute chaque magasin dans l'ordre", async () => {
    const log: string[] = [];
    await reencryptAll([part("drive", log), part("sheets", log), part("pdfs", log)], A, B);
    expect(log).toEqual(["drive:a>b", "sheets:a>b", "pdfs:a>b"]);
  });

  it("si un magasin échoue, ramène ceux déjà migrés, dans l'ordre inverse", async () => {
    const log: string[] = [];
    const parts = [part("drive", log), part("sheets", log), part("slides", log, "forward"), part("pdfs", log)];
    await expect(reencryptAll(parts, A, B)).rejects.toThrow("slides échoue");
    expect(log).toEqual(["drive:a>b", "sheets:a>b", "slides:a>b", "sheets:b>a", "drive:b>a"]);
  });

  it("signale un retour arrière incomplet sans masquer l'erreur d'origine", async () => {
    const log: string[] = [];
    const parts = [part("drive", log, "back"), part("sheets", log, "forward")];
    const err = (await reencryptAll(parts, A, B).catch((e) => e)) as VaultMigrationError;
    expect(err).toBeInstanceOf(VaultMigrationError);
    expect(err.failedAt).toBe("sheets");
    expect(err.rollbackFailures.map((f) => f.name)).toEqual(["drive"]);
    expect(err.message).toMatch(/retour arrière incomplet : drive/);
  });

  it("la première défaillance ne déclenche aucun retour arrière", async () => {
    const log: string[] = [];
    await expect(reencryptAll([part("drive", log, "forward")], A, B)).rejects.toThrow();
    expect(log).toEqual(["drive:a>b"]);
  });
});
