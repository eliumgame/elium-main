/**
 * Accessibility check (Acrobat's « Accessibilité › Vérification complète »),
 * over the rules of PDF/UA (ISO 14289) and WCAG that can be judged from the
 * file: tagging, language, title, reading aids, alternate text, tables,
 * lists, headings, forms, fonts. Rules a program cannot judge (reading order,
 * colour contrast…) are listed « à vérifier manuellement », as Acrobat does.
 */
import { PDFArray, PDFDict, PDFHexString, PDFName, PDFNumber, PDFRef, PDFString } from "pdf-lib";
import type { PDFDocument, PDFObject } from "pdf-lib";

export type RuleStatus = "pass" | "fail" | "manual";

export interface AccessibilityRule {
  category:
    "Document" | "Contenu des pages" | "Formulaires" | "Texte de remplacement" | "Tableaux" | "Listes" | "Titres";
  rule: string;
  status: RuleStatus;
  detail?: string;
}

const N = (s: string) => PDFName.of(s);
const nameOf = (o: PDFObject | undefined) => (o instanceof PDFName ? o.decodeText() : undefined);
const textOf = (o: PDFObject | undefined) =>
  o instanceof PDFString || o instanceof PDFHexString ? o.decodeText() : undefined;

interface Elem {
  role: string;
  dict: PDFDict;
  kids: Elem[];
}

/** The structure tree, roles mapped through /RoleMap to standard types. */
function structTree(doc: PDFDocument): Elem | null {
  const root = doc.catalog.lookup(N("StructTreeRoot"));
  if (!(root instanceof PDFDict)) return null;
  const roleMap = root.lookup(N("RoleMap"));
  const mapRole = (r: string) => {
    let role = r;
    for (let i = 0; i < 8 && roleMap instanceof PDFDict; i++) {
      const to = nameOf(roleMap.lookup(N(role)));
      if (!to || to === role) break;
      role = to;
    }
    return role;
  };
  const seen = new Set<PDFDict>();
  const build = (d: PDFDict, depth: number): Elem => {
    seen.add(d);
    const role = mapRole(nameOf(d.lookup(N("S"))) ?? "");
    const kids: Elem[] = [];
    const k = d.lookup(N("K"));
    const push = (o: PDFObject | undefined) => {
      if (
        o instanceof PDFDict &&
        !seen.has(o) &&
        depth < 200 &&
        (o.has(N("S")) || o.has(N("K"))) &&
        !o.has(N("MCID"))
      ) {
        if (nameOf(o.lookup(N("Type"))) === "MCR" || nameOf(o.lookup(N("Type"))) === "OBJR") return;
        kids.push(build(o, depth + 1));
      }
    };
    if (k instanceof PDFArray) for (let i = 0; i < k.size(); i++) push(k.lookup(i));
    else push(k);
    return { role, dict: d, kids };
  };
  return build(root, 0);
}

function walk(e: Elem, visit: (e: Elem) => void) {
  visit(e);
  for (const k of e.kids) walk(k, visit);
}

