import { describe, it, expect } from "vitest";
import {
  NOTE_LABELS, NOTE_LIST_TYPE, NOTE_TITLES, collectNotesJson, convertNotes, hasNotesListJson,
  noteMarker, noteNumFmt, noteNumberAt, romanLower,
} from "../src/editor/notes";
import { strFromU8, unzipSync } from "fflate";
import { docToDocx } from "../src/format/docx";
import { createEliumFile } from "../src/format/document";
import { docToHtml, docToMarkdown, docToText } from "../src/export/exporters";
import type { ProseMirrorNode } from "../src/format/types";

const note = (kind: "footnote" | "endnote", text: string, id?: string): ProseMirrorNode => ({
  type: kind,
  attrs: { id: id ?? `${kind}-${text}`, text },
});
const para = (...content: ProseMirrorNode[]): ProseMirrorNode => ({ type: "paragraph", content });
const txt = (text: string): ProseMirrorNode => ({ type: "text", text });
const doc = (...content: ProseMirrorNode[]): ProseMirrorNode => ({ type: "doc", content });

describe("Notes — chiffres romains", () => {
  it("convertit les valeurs usuelles", () => {
    const cases: [number, string][] = [
      [1, "i"], [2, "ii"], [3, "iii"], [4, "iv"], [5, "v"], [9, "ix"], [10, "x"],
      [14, "xiv"], [40, "xl"], [49, "xlix"], [50, "l"], [90, "xc"], [100, "c"],
      [400, "cd"], [500, "d"], [900, "cm"], [1000, "m"], [1987, "mcmlxxxvii"],
    ];
    for (const [n, expected] of cases) expect(romanLower(n)).toBe(expected);
  });

  it("ne rend rien hors de la plage représentable", () => {
    expect(romanLower(0)).toBe("");
    expect(romanLower(-3)).toBe("");
    expect(romanLower(NaN)).toBe("");
    expect(romanLower(Infinity)).toBe("");
  });

  it("tronque une valeur décimale", () => {
    expect(romanLower(3.9)).toBe("iii");
  });
});

describe("Notes — marqueurs", () => {
  it("arabe pour les notes de bas de page, romain minuscule pour les notes de fin", () => {
    expect(noteMarker("footnote", 3)).toBe("3");
    expect(noteMarker("endnote", 3)).toBe("iii");
    expect(noteMarker("endnote", 1)).toBe("i");
  });

  it("retombe sur le nombre si le romain est impossible", () => {
    // Un rang 0 ne devrait pas arriver, mais afficher « 0 » vaut mieux que rien.
    expect(noteMarker("endnote", 0)).toBe("0");
  });

  it("expose le format OOXML correspondant", () => {
    expect(noteNumFmt("footnote")).toBe("decimal");
    expect(noteNumFmt("endnote")).toBe("lowerRoman");
  });

  it("nomme les listes et les titres des deux familles", () => {
    expect(NOTE_LIST_TYPE.footnote).toBe("footnotesList");
    expect(NOTE_LIST_TYPE.endnote).toBe("endnotesList");
    expect(NOTE_TITLES.endnote).toBe("Notes de fin");
    expect(NOTE_LABELS.endnote).toBe("Note de fin");
  });
});

