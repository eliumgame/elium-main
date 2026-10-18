import { describe, expect, it } from "vitest";
import { strFromU8 } from "fflate";
import { backupFileStem, writeBackupFile } from "./file-sync";
import { normalizePassport, emptyPassport } from "./model";
import { parseBackup } from "./exportPasseport";
import type { FsFileHandle } from "../workspace/fs-access";

describe("sauvegarde automatique dans un fichier", () => {
  it("écrit la sauvegarde JSON complète dans la poignée, relisible à l'identique", async () => {
    const chunks: Blob[] = [];
    let closed = false;
    const handle = {
      name: "p.json",
      createWritable: async () => ({
        write: async (b: Blob) => void chunks.push(b),
        close: async () => void (closed = true),
      }),
    } as unknown as FsFileHandle;
    const d = emptyPassport();
    d.holder.nom = "Dupont";
    await writeBackupFile(handle, d);
    expect(closed).toBe(true);
    const text = await chunks[0].text();
    expect(strFromU8(new Uint8Array(await chunks[0].arrayBuffer()))).toBe(text);
    expect(normalizePassport(parseBackup(text))?.holder.nom).toBe("Dupont");
  });

  it("nom de fichier proposé", () => {
    const d = emptyPassport();
    expect(backupFileStem(d)).toBe("Passeport_GPME_candidat");
    d.holder.nom = "De La Fontaine";
    d.holder.prenom = "Léa";
    expect(backupFileStem(d)).toBe("Passeport_GPME_De_La_Fontaine_Léa");
  });
});
