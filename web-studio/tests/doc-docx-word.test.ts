import { describe, it, expect } from "vitest";
import { unzipSync, zipSync, strFromU8, strToU8 } from "fflate";
import { docToDocx, docxToDoc } from "../src/format/docx";
import { createEliumFile } from "../src/format/document";
import type { EliumFile, PageSettings, ProseMirrorNode } from "../src/format/types";

const t = (text: string): ProseMirrorNode => ({ type: "text", text });
const para = (...content: ProseMirrorNode[]): ProseMirrorNode => ({ type: "paragraph", content });
const item = (text: string): ProseMirrorNode => ({ type: "listItem", content: [para(t(text))] });
const doc = (...content: ProseMirrorNode[]): ProseMirrorNode => ({ type: "doc", content });

async function fileWith(node: ProseMirrorNode, page?: Partial<PageSettings>): Promise<EliumFile> {
  const file = await createEliumFile({ title: "Doc Word", profile: "standard", doc: node });
  if (page) file.document.page = { ...file.document.page, ...page };
  return file;
}

const partOf = (bytes: Uint8Array, name: string): string => strFromU8(unzipSync(bytes)[name]!);

/** Find the first node of a type, anywhere in the tree. */
function find(node: ProseMirrorNode, type: string): ProseMirrorNode | undefined {
  if (node.type === type) return node;
  for (const c of node.content ?? []) {
    const hit = find(c, type);
    if (hit) return hit;
  }
  return undefined;
}
const flat = (node: ProseMirrorNode): string =>
  node.text ?? (node.content ?? []).map(flat).join("");

// =========================================================================
// Multilevel lists
// =========================================================================

describe("DOCX — listes multiniveaux", () => {
  const nested = doc({
    type: "orderedList",
    attrs: { listScheme: "outline" },
    content: [
      {
        type: "listItem",
        content: [
          para(t("premier")),
          { type: "orderedList", content: [item("premier-un"), item("premier-deux")] },
        ],
      },
      item("second"),
    ],
  });

  it("écrit un abstractNum réel pour le schéma employé", async () => {
    const xml = partOf(docToDocx(await fileWith(nested)), "word/numbering.xml");
    expect(xml).toContain('<w:lvlText w:val="%1.%2"/>');
    expect(xml).toContain('<w:multiLevelType w:val="multilevel"/>');
    expect(xml).toContain("<w:num ");
  });

  it("affecte le bon w:ilvl selon l'imbrication", async () => {
    const xml = partOf(docToDocx(await fileWith(nested)), "word/document.xml");
    expect(xml).toContain('<w:ilvl w:val="0"/>');
    expect(xml).toContain('<w:ilvl w:val="1"/>');
    // Un seul numId : la sous-liste hérite du schéma de la liste englobante.
    const numIds = [...xml.matchAll(/<w:numId w:val="(\d+)"\/>/g)].map((m) => m[1]);
    expect(new Set(numIds).size).toBe(1);
  });

  it("restitue l'imbrication et le schéma à la relecture", async () => {
    const back = docxToDoc(docToDocx(await fileWith(nested)));
    const outer = find(back.doc, "orderedList")!;
    expect(outer.attrs?.listScheme).toBe("outline");
    const firstItem = outer.content![0]!;
    const sub = firstItem.content!.find((n) => n.type === "orderedList");
    expect(sub).toBeDefined();
    expect(sub!.content).toHaveLength(2);
    expect(flat(sub!)).toBe("premier-unpremier-deux");
    // La sous-liste ne redéclare pas le schéma : elle l'hérite.
    expect(sub!.attrs?.listScheme).toBeFalsy();
  });

  it("donne un numId distinct à une sous-liste à puces dans une liste numérotée", async () => {
    const mixed = doc({
      type: "orderedList",
      attrs: { listScheme: "outline" },
      content: [
        { type: "listItem", content: [para(t("numéroté")), { type: "bulletList", content: [item("puce")] }] },
      ],
    });
    const xml = partOf(docToDocx(await fileWith(mixed)), "word/document.xml");
    const numIds = [...xml.matchAll(/<w:numId w:val="(\d+)"\/>/g)].map((m) => m[1]);
    expect(new Set(numIds).size).toBe(2);
    const back = docxToDoc(docToDocx(await fileWith(mixed)));
    expect(find(back.doc, "bulletList")).toBeDefined();
  });

  it("garde les listes sans schéma numérotées par niveau", async () => {
    const plain = doc({ type: "bulletList", content: [item("a"), item("b")] });
    const numbering = partOf(docToDocx(await fileWith(plain)), "word/numbering.xml");
    // Neuf niveaux définis, pas seulement le premier : une sous-liste ne retombe
    // pas sur le marqueur de niveau 0 dans Word.
    for (let i = 0; i < 9; i++) expect(numbering).toContain(`<w:lvl w:ilvl="${i}">`);
    const back = docxToDoc(docToDocx(await fileWith(plain)));
    expect(find(back.doc, "bulletList")).toBeDefined();
    expect(find(back.doc, "bulletList")!.content).toHaveLength(2);
  });

  it("reconnaît un schéma juridique produit par Word", async () => {
    const legal = doc({ type: "orderedList", attrs: { listScheme: "legal" }, content: [item("clause")] });
    const numbering = partOf(docToDocx(await fileWith(legal)), "word/numbering.xml");
    expect(numbering).toContain("<w:isLgl/>");
    const back = docxToDoc(docToDocx(await fileWith(legal)));
    expect(find(back.doc, "orderedList")!.attrs?.listScheme).toBe("legal");
  });
});

