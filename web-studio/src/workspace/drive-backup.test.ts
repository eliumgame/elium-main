import { describe, expect, it } from "vitest";
import { workspaceSignature } from "./drive-backup";
import type { WorkItem } from "./types";

const item = (id: string, modifiedAt: string, size: number): WorkItem =>
  ({
    id,
    modifiedAt,
    size,
    kind: "doc",
    contentStore: "drive",
    title: id,
    createdAt: modifiedAt,
    folderId: null,
    tags: [],
    starred: false,
    vaultProtected: false,
  }) as WorkItem;

describe("empreinte de l'espace de travail (déclenche la sauvegarde automatique)", () => {
  it("change quand un élément est ajouté, modifié ou agrandi, pas autrement", () => {
    const a = [item("1", "2026-10-01T10:00:00Z", 100)];
    const base = workspaceSignature(a);
    expect(workspaceSignature([...a])).toBe(base);
    expect(workspaceSignature([...a, item("2", "2026-10-01T09:00:00Z", 0)])).not.toBe(base);
    expect(workspaceSignature([item("1", "2026-10-02T10:00:00Z", 100)])).not.toBe(base);
    expect(workspaceSignature([item("1", "2026-10-01T10:00:00Z", 150)])).not.toBe(base);
    expect(workspaceSignature([])).toBe("0||0");
  });
});
