/**
 * Balisage d'accessibilité (bases de PDF/UA) : donne une structure logique à un
 * PDF qui n'en a pas.
 *
 *  - chaque objet texte (BT…ET) devient un élément `P`, chaque image un `Figure`
 *    (avec son texte de remplacement), dans l'ORDRE DU FLUX DE CONTENU, qui est
 *    le plus souvent l'ordre de lecture mais n'est pas garanti : l'ordre de
 *    lecture reste « à vérifier manuellement », comme dans Acrobat ;
 *  - arbre de structure (`StructTreeRoot` › `Document` › éléments), `ParentTree`,
 *    `MarkInfo`, langue, titre affiché dans la barre de titre ;
 *  - un document déjà balisé n'est jamais re-balisé (seuls langue, titre et
 *    textes de remplacement sont mis à jour).
 *
 * Limites assumées : pas de détection de titres, listes ni tableaux (tout est
 * `P`) ; le contenu graphique non textuel n'est pas marqué comme artefact ;
 * les formulaires et annotations ne sont pas rattachés à l'arbre ; le texte
 * contenu dans des XObjects de type formulaire n'est pas balisé.
 */
import {
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFString,
  type PDFDocument,
  type PDFObject,
} from "pdf-lib";
import { parseContentStream, type Op } from "../core/contentstream";
import { isImageXObject, readPageContentBytes, writePageContent } from "./content";

const N = (s: string) => PDFName.of(s);

export interface FigureRef {
  /** 0-based page. */
  page: number;
  /** Position of the figure on the page, in content order. */
  index: number;
  alt: string;
}

export interface TaggingOptions {
  /** BCP 47 : « fr-FR ». */
  lang: string;
  title?: string;
  /** Texte de remplacement par `page:index` (voir `listFigures`). */
  alts?: ReadonlyMap<string, string>;
}

export interface TaggingReport {
  tagged: boolean;
  alreadyTagged: boolean;
  pages: number;
  paragraphs: number;
  figures: number;
  figuresWithoutAlt: number;
  notes: string[];
}

export const figureKey = (page: number, index: number) => `${page}:${index}`;

export function isTagged(doc: PDFDocument): boolean {
  return doc.catalog.lookup(N("StructTreeRoot")) instanceof PDFDict;
}

/** Les éléments à baliser d'une page : objets texte et images, dans l'ordre du flux. */
function wrap(
  doc: PDFDocument,
  pageIndex: number,
  ops: readonly Op[],
): { ops: Op[]; items: { role: "P" | "Figure"; figure?: number }[] } {
  const page = doc.getPage(pageIndex);
  const out: Op[] = [];
  const items: { role: "P" | "Figure"; figure?: number }[] = [];
  let markedDepth = 0;
  let inText = false;
  let figures = 0;
  const open = (role: "P" | "Figure") => {
    out.push({
      op: "BDC",
      args: [
        { t: "name", v: role },
        { t: "dict", v: new Map([["MCID", { t: "num", v: items.length }]]) },
      ],
    });
  };
  for (const op of ops) {
    if (op.op === "BDC" || op.op === "BMC") markedDepth++;
    if (op.op === "EMC") markedDepth = Math.max(0, markedDepth - 1);
    if (markedDepth === 0 && op.op === "BT" && !inText) {
      inText = true;
      open("P");
      items.push({ role: "P" });
      out.push(op);
      continue;
    }
    if (inText && op.op === "ET") {
      inText = false;
      out.push(op, { op: "EMC", args: [] });
      continue;
    }
    const nameArg = op.args[0];
    const isImage =
      markedDepth === 0 &&
      !inText &&
      ((op.op === "Do" && nameArg?.t === "name" && isImageXObject(page, nameArg.v)) || op.op === "BI");
    if (isImage) {
      open("Figure");
      items.push({ role: "Figure", figure: figures++ });
      out.push(op, { op: "EMC", args: [] });
      continue;
    }
    out.push(op);
  }
  return { ops: out, items };
}