// =========================================================================
// Columns and section breaks
// =========================================================================

describe("DOCX — colonnes", () => {
  const columns = doc(
    para(t("avant")),
    {
      type: "columnSection",
      attrs: { count: 3, gapMm: 10, separator: true },
      content: [para(t("colonne un")), para(t("colonne deux"))],
    },
    para(t("après")),
  );

  it("écrit un w:cols continu autour de la plage", async () => {
    const xml = partOf(docToDocx(await fileWith(columns)), "word/document.xml");
    expect(xml).toContain('<w:cols w:num="1"/>');
    expect(xml).toMatch(/<w:cols w:num="3" w:space="\d+" w:sep="true"\/>/);
    expect((xml.match(/<w:type w:val="continuous"\/>/g) ?? [])).toHaveLength(2);
  });

  it("restitue le bloc de colonnes et son contenu", async () => {
    const back = docxToDoc(docToDocx(await fileWith(columns)));
    const cols = find(back.doc, "columnSection");
    expect(cols).toBeDefined();
    expect(cols!.attrs).toMatchObject({ count: 3, separator: true });
    expect(cols!.attrs!.gapMm).toBe(10);
    expect(flat(cols!)).toBe("colonne uncolonne deux");
    // Le texte hors colonnes reste hors du bloc.
    expect(flat(back.doc)).toContain("avant");
    expect(flat(back.doc)).toContain("après");
  });

  it("n'introduit aucun saut de section parasite autour des colonnes", async () => {
    const back = docxToDoc(docToDocx(await fileWith(columns)));
    expect(find(back.doc, "sectionBreak")).toBeUndefined();
  });

  it("borne le nombre de colonnes à 4", async () => {
    const tooMany = doc({ type: "columnSection", attrs: { count: 99 }, content: [para(t("x"))] });
    const xml = partOf(docToDocx(await fileWith(tooMany)), "word/document.xml");
    expect(xml).toContain('w:num="4"');
  });
});

