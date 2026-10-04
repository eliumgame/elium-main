/**
 * Diagrammes de type SmartArt (processus, cycle, hiérarchie, liste) générés à partir d'un PLAN : une ligne
 * par nœud, le retrait (ou « - ») donne le niveau. Le plan reste la source de vérité : le diagramme est
 * recalculé à chaque affichage, donc toujours modifiable. Mise en page PURE, en pourcentages de la boîte
 * de l'élément ; utilisée par le rendu, l'aperçu de l'éditeur et l'export PPTX.
 */
import type { DiagramKind } from "./model";

export interface OutlineNode {
  text: string;
  level: number;
  children: OutlineNode[];
}

export const DIAGRAM_PALETTE = ["#2563eb", "#16a34a", "#f59e0b", "#7c3aed", "#0891b2", "#dc2626", "#db2777", "#475569"];

/** « A », « - B », « ··C » (2 espaces / 1 tabulation par niveau) → arbre. Lignes vides ignorées ; niveaux bornés. */
export function parseOutline(text: string): OutlineNode[] {
  const roots: OutlineNode[] = [];
  const stack: OutlineNode[] = [];
  for (const raw of text.replace(/\r/g, "").split("\n")) {
    if (!raw.trim()) continue;
    const indentMatch = /^[ \t]*/.exec(raw)![0];
    let level = 0;
    for (const ch of indentMatch) level += ch === "\t" ? 1 : 0.5;
    level = Math.floor(level);
    const label = raw.trim().replace(/^[-*•]\s*/, "").trim();
    if (!label) continue;
    // niveau au plus un cran sous le parent courant
    level = Math.min(level, stack.length);
    const node: OutlineNode = { text: label, level, children: [] };
    stack.length = level;
    if (level === 0) roots.push(node);
    else stack[level - 1]!.children.push(node);
    stack.push(node);
  }
  return roots;
}

export function outlineToText(nodes: OutlineNode[], depth = 0): string {
  return nodes.map((n) => `${"  ".repeat(depth)}${n.text}\n${outlineToText(n.children, depth + 1)}`).join("");
}

