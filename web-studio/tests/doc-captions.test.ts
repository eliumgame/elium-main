import { describe, it, expect } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import { Schema, type Node as PMNode } from "prosemirror-model";
import {
  CAPTION_LABELS, buildFigureTable, captionInsertPos, captionLabels, captionNumberAt, captionPrefix,
  collectCaptionsJson, figureTableInstr, figureTableTitle, seqInstr,
} from "../src/editor/captions";
import { collectTargetsJson } from "../src/editor/crossref";
import { docToDocx } from "../src/format/docx";
import { createEliumFile } from "../src/format/document";
import { docToHtml, docToMarkdown, docToText } from "../src/export/exporters";
import type { EliumFile, ProseMirrorNode } from "../src/format/types";

const caption = (label: string, text: string, attrs: Record<string, unknown> = {}): ProseMirrorNode => ({
  type: "caption",
  attrs: { label, position: "below", ...attrs },
  content: text ? [{ type: "text", text }] : [],
});
const para = (text: string): ProseMirrorNode => ({ type: "paragraph", content: [{ type: "text", text }] });
const doc = (...content: ProseMirrorNode[]): ProseMirrorNode => ({ type: "doc", content });

const model = (node: ProseMirrorNode) => ({
  schema: "elium-doc/1" as const,
  page: { format: "A4" as const, orientation: "portrait" as const, margins: { top: 25, right: 20, bottom: 25, left: 20 } },
  doc: node,
});

async function fileWith(node: ProseMirrorNode): Promise<EliumFile> {
  return createEliumFile({ title: "Doc légendes", profile: "standard", doc: node });
}
const documentXml = (file: EliumFile) => strFromU8(unzipSync(docToDocx(file))["word/document.xml"]!);

describe("Légendes — numérotation dérivée", () => {
  it("numérote par étiquette, dans l'ordre du document", () => {
    const entries = collectCaptionsJson(
      doc(caption("Figure", "A"), caption("Tableau", "T1"), caption("Figure", "B"), caption("Tableau", "T2")),
    );
    expect(entries.map((e) => `${e.label} ${e.number}`)).toEqual(["Figure 1", "Tableau 1", "Figure 2", "Tableau 2"]);
  });

  it("renumérote quand une légende est insérée avant", () => {
    const before = collectCaptionsJson(doc(caption("Figure", "A"), caption("Figure", "B")));
    expect(before.map((e) => e.number)).toEqual([1, 2]);
    const after = collectCaptionsJson(doc(caption("Figure", "Z"), caption("Figure", "A"), caption("Figure", "B")));
    expect(after.map((e) => `${e.number}:${e.text}`)).toEqual(["1:Z", "2:A", "3:B"]);
  });

  it("normalise l'étiquette et retombe sur Figure", () => {
    const entries = collectCaptionsJson(doc(caption("  Figure  ", "A"), caption("", "B")));
    expect(entries.map((e) => e.label)).toEqual(["Figure", "Figure"]);
    expect(entries.map((e) => e.number)).toEqual([1, 2]);
  });

  it("trouve les légendes imbriquées (dans un bloc de colonnes)", () => {
    const nested = doc({ type: "columnSection", attrs: { count: 2 }, content: [caption("Figure", "dedans")] });
    expect(collectCaptionsJson(nested).map((e) => e.text)).toEqual(["dedans"]);
  });

  it("expose les étiquettes utilisées dans l'ordre de première apparition", () => {
    const entries = collectCaptionsJson(doc(caption("Tableau", "T"), caption("Figure", "F"), caption("Tableau", "T2")));
    expect(captionLabels(entries)).toEqual(["Tableau", "Figure"]);
    expect(CAPTION_LABELS).toContain("Figure");
  });

  it("compose le préfixe affiché", () => {
    expect(captionPrefix("Figure", 3)).toBe("Figure 3 — ");
    expect(captionPrefix("Tableau", 1, " : ")).toBe("Tableau 1 : ");
  });

  it("retrouve une légende par position", () => {
    const entries = collectCaptionsJson(doc(caption("Figure", "A")));
    expect(captionNumberAt(entries, -1)?.text).toBe("A");
    expect(captionNumberAt(entries, 999)).toBeNull();
  });
});