describe("Notes — collecte et numérotation", () => {
  it("numérote chaque famille séparément, dans l'ordre du document", () => {
    const d = doc(
      para(txt("a"), note("footnote", "F1"), note("endnote", "E1")),
      para(txt("b"), note("footnote", "F2"), note("endnote", "E2")),
    );
    expect(collectNotesJson(d, "footnote").map((n) => `${n.number}:${n.text}`)).toEqual(["1:F1", "2:F2"]);
    expect(collectNotesJson(d, "endnote").map((n) => `${n.marker}:${n.text}`)).toEqual(["i:E1", "ii:E2"]);
  });

  it("renumérote quand une note est insérée en amont", () => {
    const before = collectNotesJson(doc(para(note("endnote", "A")), para(note("endnote", "B"))), "endnote");
    expect(before.map((n) => n.marker)).toEqual(["i", "ii"]);
    const after = collectNotesJson(
      doc(para(note("endnote", "Z")), para(note("endnote", "A")), para(note("endnote", "B"))),
      "endnote",
    );
    expect(after.map((n) => `${n.marker}:${n.text}`)).toEqual(["i:Z", "ii:A", "iii:B"]);
  });

  it("trouve les notes imbriquées dans un conteneur", () => {
    const nested = doc({
      type: "columnSection",
      attrs: { count: 2 },
      content: [para(note("endnote", "dedans"))],
    });
    expect(collectNotesJson(nested, "endnote").map((n) => n.text)).toEqual(["dedans"]);
  });

  it("ignore l'autre famille", () => {
    const d = doc(para(note("footnote", "F")));
    expect(collectNotesJson(d, "endnote")).toEqual([]);
  });

  it("retrouve une note par position", () => {
    const entries = collectNotesJson(doc(para(note("endnote", "A"))), "endnote");
    // En JSON pur la position est inconnue (-1) : la recherche par position le reflète.
    expect(noteNumberAt(entries, -1)?.text).toBe("A");
    expect(noteNumberAt(entries, 42)).toBeNull();
  });

  it("détecte la présence de la liste de chaque famille", () => {
    const withEnd = doc(para(note("endnote", "A")), { type: "endnotesList" });
    expect(hasNotesListJson(withEnd, "endnote")).toBe(true);
    expect(hasNotesListJson(withEnd, "footnote")).toBe(false);
  });
});

describe("Notes — conversion entre familles", () => {
  it("convertit les notes de bas de page en notes de fin", () => {
    const d = doc(para(txt("a"), note("footnote", "F1")), { type: "footnotesList" });
    const out = convertNotes(d, "footnote", "endnote");
    expect(collectNotesJson(out, "endnote").map((n) => n.text)).toEqual(["F1"]);
    expect(collectNotesJson(out, "footnote")).toEqual([]);
  });

  it("ajoute la liste de destination et retire celle qui n'a plus rien à lister", () => {
    const d = doc(para(note("footnote", "F1")), { type: "footnotesList" });
    const out = convertNotes(d, "footnote", "endnote");
    const types = (out.content ?? []).map((c) => (c as ProseMirrorNode).type);
    expect(types).toContain("endnotesList");
    expect(types).not.toContain("footnotesList");
  });

  it("ne duplique pas une liste de destination déjà présente", () => {
    const d = doc(para(note("footnote", "F")), { type: "endnotesList" });
    const out = convertNotes(d, "footnote", "endnote");
    const lists = (out.content ?? []).filter((c) => (c as ProseMirrorNode).type === "endnotesList");
    expect(lists).toHaveLength(1);
  });

  it("préserve le texte, l'identifiant et le reste du contenu", () => {
    const d = doc(para(txt("avant"), note("footnote", "Texte", "fixe"), txt("après")));
    const out = convertNotes(d, "footnote", "endnote");
    const [e] = collectNotesJson(out, "endnote");
    expect(e!.text).toBe("Texte");
    expect(e!.id).toBe("fixe");
    const p = (out.content ?? [])[0] as ProseMirrorNode;
    expect((p.content ?? []).map((c) => (c as ProseMirrorNode).text ?? "*")).toEqual(["avant", "*", "après"]);
  });

  it("convertit aussi dans l'autre sens", () => {
    const d = doc(para(note("endnote", "E")), { type: "endnotesList" });
    const out = convertNotes(d, "endnote", "footnote");
    expect(collectNotesJson(out, "footnote").map((n) => n.text)).toEqual(["E"]);
  });

  it("ne touche à rien sans note à convertir", () => {
    const d = doc(para(txt("rien")));
    expect(convertNotes(d, "footnote", "endnote")).toBe(d);
  });

  it("une conversion vers la même famille est l'identité", () => {
    const d = doc(para(note("footnote", "F")));
    expect(convertNotes(d, "footnote", "footnote")).toBe(d);
  });

  it("convertit les notes imbriquées", () => {
    const d = doc({
      type: "columnSection",
      attrs: { count: 2 },
      content: [para(note("footnote", "dedans"))],
    });
    const out = convertNotes(d, "footnote", "endnote");
    expect(collectNotesJson(out, "endnote").map((n) => n.text)).toEqual(["dedans"]);
  });
});