describe("DOCX — sauts de section", () => {
  it("écrit le type de section et la reprise de numérotation", async () => {
    const withBreak = doc(
      para(t("section un")),
      { type: "sectionBreak", attrs: { kind: "oddPage", orientation: "landscape", restartNumbering: true, startAt: 1 } },
      para(t("section deux")),
    );
    const xml = partOf(docToDocx(await fileWith(withBreak)), "word/document.xml");
    expect(xml).toContain('<w:type w:val="oddPage"/>');
    expect(xml).toContain('w:orient="landscape"');
    expect(xml).toContain('<w:pgNumType w:start="1"/>');
  });

  it("restitue le saut, son type et l'orientation", async () => {
    const withBreak = doc(
      para(t("un")),
      { type: "sectionBreak", attrs: { kind: "nextPage", orientation: "landscape", restartNumbering: false, startAt: 1 } },
      para(t("deux")),
    );
    const back = docxToDoc(docToDocx(await fileWith(withBreak)));
    const brk = find(back.doc, "sectionBreak");
    expect(brk).toBeDefined();
    expect(brk!.attrs).toMatchObject({ kind: "nextPage", orientation: "landscape" });
    // L'ordre est conservé : texte, saut, texte.
    const types = (back.doc.content ?? []).map((n) => n.type);
    expect(types.indexOf("sectionBreak")).toBeGreaterThan(0);
    expect(types.lastIndexOf("paragraph")).toBeGreaterThan(types.indexOf("sectionBreak"));
  });

  it("n'invente pas de saut dans un document d'une seule section", async () => {
    const back = docxToDoc(docToDocx(await fileWith(doc(para(t("simple"))))));
    expect(find(back.doc, "sectionBreak")).toBeUndefined();
    expect(flat(back.doc)).toContain("simple");
  });

  it("garde le saut d'une section continue qui redémarre la numérotation", async () => {
    const withBreak = doc(
      para(t("un")),
      { type: "sectionBreak", attrs: { kind: "continuous", orientation: "", restartNumbering: true, startAt: 5 } },
      para(t("deux")),
    );
    const back = docxToDoc(docToDocx(await fileWith(withBreak)));
    const brk = find(back.doc, "sectionBreak");
    expect(brk!.attrs).toMatchObject({ kind: "continuous", restartNumbering: true, startAt: 5 });
  });
});

// =========================================================================
// Bookmarks and cross-references
// =========================================================================

