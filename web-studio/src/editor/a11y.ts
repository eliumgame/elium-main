/**
 * Vérificateur d'accessibilité des documents (équivalent de celui de Word) :
 * texte alternatif des images, ordre des titres, en-têtes de tableaux, contraste
 * des couleurs de texte, liens non descriptifs, paragraphes vides de mise en forme.
 *
 * Fonction PURE sur le JSON ProseMirror (aucune dépendance à l'éditeur) : chaque
 * constat porte la position ProseMirror du nœud pour pouvoir s'y rendre.
 */
import type { ProseMirrorNode } from "../format/types";

export type A11ySeverity = "error" | "warning";
export type A11yRule =
  | "image-alt"
  | "heading-order"
  | "heading-empty"
  | "table-header"
  | "contrast"
  | "link-text"
  | "empty-paragraphs"
  | "no-title"
  | "doc-title";

export interface A11yIssue {
  rule: A11yRule;
  severity: A11ySeverity;
  message: string;
  /** Position ProseMirror (avant le nœud) ; -1 = le document entier. */
  pos: number;
}

export const A11Y_RULE_LABELS: Record<A11yRule, string> = {
  "image-alt": "Texte alternatif manquant",
  "heading-order": "Ordre des titres",
  "heading-empty": "Titre vide",
  "table-header": "Tableau sans en-tête",
  contrast: "Contraste insuffisant",
  "link-text": "Lien peu explicite",
  "empty-paragraphs": "Paragraphes vides",
  "no-title": "Aucun titre de niveau 1",
  "doc-title": "Titre du document manquant",
};

type PM = ProseMirrorNode & { text?: string; marks?: { type: string; attrs?: Record<string, unknown> }[] };

const LEAF = new Set(["image", "figure", "horizontalRule", "hardBreak", "pageBreak"]);
const sizeOf = (n: PM): number => {
  if (n.type === "text") return (n.text ?? "").length;
  if (LEAF.has(n.type) && !(n.content as unknown[] | undefined)?.length) return 1;
  return 2 + ((n.content as PM[] | undefined) ?? []).reduce((a, c) => a + sizeOf(c), 0);
};
const textOf = (n: PM): string =>
  n.type === "text" ? (n.text ?? "") : ((n.content as PM[] | undefined) ?? []).map(textOf).join("");

