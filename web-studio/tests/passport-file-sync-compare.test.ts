/**
 * Sauvegarde automatique du passeport dans un fichier : avant la première écriture d'une session, le fichier est
 * relu et comparé — une version d'un autre poste ne doit jamais être écrasée sans confirmation.
 */
import { describe, expect, it } from "vitest";
import { backupJson } from "../src/passport/exportPasseport";
import { compareBackupText, inspectBackupFile } from "../src/passport/file-sync";
import { emptyPassport } from "../src/passport/model";
import type { FsFileHandle } from "../src/workspace/fs-access";

const at = (iso: string, nom = "Dupont") => {
  const d = emptyPassport();
  d.holder.nom = nom;
  d.updatedAt = iso;
  return d;
};

describe("fichier de sauvegarde : comparaison avant écriture", () => {
  it("fichier vide ou neuf → peut être écrit", () => {
    expect(compareBackupText("", at("2026-10-01T10:00:00Z")).kind).toBe("empty");
    expect(compareBackupText("  \n", at("2026-10-01T10:00:00Z")).kind).toBe("empty");
  });

  it("même date de modification → identique, aucune écriture", () => {
    const d = at("2026-10-01T10:00:00Z");
    expect(compareBackupText(backupJson(d), d).kind).toBe("same");
  });

  it("même contenu à une autre date → identique", () => {
    const file = at("2026-10-01T10:00:00Z");
    expect(compareBackupText(backupJson(file), at("2026-10-02T10:00:00Z")).kind).toBe("same");
  });

  it("fichier plus récent écrit depuis un autre poste → conflit « file », version du fichier proposée", () => {
    const local = at("2026-10-01T10:00:00Z", "Ancien");
    const cmp = compareBackupText(backupJson(at("2026-10-08T10:00:00Z", "Lycée")), local);
    expect(cmp.kind).toBe("differs");
    if (cmp.kind !== "differs") return;
    expect(cmp.newer).toBe("file");
    expect(cmp.fileData.holder.nom).toBe("Lycée");
  });

  it("fichier plus ancien mais différent → conflit « local » (toujours demandé)", () => {
    const cmp = compareBackupText(backupJson(at("2026-10-01T10:00:00Z", "A")), at("2026-10-08T10:00:00Z", "B"));
    expect(cmp).toMatchObject({ kind: "differs", newer: "local" });
  });

  it("fichier étranger (non vide, pas une sauvegarde) → illisible, jamais écrasé d'office", () => {
    expect(compareBackupText("{ pas du json", at("2026-10-01T10:00:00Z")).kind).toBe("unreadable");
    expect(compareBackupText('"texte"', at("2026-10-01T10:00:00Z")).kind).toBe("unreadable");
  });

  it("inspectBackupFile lit la poignée (getFile) sans écrire", async () => {
    let writes = 0;
    const handle = {
      name: "p.json",
      getFile: async () => new File([backupJson(at("2026-10-08T10:00:00Z", "Lycée"))], "p.json"),
      createWritable: async () => {
        writes++;
        throw new Error("ne doit pas écrire");
      },
    } as unknown as FsFileHandle;
    const cmp = await inspectBackupFile(handle, at("2026-10-01T10:00:00Z"));
    expect(cmp.kind).toBe("differs");
    expect(writes).toBe(0);
  });
});
