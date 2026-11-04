/**
 * Décodage défensif des commentaires et du suivi des modifications : les attributs viennent d'un document
 * (JSON non fiable) et ne doivent jamais faire planter le panneau ni être rendus tels quels.
 */
import { describe, it, expect } from "vitest";
import { decodeComment } from "../src/panels/CommentsPanel";
import { decodeTrackBreak } from "../src/editor/TrackChanges";

describe("decodeComment", () => {
  it("décode un commentaire valide avec ses réponses", () => {
    const c = decodeComment({
      id: "c1",
      author: "Alice",
      text: "ok",
      createdAt: "2026-01-01T00:00:00Z",
      resolved: true,
      replies: [{ id: "r1", author: "Bob", text: "merci", createdAt: "2026-01-02T00:00:00Z" }],
    });
    expect(c).toMatchObject({ id: "c1", author: "Alice", resolved: true });
    expect(c!.replies).toHaveLength(1);
  });

  it("n'échoue pas sur des attributs mal typés (text objet, replies chaîne)", () => {
    const c = decodeComment({ id: "c2", text: {}, replies: "x", author: 42, createdAt: {}, resolved: "oui" });
    expect(c).toEqual({ id: "c2", author: "", text: "", createdAt: "", resolved: false, replies: [] });
  });

  it("écarte les réponses invalides sans perdre les valides", () => {
    const c = decodeComment({
      id: "c3",
      replies: [null, 5, { id: 1, text: "x" }, { id: "ok", text: "bon", author: {} }, { id: "nt" }],
    });
    expect(c!.replies.map((r) => r.id)).toEqual(["ok"]);
    expect(c!.replies[0]!.author).toBe("");
  });

  it("rejette l'absence d'identifiant", () => {
    expect(decodeComment({})).toBeNull();
    expect(decodeComment({ id: "" })).toBeNull();
    expect(decodeComment({ id: 7 })).toBeNull();
  });
});

describe("decodeTrackBreak", () => {
  it("accepte une marque valide et normalise les champs", () => {
    expect(decodeTrackBreak({ kind: "split", id: "a", author: "Zoé", ts: "t" })).toEqual({
      kind: "split",
      id: "a",
      author: "Zoé",
      ts: "t",
    });
    expect(decodeTrackBreak({ kind: "merge", author: { x: 1 } })).toEqual({
      kind: "merge",
      id: "",
      author: "",
      ts: "",
    });
  });
  it("renvoie null pour toute marque malformée, sans exception", () => {
    for (const bad of [null, undefined, 3, "x", [], {}, { kind: "autre" }, { kind: ["split"] }])
      expect(decodeTrackBreak(bad)).toBeNull();
  });
});
