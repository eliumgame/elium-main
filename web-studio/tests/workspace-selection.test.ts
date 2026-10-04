import { describe, it, expect } from "vitest";
import {
  clickSelect,
  decodeDrag,
  dragPayload,
  emptySelection,
  encodeDrag,
  pruneSelection,
  selectAll,
  toggleSelect,
} from "../src/workspace/ui/selection";

const order = ["a", "b", "c", "d", "e"];
const none = { ctrl: false, shift: false };

describe("sélection multiple", () => {
  it("clic simple : sélection unique et ancre", () => {
    expect(clickSelect(emptySelection, "b", order, none)).toEqual({ selected: ["b"], anchor: "b" });
    expect(clickSelect({ selected: ["a", "c"], anchor: "c" }, "d", order, none)).toEqual({
      selected: ["d"],
      anchor: "d",
    });
  });

  it("Ctrl/Cmd bascule sans toucher aux autres", () => {
    let s = clickSelect(emptySelection, "a", order, none);
    s = clickSelect(s, "c", order, { ctrl: true, shift: false });
    expect(s.selected).toEqual(["a", "c"]);
    s = clickSelect(s, "a", order, { ctrl: true, shift: false });
    expect(s.selected).toEqual(["c"]);
  });

  it("Maj sélectionne la plage depuis l'ancre, dans les deux sens", () => {
    const s = clickSelect(emptySelection, "b", order, none);
    expect(clickSelect(s, "d", order, { ctrl: false, shift: true }).selected).toEqual(["b", "c", "d"]);
    expect(clickSelect(s, "a", order, { ctrl: false, shift: true }).selected).toEqual(["a", "b"]);
    expect(clickSelect(s, "d", order, { ctrl: false, shift: true }).anchor).toBe("b"); // l'ancre ne bouge pas
  });

  it("Ctrl+Maj ajoute la plage à la sélection existante", () => {
    let s = clickSelect(emptySelection, "a", order, none);
    s = clickSelect(s, "c", order, { ctrl: true, shift: false }); // a, c ; ancre c
    s = clickSelect(s, "e", order, { ctrl: true, shift: true });
    expect(s.selected.sort()).toEqual(["a", "c", "d", "e"]);
  });

  it("Maj sans ancre valide retombe sur un clic simple", () => {
    expect(clickSelect(emptySelection, "c", order, { ctrl: false, shift: true })).toEqual({
      selected: ["c"],
      anchor: "c",
    });
  });

  it("case à cocher, tout sélectionner, élagage", () => {
    expect(toggleSelect(emptySelection, "a").selected).toEqual(["a"]);
    expect(toggleSelect({ selected: ["a"], anchor: "a" }, "a").selected).toEqual([]);
    expect(selectAll(order).selected).toHaveLength(5);
    const pruned = pruneSelection({ selected: ["a", "z"], anchor: "z" }, order);
    expect(pruned).toEqual({ selected: ["a"], anchor: null });
    const same = { selected: ["a"], anchor: "a" };
    expect(pruneSelection(same, order)).toBe(same);
  });
});

describe("glisser-déposer", () => {
  it("emporte toute la sélection si l'élément glissé en fait partie, sinon lui seul", () => {
    const sel = { items: ["a", "b"], folders: ["f1"] };
    expect(dragPayload(sel, { kind: "item", id: "a" })).toEqual({ itemIds: ["a", "b"], folderIds: ["f1"] });
    expect(dragPayload(sel, { kind: "item", id: "z" })).toEqual({ itemIds: ["z"], folderIds: [] });
    expect(dragPayload(sel, { kind: "folder", id: "f9" })).toEqual({ itemIds: [], folderIds: ["f9"] });
  });

  it("encode/décode et rejette un contenu étranger", () => {
    const p = { itemIds: ["a"], folderIds: ["f"] };
    expect(decodeDrag(encodeDrag(p))).toEqual(p);
    expect(decodeDrag("pas du json")).toBeNull();
    expect(decodeDrag('{"itemIds":1}')).toBeNull();
    expect(decodeDrag(undefined)).toBeNull();
    expect(decodeDrag('{"itemIds":["a",3],"folderIds":[]}')).toEqual({ itemIds: ["a"], folderIds: [] });
  });
});
