import { describe, it, expect } from "vitest";
import {
  SESSION_KEY,
  classifyDrafts,
  endSession,
  offerAfterCrash,
  previewOf,
  readMarker,
  startSession,
  type KeyValueStorage,
} from "../src/workspace/recovery";

function memStorage(initial: Record<string, string> = {}): KeyValueStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
  };
}

describe("session et fermeture anormale", () => {
  it("premier lancement : rien à signaler, marqueur ouvert", () => {
    const s = memStorage();
    const r = startSession(s, new Date("2026-10-01T09:00:00Z"), () => "s1");
    expect(r).toMatchObject({ uncleanExit: false, previousStartedAt: null });
    expect(readMarker(s)).toMatchObject({ id: "s1", clean: false });
  });

  it("fermeture normale puis relance : pas de récupération", () => {
    const s = memStorage();
    const a = startSession(s, new Date("2026-10-01T09:00:00Z"), () => "s1");
    endSession(s, a.marker.id);
    const b = startSession(s, new Date("2026-10-01T10:00:00Z"), () => "s2");
    expect(b.uncleanExit).toBe(false);
  });

  it("session jamais terminée : fermeture anormale détectée, avec l'heure de début de la précédente", () => {
    const s = memStorage();
    startSession(s, new Date("2026-10-01T09:00:00Z"), () => "s1");
    const b = startSession(s, new Date("2026-10-01T10:00:00Z"), () => "s2");
    expect(b).toMatchObject({ uncleanExit: true, previousStartedAt: "2026-10-01T09:00:00.000Z" });
  });

  it("ne marque pas propre la session d'une autre fenêtre", () => {
    const s = memStorage();
    startSession(s, new Date("2026-10-01T09:00:00Z"), () => "s1");
    startSession(s, new Date("2026-10-01T09:05:00Z"), () => "s2");
    endSession(s, "s1"); // la fenêtre 1 se ferme alors que s2 est la session courante
    expect(readMarker(s)).toMatchObject({ id: "s2", clean: false });
  });

  it("un marqueur illisible est ignoré sans fausse alerte", () => {
    const s = memStorage({ [SESSION_KEY]: "{pas du json" });
    expect(startSession(s, new Date(), () => "s").uncleanExit).toBe(false);
    expect(readMarker(memStorage({ [SESSION_KEY]: '{"id":1}' }))).toBeNull();
  });

  it("un stockage qui refuse l'écriture ne plante pas", () => {
    const broken: KeyValueStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
    };
    expect(() => startSession(broken, new Date(), () => "s")).not.toThrow();
    expect(() => endSession(broken, "s")).not.toThrow();
  });
});

describe("brouillons récupérables", () => {
  const drafts = [
    { id: "a", title: "A", updatedAt: "2026-10-01T09:30:00.000Z", size: 10, protected: false },
    { id: "b", title: "B", updatedAt: "2026-09-20T09:30:00.000Z", size: 10, protected: true },
    { id: "c", title: "C", updatedAt: "2026-10-01T09:45:00.000Z", size: 10, protected: false },
  ];

  it("repère ce que la bibliothèque contient déjà, et ce qui date de la dernière session", () => {
    const lib = new Map([
      ["a", "2026-10-01T09:30:00.000Z"], // enregistré au même instant : brouillon périmé
      ["c", "2026-10-01T09:00:00.000Z"], // bibliothèque plus ancienne : le brouillon est plus récent
    ]);
    const out = classifyDrafts(drafts, lib, "2026-10-01T09:00:00.000Z");
    expect(out.map((d) => d.id)).toEqual(["c", "a", "b"]); // plus récent d'abord
    expect(out.find((d) => d.id === "a")).toMatchObject({ saved: true, fromLastSession: true });
    expect(out.find((d) => d.id === "c")).toMatchObject({ saved: false, fromLastSession: true });
    expect(out.find((d) => d.id === "b")).toMatchObject({ saved: false, fromLastSession: false });
  });

  it("après un plantage on ne propose jamais un brouillon déjà enregistré", () => {
    const lib = new Map([["a", "2026-10-02T00:00:00.000Z"]]);
    const offer = offerAfterCrash(classifyDrafts(drafts, lib, null));
    expect(offer.map((d) => d.id)).toEqual(["c", "b"]);
  });

  it("aperçu : une ligne, tronquée avec une ellipse", () => {
    expect(previewOf("  Bonjour\n\n  le   monde ")).toBe("Bonjour le monde");
    const long = previewOf("mot ".repeat(100), 20);
    expect(long.length).toBe(20);
    expect(long.endsWith("…")).toBe(true);
  });
});
