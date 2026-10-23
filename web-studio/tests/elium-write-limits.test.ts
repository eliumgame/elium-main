import { describe, expect, it } from "vitest";
import { createEliumFile } from "../src/format/document";
import { assertEliumEntrySize, EliumPackageError, writeEliumPackage } from "../src/format/elium-package";

describe("plafonds du format .elium à l'écriture", () => {
  it("refuse un élément au-dessus de la limite de lecture, avec un message explicite", () => {
    expect(() => assertEliumEntrySize("contenu", 128 * 1024 * 1024)).not.toThrow();
    expect(() => assertEliumEntrySize("contenu", 129 * 1024 * 1024)).toThrow(EliumPackageError);
    expect(() => assertEliumEntrySize("contenu", 129 * 1024 * 1024)).toThrow(/129 Mo.*maximum 128 Mo/);
  });

  it("refuse d'écrire une ressource trop grosse plutôt que de produire un fichier irrelisible", async () => {
    const file = await createEliumFile({ title: "Gros", profile: "standard" });
    const big = new Uint8Array(129 * 1024 * 1024);
    file.resourceIndex.push({
      id: "big",
      name: "big.bin",
      mime: "application/octet-stream",
      size: big.length,
      kind: "attachment",
    });
    file.resources.set("big", big);
    await expect(writeEliumPackage(file)).rejects.toThrow(/trop volumineux/);
  });
});