export function tagDocument(doc: PDFDocument, opts: TaggingOptions): TaggingReport {
  const report: TaggingReport = {
    tagged: false,
    alreadyTagged: isTagged(doc),
    pages: 0,
    paragraphs: 0,
    figures: 0,
    figuresWithoutAlt: 0,
    notes: [],
  };
  const ctx = doc.context;
  const cat = doc.catalog;

  // Langue et titre : valables balisé ou non.
  cat.set(N("Lang"), PDFString.of(opts.lang));
  if (opts.title?.trim()) {
    doc.setTitle(opts.title.trim());
    const prefs = cat.lookup(N("ViewerPreferences"));
    if (prefs instanceof PDFDict) prefs.set(N("DisplayDocTitle"), ctx.obj(true));
    else cat.set(N("ViewerPreferences"), ctx.obj({ DisplayDocTitle: true }));
  }

  if (report.alreadyTagged) {
    report.notes.push("Le document est déjà balisé : sa structure n'a pas été modifiée (langue et titre mis à jour).");
    return report;
  }

  const pages = doc.getPages();
  const rootRef = ctx.nextRef();
  const docRef = ctx.nextRef();
  const docKids: PDFRef[] = [];
  const nums: PDFObject[] = [];

  pages.forEach((page, pageIndex) => {
    let ops: Op[];
    try {
      ops = parseContentStream(readPageContentBytes(page));
    } catch {
      report.notes.push(`Page ${pageIndex + 1} : contenu illisible, non balisée.`);
      return;
    }
    const wrapped = wrap(doc, pageIndex, ops);
    if (!wrapped.items.length) return;
    writePageContent(doc, page, wrapped.ops);
    const refs = wrapped.items.map((it) => {
      const dict: Record<string, PDFObject> = {
        Type: N("StructElem"),
        S: N(it.role),
        P: docRef,
        Pg: page.ref,
        K: PDFNumber.of(refs_mcid(wrapped.items, it)),
      };
      if (it.role === "Figure") {
        report.figures++;
        const alt = opts.alts?.get(figureKey(pageIndex, it.figure ?? 0))?.trim();
        if (alt) dict.Alt = PDFHexString.fromText(alt);
        else report.figuresWithoutAlt++;
      } else report.paragraphs++;
      return ctx.register(ctx.obj(dict as never));
    });
    docKids.push(...refs);
    page.node.set(N("StructParents"), PDFNumber.of(pageIndex));
    nums.push(PDFNumber.of(pageIndex), ctx.obj(refs as never));
    if (page.node.lookup(N("Annots")) instanceof PDFArray) page.node.set(N("Tabs"), N("S"));
    report.pages++;
  });

  if (!report.pages) {
    report.notes.push("Aucun contenu à baliser (document sans texte ni image : lancez l'OCR d'abord).");
    return report;
  }

  ctx.assign(docRef, ctx.obj({ Type: N("StructElem"), S: N("Document"), P: rootRef, K: docKids } as never));
  ctx.assign(
    rootRef,
    ctx.obj({
      Type: N("StructTreeRoot"),
      K: [docRef],
      ParentTree: ctx.obj({ Nums: nums } as never),
      ParentTreeNextKey: PDFNumber.of(pages.length),
    } as never),
  );
  cat.set(N("StructTreeRoot"), rootRef);
  cat.set(N("MarkInfo"), ctx.obj({ Marked: true }));
  report.tagged = true;
  if (report.figuresWithoutAlt)
    report.notes.push(`${report.figuresWithoutAlt} figure(s) sans texte de remplacement : renseignez-les.`);
  report.notes.push(
    "Ordre de lecture = ordre du flux de contenu (à vérifier) ; titres, listes et tableaux ne sont pas détectés (tout est « paragraphe »).",
  );
  return report;
}

/** Index du MCID d'un élément = sa position dans la liste de la page. */
function refs_mcid(items: readonly unknown[], it: unknown): number {
  return items.indexOf(it);
}

// ---- Textes de remplacement d'un document déjà balisé -------------------------

interface FigureElem {
  dict: PDFDict;
  page: number;
}

function figureElems(doc: PDFDocument): FigureElem[] {
  const root = doc.catalog.lookup(N("StructTreeRoot"));
  if (!(root instanceof PDFDict)) return [];
  const pageRefs = doc.getPages().map((p) => p.ref.toString());
  const out: FigureElem[] = [];
  const seen = new Set<PDFDict>();
  const visit = (o: PDFObject | undefined, page: number, depth: number) => {
    if (!(o instanceof PDFDict) || seen.has(o) || depth > 200) return;
    seen.add(o);
    const pg = o.get(N("Pg"));
    const here = pg instanceof PDFRef ? pageRefs.indexOf(pg.toString()) : page;
    const role = o.lookup(N("S"));
    if (role instanceof PDFName && role.decodeText() === "Figure") out.push({ dict: o, page: here });
    const k = o.lookup(N("K"));
    if (k instanceof PDFArray) for (let i = 0; i < k.size(); i++) visit(k.lookup(i), here, depth + 1);
    else visit(k, here, depth + 1);
  };
  visit(root, -1, 0);
  return out;
}

export function listFigures(doc: PDFDocument): FigureRef[] {
  const perPage = new Map<number, number>();
  return figureElems(doc).map(({ dict, page }) => {
    const index = perPage.get(page) ?? 0;
    perPage.set(page, index + 1);
    const alt = dict.lookup(N("Alt"));
    return {
      page,
      index,
      alt: alt instanceof PDFHexString || alt instanceof PDFString ? alt.decodeText() : "",
    };
  });
}

/** Met à jour (ou retire, si vide) le texte de remplacement des figures désignées par `page:index`. */
export function setFigureAlts(doc: PDFDocument, alts: ReadonlyMap<string, string>): number {
  const perPage = new Map<number, number>();
  let changed = 0;
  for (const { dict, page } of figureElems(doc)) {
    const index = perPage.get(page) ?? 0;
    perPage.set(page, index + 1);
    const wanted = alts.get(figureKey(page, index));
    if (wanted === undefined) continue;
    if (wanted.trim()) dict.set(N("Alt"), PDFHexString.fromText(wanted.trim()));
    else dict.delete(N("Alt"));
    changed++;
  }
  return changed;
}