describe("Notes — export DOCX en vraies notes Word", () => {
  const model = (node: ProseMirrorNode) => ({
    schema: "elium-doc/1" as const,
    page: {
      format: "A4" as const, orientation: "portrait" as const,
      margins: { top: 25, right: 20, bottom: 25, left: 20 },
    },
    doc: node,
  });

  async function zipOf(node: ProseMirrorNode) {
    const file = await createEliumFile({ title: "Doc notes", profile: "standard", doc: node });
    return unzipSync(docToDocx(file));
  }
  const part = (zip: Record<string, Uint8Array>, name: string) =>
    zip[name] ? strFromU8(zip[name]!) : null;

  it("écrit une partie footnotes.xml avec les séparateurs réservés", async () => {
    const zip = await zipOf(doc(para(txt("a"), note("footnote", "Ma note"))));
    const xml = part(zip, "word/footnotes.xml");
    expect(xml).toBeTruthy();
    // Word exige les deux notes réservées dès que la partie existe.
    expect(xml).toContain('w:type="separator" w:id="-1"');
    expect(xml).toContain('w:type="continuationSeparator" w:id="0"');
    // Les notes réelles commencent donc à 1.
    expect(xml).toContain('<w:footnote w:id="2">');
    expect(xml).toContain("Ma note");
    expect(xml).toContain("<w:footnoteRef/>");
  });

  it("écrit une partie endnotes.xml distincte", async () => {
    const zip = await zipOf(doc(para(txt("a"), note("endnote", "Ma finale"))));
    const xml = part(zip, "word/endnotes.xml");
    expect(xml).toContain('<w:endnote w:id="2">');
    expect(xml).toContain("Ma finale");
    expect(xml).toContain("<w:endnoteRef/>");
    expect(part(zip, "word/footnotes.xml")).toBeNull();
  });

  it("pose de vrais appels de note dans le flux, pas un « [1] » en exposant", async () => {
    const zip = await zipOf(doc(para(txt("a"), note("footnote", "F"), note("endnote", "E"))));
    const body = part(zip, "word/document.xml")!;
    expect(body).toContain('<w:footnoteReference w:id="2"/>');
    expect(body).toContain('<w:endnoteReference w:id="2"/>');
    expect(body).not.toContain("[1]");
    // Et plus de section « Notes » fabriquée dans le corps.
    expect(body).not.toMatch(/<w:t[^>]*>Notes<\/w:t>/);
  });

  it("déclare les types de contenu et les relations des parties présentes", async () => {
    const zip = await zipOf(doc(para(note("endnote", "E"))));
    expect(part(zip, "[Content_Types].xml")).toContain("endnotes+xml");
    expect(part(zip, "[Content_Types].xml")).not.toContain("footnotes+xml");
    const rels = part(zip, "word/_rels/document.xml.rels")!;
    expect(rels).toContain('Target="endnotes.xml"');
    expect(rels).toContain("relationships/endnotes");
  });

  it("déclare le format de numérotation dans sectPr", async () => {
    const zip = await zipOf(doc(para(note("footnote", "F"), note("endnote", "E"))));
    const body = part(zip, "word/document.xml")!;
    expect(body).toContain('<w:endnotePr><w:pos w:val="docEnd"/><w:numFmt w:val="lowerRoman"/></w:endnotePr>');
    expect(body).toContain('<w:footnotePr><w:numFmt w:val="decimal"/></w:footnotePr>');
  });

  it("porte les styles de note dans styles.xml", async () => {
    const zip = await zipOf(doc(para(note("endnote", "E"))));
    const styles = part(zip, "word/styles.xml")!;
    expect(styles).toContain('w:styleId="EndnoteText"');
    expect(styles).toContain('w:styleId="EndnoteReference"');
    expect(styles).toContain('w:val="endnote text"');
  });

  it("numérote plusieurs notes dans l'ordre du document", async () => {
    const zip = await zipOf(doc(
      para(note("endnote", "un", "e1")),
      para(note("endnote", "deux", "e2")),
      para(note("endnote", "trois", "e3")),
    ));
    const xml = part(zip, "word/endnotes.xml")!;
    expect(xml.indexOf("un")).toBeLessThan(xml.indexOf("deux"));
    expect(xml).toContain('<w:endnote w:id="4">');
    const body = part(zip, "word/document.xml")!;
    expect(body).toContain('<w:endnoteReference w:id="4"/>');
  });

  it("n'écrit aucune partie de notes sans note", async () => {
    const zip = await zipOf(doc(para(txt("rien"))));
    expect(part(zip, "word/footnotes.xml")).toBeNull();
    expect(part(zip, "word/endnotes.xml")).toBeNull();
    expect(part(zip, "[Content_Types].xml")).not.toContain("endnotes+xml");
  });

  it("échappe le texte de la note", async () => {
    const zip = await zipOf(doc(para(note("endnote", 'Fin & <suite> "citée"'))));
    const xml = part(zip, "word/endnotes.xml")!;
    expect(xml).toContain("Fin &amp; &lt;suite&gt;");
    expect(xml).not.toContain("<suite>");
  });
});