describe("DOCX — signets et renvois", () => {
  it("écrit un signet nommé d'après son libellé", async () => {
    const withBookmark = doc(para(t("voir "), { type: "bookmark", attrs: { id: "bm-1", label: "Annexe II" } }));
    const xml = partOf(docToDocx(await fileWith(withBookmark)), "word/document.xml");
    expect(xml).toContain('w:name="Annexe_II"');
    expect(xml).toContain("<w:bookmarkStart");
    expect(xml).toContain("<w:bookmarkEnd");
  });

  it("écrit un renvoi comme champ REF, et une page comme PAGEREF", async () => {
    const withRefs = doc(
      { type: "heading", attrs: { level: 1, refId: "ref-h-1" }, content: [t("Conditions")] },
      para(
        { type: "crossReference", attrs: { targetId: "ref-h-1", kind: "heading", display: "text", cached: "Conditions" } },
        { type: "crossReference", attrs: { targetId: "ref-h-1", kind: "heading", display: "page", cached: "page 2" } },
      ),
    );
    const xml = partOf(docToDocx(await fileWith(withRefs)), "word/document.xml");
    expect(xml).toMatch(/w:instr=" REF \w+ \\h "/);
    expect(xml).toMatch(/w:instr=" PAGEREF \w+ \\h "/);
    // Le texte courant est mis en cache : le champ se lit avant toute mise à jour.
    expect(xml).toContain("Conditions");
  });

  it("pose l'ancre sur le titre visé et la réutilise pour le renvoi", async () => {
    const withRefs = doc(
      { type: "heading", attrs: { level: 1, refId: "ref-h-1" }, content: [t("Conditions")] },
      para({ type: "crossReference", attrs: { targetId: "ref-h-1", kind: "heading", display: "text", cached: "Conditions" } }),
    );
    const xml = partOf(docToDocx(await fileWith(withRefs)), "word/document.xml");
    const anchor = /<w:bookmarkStart w:id="\d+" w:name="([^"]+)"\/>/.exec(xml)?.[1];
    expect(anchor).toBeTruthy();
    expect(xml).toContain(` REF ${anchor} \\h `);
  });

  it("restitue le renvoi et son mode d'affichage", async () => {
    const withRefs = doc(
      { type: "heading", attrs: { level: 1, refId: "ref-h-1" }, content: [t("Conditions")] },
      para({ type: "crossReference", attrs: { targetId: "ref-h-1", kind: "heading", display: "page", cached: "page 2" } }),
    );
    const back = docxToDoc(docToDocx(await fileWith(withRefs)));
    const xref = find(back.doc, "crossReference");
    expect(xref).toBeDefined();
    expect(xref!.attrs!.display).toBe("page");
    expect(String(xref!.attrs!.targetId)).toBeTruthy();
  });

  it("importe les modes ci-dessus/ci-dessous et numéro depuis les commutateurs Word", async () => {
    const above = doc(
      { type: "heading", attrs: { level: 1, refId: "ref-h-1" }, content: [t("T")] },
      para({ type: "crossReference", attrs: { targetId: "ref-h-1", kind: "heading", display: "aboveBelow", cached: "ci-dessus" } }),
    );
    expect(find(docxToDoc(docToDocx(await fileWith(above))).doc, "crossReference")!.attrs!.display).toBe("aboveBelow");

    const numbered = doc(
      { type: "heading", attrs: { level: 1, refId: "ref-h-2" }, content: [t("T")] },
      para({ type: "crossReference", attrs: { targetId: "ref-h-2", kind: "heading", display: "number", cached: "1" } }),
    );
    expect(find(docxToDoc(docToDocx(await fileWith(numbered))).doc, "crossReference")!.attrs!.display).toBe("number");
  });

  it("ignore les signets internes de Word à l'import", async () => {
    // Elium nomme ses propres ancres avec un « _ » initial, comme Word.
    const withAnchor = doc({ type: "heading", attrs: { level: 1, refId: "ref-h-9" }, content: [t("Titre")] });
    const back = docxToDoc(docToDocx(await fileWith(withAnchor)));
    expect(find(back.doc, "bookmark")).toBeUndefined();
  });
});

// =========================================================================
// Index
// =========================================================================

describe("DOCX — index", () => {
  const withIndex = doc(
    para(t("Le chiffrement "), { type: "indexEntry", attrs: { term: "Chiffrement", sub: "AES" } }),
    para(t("Le sceau "), { type: "indexEntry", attrs: { term: "Sceau", sub: "" } }),
    { type: "indexBlock" },
  );

  it("écrit les marques comme champs XE", async () => {
    const xml = partOf(docToDocx(await fileWith(withIndex)), "word/document.xml");
    expect(xml).toContain("XE &quot;Chiffrement:AES&quot;");
    expect(xml).toContain("XE &quot;Sceau&quot;");
  });

  it("rend l'index en paragraphes bornés par un signet repère", async () => {
    const xml = partOf(docToDocx(await fileWith(withIndex)), "word/document.xml");
    expect(xml).toContain('w:name="_EliumIndex"');
    expect(xml).toContain("Index");
    expect(xml).toContain("Chiffrement");
  });

  it("restitue les marques et replie l'index en un seul nœud", async () => {
    const back = docxToDoc(docToDocx(await fileWith(withIndex)));
    const marks: ProseMirrorNode[] = [];
    const walk = (n: ProseMirrorNode) => {
      if (n.type === "indexEntry") marks.push(n);
      (n.content ?? []).forEach(walk);
    };
    walk(back.doc);
    expect(marks).toHaveLength(2);
    expect(marks[0]!.attrs).toMatchObject({ term: "Chiffrement", sub: "AES" });
    expect(marks[1]!.attrs).toMatchObject({ term: "Sceau", sub: "" });

    const blocks = (back.doc.content ?? []).filter((n) => n.type === "indexBlock");
    expect(blocks).toHaveLength(1);
    // Les paragraphes rendus de l'index ne reviennent pas en double.
    expect(flat(back.doc)).not.toContain("Index");
  });
});