/** Couleur CSS (#rgb, #rrggbb, rgb(), rgba()) → [r,g,b] ; null si illisible. */
export function parseColor(c: string | undefined | null): [number, number, number] | null {
  if (!c) return null;
  const s = c.trim().toLowerCase();
  let m = /^#([0-9a-f]{3})$/.exec(s);
  if (m) return m[1]!.split("").map((x) => parseInt(x + x, 16)) as [number, number, number];
  m = /^#([0-9a-f]{6})/.exec(s);
  if (m) return [0, 2, 4].map((i) => parseInt(m![1]!.slice(i, i + 2), 16)) as [number, number, number];
  m = /^rgba?\(\s*(\d+)[ ,]+(\d+)[ ,]+(\d+)/.exec(s);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  return null;
}
const lum = ([r, g, b]: [number, number, number]): number => {
  const f = (v: number) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
/** Rapport de contraste WCAG (1 à 21). */
export function contrastRatio(a: [number, number, number], b: [number, number, number]): number {
  const la = lum(a),
    lb = lum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const VAGUE_LINKS = new Set(["ici", "cliquez ici", "cliquer ici", "lien", "ce lien", "en savoir plus", "plus", "voir", "click here", "here"]);

export function checkAccessibility(doc: ProseMirrorNode, opts: { title?: string } = {}): A11yIssue[] {
  const issues: A11yIssue[] = [];
  const root = doc as PM;
  if (opts.title !== undefined && !opts.title.trim())
    issues.push({ rule: "doc-title", severity: "warning", message: "Le document n'a pas de titre (propriétés du document).", pos: -1 });

  let lastLevel = 0;
  let sawH1 = false;
  let emptyRun = 0;
  let emptyRunStart = -1;
  const flushEmpty = () => {
    if (emptyRun >= 3)
      issues.push({
        rule: "empty-paragraphs",
        severity: "warning",
        message: `${emptyRun} paragraphes vides à la suite : utilisez l'espacement de paragraphe plutôt que des lignes vides.`,
        pos: emptyRunStart,
      });
    emptyRun = 0;
  };

  const walk = (node: PM, pos: number, bg: [number, number, number]) => {
    switch (node.type) {
      case "image":
      case "figure": {
        const alt = String((node.attrs as Record<string, unknown> | undefined)?.alt ?? "").trim();
        if (!alt)
          issues.push({ rule: "image-alt", severity: "error", message: "Image sans texte alternatif.", pos });
        break;
      }
      case "heading": {
        const level = Number((node.attrs as Record<string, unknown> | undefined)?.level) || 1;
        const t = textOf(node).trim();
        if (!t) issues.push({ rule: "heading-empty", severity: "error", message: "Titre vide (les lecteurs d'écran l'annoncent sans texte).", pos });
        if (level === 1) sawH1 = true;
        if (lastLevel && level > lastLevel + 1)
          issues.push({
            rule: "heading-order",
            severity: "warning",
            message: `Saut de niveau : un titre ${level} suit un titre ${lastLevel}${t ? ` (« ${t.slice(0, 40)} »)` : ""}.`,
            pos,
          });
        if (!lastLevel && level > 1)
          issues.push({ rule: "heading-order", severity: "warning", message: `Le premier titre est de niveau ${level} au lieu de 1.`, pos });
        lastLevel = level;
        break;
      }
      case "table": {
        const rows = (node.content as PM[] | undefined) ?? [];
        const first = (rows[0]?.content as PM[] | undefined) ?? [];
        if (!first.length || !first.every((c) => c.type === "tableHeader"))
          issues.push({ rule: "table-header", severity: "error", message: "Tableau sans ligne d'en-tête : la première ligne doit être un en-tête.", pos });
        break;
      }
      default:
    }

    if (node.type === "paragraph") {
      if (!textOf(node).trim() && !((node.content as PM[] | undefined) ?? []).some((c) => LEAF.has(c.type))) {
        if (!emptyRun) emptyRunStart = pos;
        emptyRun++;
      } else flushEmpty();
    } else if (node.type !== "text") flushEmpty();

    if (node.type === "text") {
      const marks = node.marks ?? [];
      const ts = marks.find((m) => m.type === "textStyle");
      const hl = marks.find((m) => m.type === "highlight");
      const fg = parseColor(ts?.attrs?.color as string | undefined);
      const hlBg = parseColor(hl?.attrs?.color as string | undefined);
      const back = hlBg ?? bg;
      if (fg && (node.text ?? "").trim()) {
        const r = contrastRatio(fg, back);
        if (r < 4.5)
          issues.push({
            rule: "contrast",
            severity: "warning",
            message: `Contraste ${r.toFixed(1)}:1 (minimum 4,5:1) pour « ${(node.text ?? "").trim().slice(0, 30)} ».`,
            pos,
          });
      }
      const link = marks.find((m) => m.type === "link");
      if (link) {
        const t = (node.text ?? "").trim().toLowerCase();
        if (VAGUE_LINKS.has(t) || /^https?:\/\//.test(t) && t.length > 60)
          issues.push({ rule: "link-text", severity: "warning", message: `Texte de lien peu explicite : « ${node.text} ».`, pos });
      }
      return;
    }

    let childPos = pos + 1;
    for (const c of (node.content as PM[] | undefined) ?? []) {
      walk(c, childPos, bg);
      childPos += sizeOf(c);
    }
  };

  let pos = 0;
  for (const c of (root.content as PM[] | undefined) ?? []) {
    walk(c, pos, [255, 255, 255]);
    pos += sizeOf(c);
  }
  flushEmpty();
  const hasHeadings = lastLevel > 0;
  if (hasHeadings && !sawH1) issues.push({ rule: "no-title", severity: "warning", message: "Le document a des titres mais aucun titre de niveau 1.", pos: -1 });
  return issues;
}

export function summarizeA11y(issues: A11yIssue[]): { errors: number; warnings: number } {
  return {
    errors: issues.filter((i) => i.severity === "error").length,
    warnings: issues.filter((i) => i.severity === "warning").length,
  };
}