describe("Notes — exports HTML, Markdown et texte", () => {
  const model = (node: ProseMirrorNode) => ({
    schema: "elium-doc/1" as const,
    page: {
      format: "A4" as const, orientation: "portrait" as const,
      margins: { top: 25, right: 20, bottom: 25, left: 20 },
    },
    doc: node,
  });

  const withBoth = doc(
    para(txt("a"), note("footnote", "Bas de page", "f1"), note("endnote", "En fin", "e1")),
    { type: "footnotesList" },
    { type: "endnotesList" },
  );

  it("rend les deux familles en HTML avec leurs propres marqueurs", () => {
    const html = docToHtml(model(withBoth));
    expect(html).toContain('class="elium-fn-ref"');
    expect(html).toContain('class="elium-en-ref"');
    // Arabe pour les notes de bas de page, romain minuscule pour les notes de fin.
    expect(html).toContain('href="#fn-1">1</a>');
    expect(html).toContain('href="#en-1">i</a>');
    expect(html).toContain("Notes de bas de page");
    expect(html).toContain("Notes de fin");
  });

  it("relie l'appel et la note dans les deux sens", () => {
    const html = docToHtml(model(withBoth));
    expect(html).toContain('id="fnref-1"');
    expect(html).toContain('id="fn-1"');
    expect(html).toContain('href="#enref-1"');
  });

  it("ne rend pas une liste vide", () => {
    const html = docToHtml(model(doc(para(txt("rien")), { type: "endnotesList" })));
    expect(html).not.toContain("Notes de fin");
  });

  it("sépare les deux familles en Markdown", () => {
    const md = docToMarkdown(model(withBoth));
    expect(md).toContain("[^1]");
    // Les notes de fin sont préfixées : sans cela `[^1]` et `[^i]` cohabiteraient mal.
    expect(md).toContain("[^en-i]");
    expect(md).toContain("[^1]: Bas de page");
    expect(md).toContain("[^en-i]: En fin");
  });

  it("rend les deux familles en texte brut", () => {
    const txtOut = docToText(model(withBoth));
    expect(txtOut).toContain("[1]");
    expect(txtOut).toContain("[i]");
    expect(txtOut).toContain("Notes de fin");
    expect(txtOut).toContain("[i] En fin");
  });

  it("échappe le texte de la note en HTML", () => {
    const html = docToHtml(model(doc(para(note("endnote", '<script>x</script>')), { type: "endnotesList" })));
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