// =========================================================================
// Mail merge
// =========================================================================

describe("DOCX — champs de fusion", () => {
  const withMerge = doc(para(t("Cher "), { type: "mergeField", attrs: { field: "Nom" } }, t(",")));

  it("écrit un vrai MERGEFIELD avec son aperçu en cache", async () => {
    const xml = partOf(docToDocx(await fileWith(withMerge)), "word/document.xml");
    expect(xml).toContain("MERGEFIELD Nom \\* MERGEFORMAT");
    expect(xml).toContain("«Nom»");
  });

  it("restitue le champ de fusion", async () => {
    const back = docxToDoc(docToDocx(await fileWith(withMerge)));
    const field = find(back.doc, "mergeField");
    expect(field).toBeDefined();
    expect(field!.attrs!.field).toBe("Nom");
    expect(flat(back.doc)).toContain("Cher ");
  });
});

// =========================================================================
// Regression: everything together
// =========================================================================

describe("DOCX — document Word complet", () => {
  it("survit à un aller-retour combinant toutes les nouveautés", async () => {
    const everything = doc(
      { type: "heading", attrs: { level: 1, refId: "ref-h-a" }, content: [t("Contrat")] },
      { type: "orderedList", attrs: { listScheme: "legal" }, content: [item("Objet"), item("Durée")] },
      para(
        t("voir "),
        { type: "crossReference", attrs: { targetId: "ref-h-a", kind: "heading", display: "text", cached: "Contrat" } },
        t(" — "),
        { type: "indexEntry", attrs: { term: "Contrat", sub: "" } },
        { type: "mergeField", attrs: { field: "Client" } },
      ),
      { type: "columnSection", attrs: { count: 2, gapMm: 8, separator: false }, content: [para(t("gauche")), para(t("droite"))] },
      { type: "sectionBreak", attrs: { kind: "nextPage", orientation: "", restartNumbering: false, startAt: 1 } },
      para(t("annexe")),
      { type: "indexBlock" },
    );
    const back = docxToDoc(docToDocx(await fileWith(everything)));
    expect(find(back.doc, "orderedList")!.attrs?.listScheme).toBe("legal");
    expect(find(back.doc, "crossReference")).toBeDefined();
    expect(find(back.doc, "indexEntry")!.attrs).toMatchObject({ term: "Contrat" });
    expect(find(back.doc, "mergeField")!.attrs!.field).toBe("Client");
    expect(find(back.doc, "columnSection")!.attrs).toMatchObject({ count: 2 });
    expect(find(back.doc, "sectionBreak")!.attrs).toMatchObject({ kind: "nextPage" });
    expect(find(back.doc, "indexBlock")).toBeDefined();
    expect(flat(back.doc)).toContain("annexe");
  });
});

// =========================================================================
// Fidélité d'import : couleur / police / taille portées par un STYLE.
//
// Le cas d'un vrai document Word : le formatage vit dans `styles.xml`, pas en
// `rPr` inline. C'était la régression « l'import ne relit pas toujours
// couleur/police/taille ». On construit ici un .docx à la main (pas via notre
// propre export, qui écrit tout en inline) pour verrouiller ce chemin.
// =========================================================================