export interface DNode {
  id: number;
  text: string;
  level: number;
  /** Position/taille en % de la boîte. */
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  round: boolean; // true = ellipse (cycle)
}
export interface DEdge {
  from: number;
  to: number;
  /** « arrow » = flèche de processus/cycle ; « line » = lien hiérarchique. */
  kind: "arrow" | "line";
}
export interface DiagramLayout {
  nodes: DNode[];
  edges: DEdge[];
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

export function layoutDiagram(kind: DiagramKind, outline: string, colors?: string[]): DiagramLayout {
  const palette = colors?.length ? colors : DIAGRAM_PALETTE;
  const roots = parseOutline(outline);
  const nodes: DNode[] = [];
  const edges: DEdge[] = [];
  let id = 0;
  const add = (n: Omit<DNode, "id">): DNode => {
    const node = { ...n, id: id++ };
    nodes.push(node);
    return node;
  };
  const colorOf = (i: number) => palette[i % palette.length]!;
  if (!roots.length) return { nodes, edges };

  if (kind === "process") {
    const n = roots.length;
    const gap = n > 1 ? 6 : 0;
    const w = (100 - gap * (n - 1)) / n;
    const hMain = 28;
    const top = 8;
    let prev: DNode | null = null;
    roots.forEach((r, i) => {
      const main = add({ text: r.text, level: 0, x: i * (w + gap), y: top, w, h: hMain, color: colorOf(i), round: false });
      if (prev) edges.push({ from: prev.id, to: main.id, kind: "arrow" });
      prev = main;
      const kids = r.children;
      const kh = kids.length ? clamp((100 - top - hMain - 10 - 4 * (kids.length - 1)) / kids.length, 8, 16) : 0;
      kids.forEach((k, j) => add({ text: k.text, level: 1, x: i * (w + gap) + w * 0.08, y: top + hMain + 8 + j * (kh + 4), w: w * 0.84, h: kh, color: colorOf(i), round: false }));
    });
  } else if (kind === "list") {
    const rows = roots.reduce((a, r) => a + 1 + r.children.length, 0);
    const gap = 3;
    const h = clamp((100 - gap * (rows - 1)) / rows, 6, 22);
    let y = 0;
    roots.forEach((r, i) => {
      add({ text: r.text, level: 0, x: 0, y, w: 100, h, color: colorOf(i), round: false });
      y += h + gap;
      r.children.forEach((k) => {
        add({ text: k.text, level: 1, x: 10, y, w: 90, h: h * 0.85, color: colorOf(i), round: false });
        y += h * 0.85 + gap;
      });
    });
  } else if (kind === "cycle") {
    const n = roots.length;
    const nw = n <= 3 ? 36 : 30;
    const nh = n <= 3 ? 24 : 20;
    const cx = 50;
    const cy = 50;
    const rx = 50 - nw / 2;
    const ry = 50 - nh / 2;
    const placed = roots.map((r, i) => {
      const a = (2 * Math.PI * i) / n - Math.PI / 2;
      return add({ text: r.text, level: 0, x: cx + rx * Math.cos(a) - nw / 2, y: cy + ry * Math.sin(a) - nh / 2, w: nw, h: nh, color: colorOf(i), round: true });
    });
    if (n > 1) placed.forEach((p, i) => edges.push({ from: p.id, to: placed[(i + 1) % n]!.id, kind: "arrow" }));
  } else {
    // hiérarchie : arbre, une rangée par niveau, feuilles régulièrement espacées
    const depth = (n: OutlineNode): number => 1 + Math.max(0, ...n.children.map(depth));
    const levels = Math.max(...roots.map(depth));
    const leaves = (n: OutlineNode): number => (n.children.length ? n.children.reduce((a, c) => a + leaves(c), 0) : 1);
    const totalLeaves = roots.reduce((a, r) => a + leaves(r), 0);
    const rowH = clamp(100 / (levels * 1.6), 9, 22);
    const rowGap = levels > 1 ? (100 - levels * rowH) / (levels - 1) : 0;
    const slotW = 100 / totalLeaves;
    const nodeW = clamp(slotW * 0.86, 9, 40);
    let leafIdx = 0;
    const place = (n: OutlineNode, lvl: number, topColor: number, parent?: DNode): DNode => {
      let cxn: number;
      const kidsPlaced: DNode[] = [];
      if (n.children.length) {
        const start = leafIdx;
        // le parent est créé d'abord (ordre stable des ids), puis recentré une fois ses enfants placés
        const holder: DNode = add({ text: n.text, level: lvl, x: 0, y: lvl * (rowH + rowGap), w: nodeW, h: rowH, color: colorOf(topColor), round: false });
        for (const c of n.children) kidsPlaced.push(place(c, lvl + 1, topColor, holder));
        const end = leafIdx;
        cxn = ((start + end) / 2) * slotW;
        holder.x = clamp(cxn - nodeW / 2, 0, 100 - nodeW);
        if (parent) edges.push({ from: parent.id, to: holder.id, kind: "line" });
        return holder;
      }
      cxn = (leafIdx + 0.5) * slotW;
      leafIdx++;
      const leaf = add({ text: n.text, level: lvl, x: clamp(cxn - nodeW / 2, 0, 100 - nodeW), y: lvl * (rowH + rowGap), w: nodeW, h: rowH, color: colorOf(topColor), round: false });
      if (parent) edges.push({ from: parent.id, to: leaf.id, kind: "line" });
      return leaf;
    };
    if (roots.length === 1) place(roots[0]!, 0, 0);
    else {
      // plusieurs racines : une racine virtuelle n'existe pas — chaque arbre est posé côte à côte
      roots.forEach((r, i) => place(r, 0, i));
    }
  }
  return { nodes, edges };
}

/** Taille de police (px à REF_H) adaptée à la hauteur d'un nœud et à la longueur de son texte. */
export function nodeFontPx(node: DNode, boxHeightPx: number, boxWidthPx: number): number {
  const hPx = (node.h / 100) * boxHeightPx;
  const wPx = (node.w / 100) * boxWidthPx;
  const byHeight = hPx * 0.42;
  const chars = Math.max(4, node.text.length);
  const byWidth = (wPx * 1.7) / chars;
  return Math.round(clamp(Math.min(byHeight, Math.max(byWidth, 9)), 9, 40));
}

/** Lignes et hauteurs d'un plan, pour l'aperçu (le nombre de nœuds). */
export const nodeCount = (outline: string): number => {
  const count = (ns: OutlineNode[]): number => ns.reduce((a, n) => a + 1 + count(n.children), 0);
  return count(parseOutline(outline));
};

export const DIAGRAM_KIND_LABELS: Record<DiagramKind, string> = {
  process: "Processus",
  cycle: "Cycle",
  hierarchy: "Hiérarchie",
  list: "Liste",
};

export const DEFAULT_OUTLINE: Record<DiagramKind, string> = {
  process: "Étape 1\nÉtape 2\nÉtape 3\n",
  cycle: "Planifier\nFaire\nVérifier\nAméliorer\n",
  hierarchy: "Direction\n  Marketing\n    Contenu\n    Social\n  Technique\n    Dev\n    Support\n",
  list: "Premier point\n  Détail\nDeuxième point\nTroisième point\n",
};