/** Check a (decrypted) document. `pageTexts`: the text of each page, to tell image-only files. */
export function checkAccessibility(doc: PDFDocument, pageTexts: readonly string[] = []): AccessibilityRule[] {
  const out: AccessibilityRule[] = [];
  const add = (category: AccessibilityRule["category"], rule: string, ok: boolean | "manual", detail?: string) =>
    out.push({ category, rule, status: ok === "manual" ? "manual" : ok ? "pass" : "fail", detail });
  const cat = doc.catalog;
  const pages = doc.getPages();

  // --- Document ---------------------------------------------------------------
  add("Document", "Autorisation d'accès pour les lecteurs d'écran", true);
  const textless = pageTexts.length > 0 && pageTexts.every((t) => !t.trim());
  add(
    "Document",
    "PDF image uniquement",
    !textless,
    textless ? "Aucun texte : lancez la reconnaissance de texte (OCR)." : undefined,
  );
  const mark = cat.lookup(N("MarkInfo"));
  const tree = structTree(doc);
  const tagged = mark instanceof PDFDict && mark.lookup(N("Marked"))?.toString() === "true" && !!tree;
  add("Document", "PDF balisé", tagged, tagged ? undefined : "Le document n'a pas de structure (balises).");
  add("Document", "Ordre de lecture logique", "manual");
  const lang = textOf(cat.lookup(N("Lang")));
  add("Document", "Langue principale", !!lang, lang ? `« ${lang} »` : "Aucune langue déclarée.");
  const info =
    doc.context.trailerInfo.Info instanceof PDFRef ? doc.context.lookup(doc.context.trailerInfo.Info) : undefined;
  const title = info instanceof PDFDict ? textOf(info.lookup(N("Title"))) : undefined;
  const prefs = cat.lookup(N("ViewerPreferences"));
  const showsTitle = prefs instanceof PDFDict && prefs.lookup(N("DisplayDocTitle"))?.toString() === "true";
  add(
    "Document",
    "Titre",
    !!title?.trim() && showsTitle,
    !title?.trim() ? "Aucun titre." : showsTitle ? undefined : "Le titre n'est pas affiché dans la barre de titre.",
  );
  const outlines = cat.lookup(N("Outlines"));
  const hasBookmarks = outlines instanceof PDFDict && outlines.has(N("First"));
  add(
    "Document",
    "Signets",
    pages.length <= 20 || hasBookmarks,
    pages.length > 20 && !hasBookmarks ? "Plus de 20 pages sans signets." : undefined,
  );
  add("Document", "Contraste des couleurs", "manual");

  // --- Page content -------------------------------------------------------------
  let untaggedAnnots = 0;
  let tabs = 0;
  let pagesWithAnnots = 0;
  const widgets: PDFDict[] = [];
  let links = 0;
  let linksWithoutText = 0;
  for (const page of pages) {
    const annots = page.node.lookup(N("Annots"));
    if (!(annots instanceof PDFArray) || !annots.size()) continue;
    pagesWithAnnots++;
    if (nameOf(page.node.lookup(N("Tabs"))) === "S") tabs++;
    for (let i = 0; i < annots.size(); i++) {
      const a = annots.lookup(i);
      if (!(a instanceof PDFDict)) continue;
      const st = nameOf(a.lookup(N("Subtype")));
      if (st === "Popup") continue;
      if (!a.has(N("StructParent"))) untaggedAnnots++;
      if (st === "Widget") widgets.push(a);
      if (st === "Link") {
        links++;
        if (!textOf(a.lookup(N("Contents")))) linksWithoutText++;
      }
    }
  }
  add("Contenu des pages", "Contenu balisé", tagged, tagged ? undefined : "Le contenu des pages n'est pas balisé.");
  add(
    "Contenu des pages",
    "Annotations balisées",
    untaggedAnnots === 0,
    untaggedAnnots ? `${untaggedAnnots} annotation(s) sans balise.` : undefined,
  );
  add(
    "Contenu des pages",
    "Ordre de tabulation",
    tabs === pagesWithAnnots,
    tabs === pagesWithAnnots
      ? undefined
      : `${pagesWithAnnots - tabs} page(s) sans ordre de tabulation selon la structure.`,
  );
  let badFonts = 0;
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict) || nameOf(obj.lookup(N("Type"))) !== "Font") continue;
    const st = nameOf(obj.lookup(N("Subtype")));
    if (st === "Type0" || st === "Type3") {
      if (!obj.has(N("ToUnicode"))) badFonts++;
    } else if (obj.lookup(N("Encoding")) instanceof PDFDict && !obj.has(N("ToUnicode"))) {
      // Custom encodings name their glyphs; without ToUnicode they may not map to text.
      const diff = (obj.lookup(N("Encoding")) as PDFDict).lookup(N("Differences"));
      if (diff instanceof PDFArray && diff.toString().match(/\/(g\d+|glyph\d+|c\d+)/)) badFonts++;
    }
  }
  add(
    "Contenu des pages",
    "Codage des caractères",
    badFonts === 0,
    badFonts ? `${badFonts} police(s) sans correspondance Unicode.` : undefined,
  );
  add(
    "Contenu des pages",
    "Liens de navigation",
    linksWithoutText === 0,
    linksWithoutText ? `${linksWithoutText} lien(s) sur ${links} sans description.` : undefined,
  );
  const names = cat.lookup(N("Names"));
  add("Contenu des pages", "Scripts", names instanceof PDFDict && names.has(N("JavaScript")) ? "manual" : true);
  add("Contenu des pages", "Clignotement de l'écran", "manual");
  add("Contenu des pages", "Réponses minutées", "manual");

  // --- Forms --------------------------------------------------------------------
  const noTu = widgets.filter((w) => {
    let n: PDFDict | undefined = w;
    for (let i = 0; i < 16 && n; i++) {
      if (textOf(n.lookup(N("TU")))) return false;
      const p: PDFObject | undefined = n.lookup(N("Parent"));
      n = p instanceof PDFDict ? p : undefined;
    }
    return true;
  }).length;
  add(
    "Formulaires",
    "Champs de formulaire balisés",
    widgets.every((w) => w.has(N("StructParent"))),
    undefined,
  );
  add(
    "Formulaires",
    "Descriptions des champs",
    noTu === 0,
    noTu ? `${noTu} champ(s) sans info-bulle (description).` : undefined,
  );

  // --- Structure: alternate text, tables, lists, headings ------------------------------
  let figures = 0;
  let figuresNoAlt = 0;
  let tables = 0;
  let badRows = 0;
  let noHeaders = 0;
  let lists = 0;
  let badLists = 0;
  let headingJumps = 0;
  let lastLevel = 0;
  if (tree) {
    walk(tree, (e) => {
      const alt = textOf(e.dict.lookup(N("Alt"))) ?? textOf(e.dict.lookup(N("ActualText")));
      if (e.role === "Figure" || e.role === "Formula") {
        figures++;
        if (!alt?.trim()) figuresNoAlt++;
      }
      if (e.role === "Table") {
        tables++;
        const rows: Elem[] = [];
        for (const k of e.kids) {
          if (k.role === "TR") rows.push(k);
          else if (["THead", "TBody", "TFoot"].includes(k.role)) rows.push(...k.kids.filter((r) => r.role === "TR"));
          else badRows++;
        }
        if (rows.some((r) => r.kids.some((c) => c.role !== "TH" && c.role !== "TD"))) badRows++;
        if (!rows.some((r) => r.kids.some((c) => c.role === "TH"))) noHeaders++;
      }
      if (e.role === "L") {
        lists++;
        if (e.kids.some((k) => k.role !== "LI" && k.role !== "Caption" && k.role !== "L")) badLists++;
        for (const li of e.kids.filter((k) => k.role === "LI"))
          if (li.kids.some((k) => k.role !== "Lbl" && k.role !== "LBody")) badLists++;
      }
      const h = /^H([1-6])$/.exec(e.role);
      if (h) {
        const level = Number(h[1]);
        if (lastLevel && level > lastLevel + 1) headingJumps++;
        if (!lastLevel && level > 1) headingJumps++;
        lastLevel = level;
      }
    });
  }
  const needsTags = tree ? undefined : "Sans balises, ces éléments ne peuvent pas être vérifiés.";
  add(
    "Texte de remplacement",
    "Texte de remplacement des figures",
    tree ? figuresNoAlt === 0 : false,
    figuresNoAlt ? `${figuresNoAlt} figure(s) sur ${figures} sans texte de remplacement.` : needsTags,
  );
  add("Texte de remplacement", "Texte de remplacement imbriqué", tree ? true : false, needsTags);
  add(
    "Tableaux",
    "Lignes et cellules (TR, TH, TD)",
    tree ? badRows === 0 : false,
    badRows ? `${badRows} tableau(x) mal structuré(s) sur ${tables}.` : needsTags,
  );
  add(
    "Tableaux",
    "En-têtes",
    tree ? noHeaders === 0 : false,
    noHeaders ? `${noHeaders} tableau(x) sans cellule d'en-tête.` : needsTags,
  );
  add(
    "Listes",
    "Éléments de liste (LI, Lbl, LBody)",
    tree ? badLists === 0 : false,
    badLists ? `${badLists} liste(s) mal structurée(s) sur ${lists}.` : needsTags,
  );
  add(
    "Titres",
    "Imbrication appropriée",
    tree ? headingJumps === 0 : false,
    headingJumps ? `${headingJumps} saut(s) de niveau de titre.` : needsTags,
  );
  void PDFNumber;
  return out;
}