describe("DOCX — relecture couleur/police/taille via styles.xml", () => {
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

  /** Assemble un .docx minimal depuis un corps de document et un styles.xml. */
  function makeDocx(bodyXml: string, stylesXml: string): Uint8Array {
    const document = `<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>${bodyXml}</w:body></w:document>`;
    const styles = `<?xml version="1.0" encoding="UTF-8"?><w:styles ${W}>${stylesXml}</w:styles>`;
    return zipSync({
      "word/document.xml": strToU8(document),
      "word/styles.xml": strToU8(styles),
    });
  }

  /** Premier nœud texte de l'arbre. */
  function firstText(node: ProseMirrorNode): ProseMirrorNode | undefined {
    if (node.type === "text") return node;
    for (const c of node.content ?? []) {
      const hit = firstText(c);
      if (hit) return hit;
    }
    return undefined;
  }
  const textStyle = (n: ProseMirrorNode): Record<string, unknown> =>
    n.marks?.find((m) => m.type === "textStyle")?.attrs ?? {};

  it("récupère couleur + police + taille posées sur le style de paragraphe (aucun rPr inline)", () => {
    const styles =
      `<w:style w:type="paragraph" w:styleId="Vif">` +
      `<w:rPr><w:color w:val="FF0000"/><w:rFonts w:ascii="Georgia" w:hAnsi="Georgia"/><w:sz w:val="48"/></w:rPr>` +
      `</w:style>`;
    const body = `<w:p><w:pPr><w:pStyle w:val="Vif"/></w:pPr><w:r><w:t>Coloré</w:t></w:r></w:p>`;
    const { doc } = docxToDoc(makeDocx(body, styles));
    const txt = firstText(doc)!;
    expect(txt.text).toBe("Coloré");
    const ts = textStyle(txt);
    expect(ts.color).toBe("#ff0000");
    expect(ts.fontFamily).toBe("Georgia");
    expect(ts.fontSize).toBe("32px"); // 48 demi-points ÷ 1.5
  });

  it("récupère la couleur posée sur un style de caractère (w:rStyle)", () => {
    const styles = `<w:style w:type="character" w:styleId="Accent"><w:rPr><w:color w:val="1D4ED8"/></w:rPr></w:style>`;
    const body = `<w:p><w:r><w:rPr><w:rStyle w:val="Accent"/></w:rPr><w:t>lien</w:t></w:r></w:p>`;
    const { doc } = docxToDoc(makeDocx(body, styles));
    expect(textStyle(firstText(doc)!).color).toBe("#1d4ed8");
  });

  it("le rPr inline l'emporte sur la couleur du style", () => {
    const styles = `<w:style w:type="paragraph" w:styleId="Vif"><w:rPr><w:color w:val="FF0000"/></w:rPr></w:style>`;
    const body =
      `<w:p><w:pPr><w:pStyle w:val="Vif"/></w:pPr>` +
      `<w:r><w:rPr><w:color w:val="00AA00"/></w:rPr><w:t>x</w:t></w:r></w:p>`;
    const { doc } = docxToDoc(makeDocx(body, styles));
    expect(textStyle(firstText(doc)!).color).toBe("#00aa00");
  });

  it("hérite de la taille via w:basedOn puis surcharge la couleur", () => {
    const styles =
      `<w:style w:type="paragraph" w:styleId="Base"><w:rPr><w:sz w:val="60"/></w:rPr></w:style>` +
      `<w:style w:type="paragraph" w:styleId="Derive"><w:basedOn w:val="Base"/><w:rPr><w:color w:val="333333"/></w:rPr></w:style>`;
    const body = `<w:p><w:pPr><w:pStyle w:val="Derive"/></w:pPr><w:r><w:t>y</w:t></w:r></w:p>`;
    const { doc } = docxToDoc(makeDocx(body, styles));
    const ts = textStyle(firstText(doc)!);
    expect(ts.fontSize).toBe("40px"); // 60 demi-points ÷ 1.5
    expect(ts.color).toBe("#333333");
  });

  it("applique les docDefaults quand aucun style ne le fait", () => {
    const styles =
      `<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Cambria" w:hAnsi="Cambria"/></w:rPr></w:rPrDefault></w:docDefaults>`;
    const body = `<w:p><w:r><w:t>défaut</w:t></w:r></w:p>`;
    const { doc } = docxToDoc(makeDocx(body, styles));
    expect(textStyle(firstText(doc)!).fontFamily).toBe("Cambria");
  });
});