describe("Légendes — table des illustrations", () => {
  const entries = collectCaptionsJson(
    doc(caption("Figure", "Une"), caption("Tableau", "Deux"), caption("Figure", "Trois")),
  );

  it("filtre par étiquette", () => {
    expect(buildFigureTable(entries, "Figure", null).map((r) => r.text)).toEqual(["Une", "Trois"]);
    expect(buildFigureTable(entries, "Tableau", null).map((r) => r.text)).toEqual(["Deux"]);
  });

  it("liste toutes les légendes sans étiquette", () => {
    expect(buildFigureTable(entries, null, null)).toHaveLength(3);
    expect(buildFigureTable(entries, "", null)).toHaveLength(3);
  });

  it("joint les numéros de page quand un résolveur en fournit", () => {
    const live = [{ ...entries[0]!, pos: 10 }];
    expect(buildFigureTable(live, "Figure", (p) => p * 2)[0]!.page).toBe(20);
    expect(buildFigureTable(live, "Figure", null)[0]!.page).toBeNull();
  });

  it("laisse la page nulle quand la position est inconnue", () => {
    expect(buildFigureTable(entries, "Figure", (p) => p)[0]!.page).toBeNull();
  });
});

describe("Légendes — champs Word", () => {
  it("compose une instruction SEQ sans espace dans l'identifiant", () => {
    expect(seqInstr("Figure")).toBe(" SEQ Figure \\* ARABIC ");
    expect(seqInstr("Mon Schéma")).toBe(" SEQ MonSchéma \\* ARABIC ");
  });

  it("compose l'instruction TOC de la table des illustrations", () => {
    expect(figureTableInstr("Figure")).toContain('\\c "Figure"');
    expect(figureTableInstr(null)).toContain("\\c ");
  });
});

describe("Légendes — renvois", () => {
  it("expose les légendes comme cibles de renvoi, avec leur numéro", () => {
    const targets = collectTargetsJson(doc(caption("Figure", "Le graphique"), caption("Figure", "L'autre")));
    const captions = targets.filter((t) => t.kind === "caption");
    expect(captions.map((t) => t.number)).toEqual(["Figure 1", "Figure 2"]);
    expect(captions[0]!.label).toContain("Le graphique");
  });

  it("numérote les légendes de renvoi par étiquette comme le document", () => {
    const targets = collectTargetsJson(doc(caption("Tableau", "T"), caption("Figure", "F"), caption("Tableau", "T2")));
    expect(targets.filter((t) => t.kind === "caption").map((t) => t.number)).toEqual([
      "Tableau 1", "Figure 1", "Tableau 2",
    ]);
  });
});

describe("Légendes — export", () => {
  it("rend le préfixe calculé en HTML", () => {
    const html = docToHtml(model(doc(caption("Figure", "Le graphique"), caption("Figure", "L'autre"))));
    expect(html).toContain("Figure 1 — ");
    expect(html).toContain("Figure 2 — ");
    expect(html).toContain('class="elium-caption"');
  });

  it("rend la table des illustrations en HTML", () => {
    const html = docToHtml(model(doc(caption("Figure", "Une"), { type: "tableOfFigures", attrs: { label: "Figure" } })));
    expect(html).toContain("Table des figures");
    expect(html).toContain("Figure 1 — Une");
  });

  it("rend les légendes en Markdown et en texte", () => {
    const md = docToMarkdown(model(doc(caption("Figure", "Une"))));
    expect(md).toContain("*Figure 1 — Une*");
    const txt = docToText(model(doc(caption("Tableau", "Deux"))));
    expect(txt).toContain("Tableau 1 — Deux");
  });

  it("écrit un champ SEQ réel en DOCX", async () => {
    const xml = documentXml(await fileWith(doc(para("texte"), caption("Figure", "Le graphique"))));
    expect(xml).toContain("SEQ Figure \\* ARABIC");
    // Le numéro courant sert de résultat en cache, donc lisible avant mise à jour.
    expect(xml).toContain("<w:t xml:space=\"preserve\">Figure </w:t>");
    expect(xml).toContain('<w:pStyle w:val="Legende"/>');
  });

  it("écrit la table des illustrations en champ TOC \\c", async () => {
    const xml = documentXml(
      await fileWith(doc(caption("Figure", "Une"), { type: "tableOfFigures", attrs: { label: "Figure" } })),
    );
    expect(xml).toContain('TOC \\h \\z \\c &quot;Figure&quot;');
    expect(xml).toContain("Table des figures");
    expect(xml).toContain("Figure 1 — Une");
  });

  it("n'écrit aucun champ quand il n'y a pas de légende", async () => {
    const xml = documentXml(await fileWith(doc(para("rien"))));
    expect(xml).not.toContain("SEQ ");
  });
});

