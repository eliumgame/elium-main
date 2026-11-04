/**
 * BoundAwareness : chaque socket authentifié possède UN créneau de présence local ; l'identifiant Yjs
 * annoncé par l'émetteur n'est jamais utilisé comme cible, et le contenu est reconstruit champ par champ.
 */
import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import { BoundAwareness } from "../src/drive-cloud/collab-awareness";

function packet(remoteId: number, clock: number, state: unknown): Uint8Array {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, 1);
  encoding.writeVarUint(enc, remoteId);
  encoding.writeVarUint(enc, clock);
  encoding.writeVarString(enc, JSON.stringify(state));
  return encoding.toUint8Array(enc);
}

function setup() {
  const awareness = new Awareness(new Y.Doc());
  return { awareness, bound: new BoundAwareness(awareness) };
}

const others = (a: Awareness) => [...a.getStates().entries()].filter(([id]) => id !== a.clientID);

describe("BoundAwareness", () => {
  it("n'utilise jamais l'identifiant Yjs de l'émetteur comme cible", () => {
    const { awareness, bound } = setup();
    // L'émetteur prétend être le client local : l'état local ne doit pas être écrasé.
    awareness.setLocalState({ user: { name: "moi" } });
    bound.apply(packet(awareness.clientID, 1, { slide: 3 }), "u1", "p1", "Alice");
    expect((awareness.getLocalState() as { user: { name: string } }).user.name).toBe("moi");
    const rest = others(awareness);
    expect(rest).toHaveLength(1);
    expect(rest[0]![0]).not.toBe(awareness.clientID);
  });

  it("reconstruit l'état : nom plafonné, couleur et userId imposés, champs inconnus ignorés", () => {
    const { awareness, bound } = setup();
    bound.apply(
      packet(7, 1, { slide: 2, evil: "x", user: { name: "pirate", color: "red" }, cell: { s: 0, ref: "B4" } }),
      "u1",
      "p1",
      "A".repeat(500),
    );
    const [, state] = others(awareness)[0]! as [number, Record<string, any>];
    expect(state.user.userId).toBe("u1");
    expect(state.user.name).toHaveLength(200);
    expect(state.user.color).not.toBe("red");
    expect(state.evil).toBeUndefined();
    expect(state.slide).toBe(2);
    expect(state.cell).toEqual({ s: 0, ref: "B4" });
  });

  it("refuse qu'un autre utilisateur ou un autre identifiant distant réutilise le créneau d'un pair", () => {
    const { awareness, bound } = setup();
    bound.apply(packet(7, 1, { slide: 1 }), "u1", "p1", "Alice");
    bound.apply(packet(7, 2, { slide: 9 }), "u2", "p1", "Mallory"); // même socket, autre utilisateur
    bound.apply(packet(8, 3, { slide: 9 }), "u1", "p1", "Alice"); // même socket, autre id distant
    const states = others(awareness);
    expect(states).toHaveLength(1);
    expect((states[0]![1] as { slide: number }).slide).toBe(1);
  });

  it("ignore les paquets malformés, trop gros ou mal typés", () => {
    const { awareness, bound } = setup();
    bound.apply(new Uint8Array(40 * 1024), "u1", "p1", "A"); // trop gros
    bound.apply(packet(7, 1, "pas un objet"), "u1", "p2", "A");
    const bad = packet(7, 1, { slide: 1 });
    bound.apply(Uint8Array.from([...bad, 0]), "u1", "p4", "A"); // octets en trop
    bound.apply(packet(7, 1, { slide: 1 }), "", "p5", "A"); // sans utilisateur
    expect(others(awareness)).toHaveLength(0);
  });

  it("deux pairs distincts obtiennent deux créneaux locaux distincts, et `null` retire la présence", () => {
    const { awareness, bound } = setup();
    bound.apply(packet(1, 1, { slide: 1 }), "u1", "p1", "A");
    bound.apply(packet(1, 1, { slide: 2 }), "u2", "p2", "B"); // même id distant, autre socket
    expect(others(awareness)).toHaveLength(2);
    bound.apply(packet(1, 2, null), "u1", "p1", "A");
    expect(others(awareness)).toHaveLength(1);
  });
});
