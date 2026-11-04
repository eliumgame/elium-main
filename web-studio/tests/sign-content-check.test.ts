/**
 * Signature par lien : à la réception, l'émetteur compare l'empreinte de contenu du document revenu
 * à celle du document envoyé (sign-baseline.ts) et signale « contenu modifié par le signataire ».
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createEliumFile } from "../src/format/document";
import { writeEliumPackage, readEliumPackage } from "../src/format/elium-package";
import {
  compareSignedContent,
  getSignBaseline,
  saveSignBaseline,
  SIGNED_CONTENT_MODIFIED_MESSAGE,
} from "../src/drive-cloud/sign-baseline";

async function roundTrip(text: string) {
  const file = await createEliumFile({ title: "Contrat", profile: "standard" as never });
  file.document.doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] } as never;
  const bytes = await writeEliumPackage(file, {});
  return (await readEliumPackage(bytes, {})).file;
}

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("compareSignedContent", () => {
  it("même contenu : inchangé", async () => {
    const f = await roundTrip("Contrat");
    const base = f.manifest.integrity.contentHash!;
    expect(compareSignedContent(base, f)).toBe("unchanged");
    expect(compareSignedContent(base.toUpperCase(), f)).toBe("unchanged");
  });

  it("contenu remplacé par le signataire : modifié, avec message dédié", async () => {
    const sent = await roundTrip("Contrat à 100 euros");
    const returned = await roundTrip("Contrat à 100 000 euros");
    const verdict = compareSignedContent(sent.manifest.integrity.contentHash, returned);
    expect(verdict).toBe("modified");
    expect(SIGNED_CONTENT_MODIFIED_MESSAGE).toMatch(/modifié par le signataire/);
  });

  it("sans empreinte de base ou sans empreinte dans le fichier : inconnu (jamais de fausse alerte)", async () => {
    const f = await roundTrip("X");
    expect(compareSignedContent(null, f)).toBe("unknown");
    expect(compareSignedContent("a".repeat(64), null)).toBe("unknown");
  });
});

describe("base mémorisée", () => {
  it("se retrouve par nœud + demande, et ignore une valeur vide", () => {
    saveSignBaseline("n1", "r1", "ABCD");
    saveSignBaseline("n1", "r2", null);
    expect(getSignBaseline("n1", "r1")).toBe("abcd");
    expect(getSignBaseline("n1", "r2")).toBeNull();
    expect(getSignBaseline("n2", "r1")).toBeNull();
  });
});
