import { describe, it, expect } from "vitest";
import {
  DEFAULT_OUTLINE,
  layoutDiagram,
  nodeCount,
  nodeFontPx,
  outlineToText,
  parseOutline,
} from "../src/slides/diagram";

const inside = (x: number, w: number) => x >= -0.01 && x + w <= 100.01;

describe("plan d'un diagramme", () => {
  it("niveaux par retrait (2 espaces, tabulation, tiret), lignes vides ignorées, niveau borné", () => {
    const t = parseOutline("A\n  B\n\tC\n\n- D\n      E\nF");
    expect(t.map((n) => n.text)).toEqual(["A", "D", "F"]);
    // A → B (niveau 1), C (niveau 1) ; « - D » au niveau 0 : racine ; E trop profond → un cran sous D
    const a = parseOutline("A\n  B\n\tC\n- D\n      E");
    expect(a.map((n) => n.text)).toEqual(["A", "D"]);
    expect(a[0]!.children.map((n) => n.text)).toEqual(["B", "C"]);
    expect(a[1]!.children.map((n) => n.text)).toEqual(["E"]);
    expect(parseOutline("")).toEqual([]);
  });
  it("aller-retour plan → arbre → texte", () => {
    const o = DEFAULT_OUTLINE.hierarchy;
    expect(outlineToText(parseOutline(o))).toBe(o);
    expect(nodeCount(o)).toBe(7);
  });
});

describe("mise en page des diagrammes", () => {
  it("processus : une boîte par étape alignées, flèches entre elles, enfants dessous", () => {
    const l = layoutDiagram("process", "A\n  a1\nB\nC");
    const mains = l.nodes.filter((n) => n.level === 0);
    expect(mains).toHaveLength(3);
    expect(new Set(mains.map((n) => n.y)).size).toBe(1);
    expect(mains[1]!.x).toBeGreaterThan(mains[0]!.x + mains[0]!.w - 0.01);
    expect(l.edges.filter((e) => e.kind === "arrow")).toHaveLength(2);
    const kid = l.nodes.find((n) => n.level === 1)!;
    expect(kid.y).toBeGreaterThan(mains[0]!.y + mains[0]!.h);
    for (const n of l.nodes) expect(inside(n.x, n.w)).toBe(true);
  });
  it("liste : piles verticales, détails en retrait", () => {
    const l = layoutDiagram("list", DEFAULT_OUTLINE.list);
    const ys = l.nodes.map((n) => n.y);
    expect([...ys].sort((a, b) => a - b)).toEqual(ys);
    expect(l.nodes.find((n) => n.level === 1)!.x).toBeGreaterThan(0);
    expect(l.nodes.every((n) => n.y + n.h <= 100.01)).toBe(true);
  });
  it("cycle : nœuds elliptiques sur un cercle, flèches circulaires (le dernier boucle sur le premier)", () => {
    const l = layoutDiagram("cycle", DEFAULT_OUTLINE.cycle);
    expect(l.nodes).toHaveLength(4);
    expect(l.nodes.every((n) => n.round)).toBe(true);
    expect(l.edges).toHaveLength(4);
    expect(l.edges.at(-1)).toMatchObject({ from: 3, to: 0 });
    for (const n of l.nodes) expect(inside(n.x, n.w) && n.y >= -0.01 && n.y + n.h <= 100.01).toBe(true);
    expect(layoutDiagram("cycle", "seul").edges).toHaveLength(0);
  });
  it("hiérarchie : une rangée par niveau, parent centré sur ses enfants, liens parent→enfant", () => {
    const l = layoutDiagram("hierarchy", DEFAULT_OUTLINE.hierarchy);
    expect(l.nodes).toHaveLength(7);
    expect(l.edges).toHaveLength(6);
    const root = l.nodes.find((n) => n.level === 0)!;
    const kids = l.nodes.filter((n) => n.level === 1);
    const mid = (kids[0]!.x + kids[0]!.w / 2 + kids[1]!.x + kids[1]!.w / 2) / 2;
    expect(root.x + root.w / 2).toBeCloseTo(mid, 0);
    expect(new Set(l.nodes.map((n) => n.y)).size).toBe(3);
    for (const n of l.nodes) expect(inside(n.x, n.w)).toBe(true);
    // les feuilles ne se chevauchent pas
    const leaves = l.nodes.filter((n) => n.level === 2).sort((a, b) => a.x - b.x);
    for (let i = 1; i < leaves.length; i++)
      expect(leaves[i]!.x).toBeGreaterThanOrEqual(leaves[i - 1]!.x + leaves[i - 1]!.w - 0.01);
  });
  it("plusieurs arbres côte à côte ; plan vide : rien", () => {
    expect(layoutDiagram("hierarchy", "A\n  a\nB\n  b").nodes).toHaveLength(4);
    expect(layoutDiagram("process", "")).toEqual({ nodes: [], edges: [] });
  });
  it("couleurs personnalisées et taille de police bornée", () => {
    const l = layoutDiagram("process", "A\nB", ["#111111", "#222222"]);
    expect(l.nodes.map((n) => n.color)).toEqual(["#111111", "#222222"]);
    expect(nodeFontPx(l.nodes[0]!, 400, 600)).toBeGreaterThanOrEqual(9);
    expect(nodeFontPx({ ...l.nodes[0]!, text: "x".repeat(400) }, 400, 600)).toBe(9);
    expect(nodeFontPx({ ...l.nodes[0]!, h: 100, w: 100, text: "ok" }, 4000, 4000)).toBe(40);
  });
});