describe("Légendes — placement de l'insertion", () => {
  // A minimal schema mirroring the real one where it matters: a caption takes
  // inline content only, and a columnSection nests blocks.
  const schema = new Schema({
    nodes: {
      doc: { content: "block+" },
      paragraph: { group: "block", content: "inline*" },
      caption: { group: "block", content: "inline*" },
      figtable: { group: "block", atom: true },
      columnSection: { group: "block", content: "block+" },
      text: { group: "inline" },
    },
  });
  const { caption: capT, paragraph, columnSection, figtable } = schema.nodes;
  const at = (node: PMNode, pos: number) => node.resolve(pos);

  it("insère après le bloc courant quand la position est « below »", () => {
    const d = schema.node("doc", null, [paragraph.create(null, schema.text("un")), paragraph.create(null, schema.text("deux"))]);
    // Cursor inside the first paragraph.
    expect(captionInsertPos(at(d, 2), capT, true)).toBe(d.child(0).nodeSize);
  });

  it("insère avant le bloc courant quand la position est « above »", () => {
    const d = schema.node("doc", null, [paragraph.create(null, schema.text("un"))]);
    expect(captionInsertPos(at(d, 2), capT, false)).toBe(0);
  });

  it("sort d'une légende au lieu d'imbriquer — le bug qui perdait la commande", () => {
    const d = schema.node("doc", null, [capT.create(null, schema.text("déjà"))]);
    // Cursor inside the existing caption: a caption cannot hold a block, so the
    // insertion has to land beside it.
    expect(captionInsertPos(at(d, 2), capT, true)).toBe(d.child(0).nodeSize);
    expect(captionInsertPos(at(d, 2), capT, false)).toBe(0);
  });

  it("reste dans le bloc de colonnes qui accepte les légendes", () => {
    const inner = paragraph.create(null, schema.text("dedans"));
    const d = schema.node("doc", null, [columnSection.create(null, [inner])]);
    // Depth: doc > columnSection > paragraph. The columnSection accepts blocks,
    // so the caption belongs inside it, right after the paragraph.
    expect(captionInsertPos(at(d, 3), capT, true)).toBe(1 + inner.nodeSize);
  });

  it("place aussi la table des illustrations", () => {
    const d = schema.node("doc", null, [capT.create(null, schema.text("x"))]);
    expect(captionInsertPos(at(d, 2), figtable, true)).toBe(d.child(0).nodeSize);
  });
});

describe("Légendes — pluriel français du titre", () => {
  it("pluralise correctement les étiquettes courantes", () => {
    expect(figureTableTitle("Figure")).toBe("Table des figures");
    expect(figureTableTitle("Tableau")).toBe("Table des tableaux");
    expect(figureTableTitle("Équation")).toBe("Table des équations");
  });

  it("laisse invariables les mots déjà en s/x/z", () => {
    expect(figureTableTitle("Croquis")).toBe("Table des croquis");
    expect(figureTableTitle("Annexe")).toBe("Table des annexes");
  });

  it("traite -al en -aux", () => {
    expect(figureTableTitle("Journal")).toBe("Table des journaux");
  });

  it("retombe sur le titre générique sans étiquette", () => {
    expect(figureTableTitle(null)).toBe("Table des illustrations");
    expect(figureTableTitle("")).toBe("Table des illustrations");
    expect(figureTableTitle("   ")).toBe("Table des illustrations");
  });
});
