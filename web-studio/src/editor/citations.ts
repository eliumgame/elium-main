/**
 * Citations et bibliographie : modèle de source et mise en forme APA, MLA et
 * ISO 690 (français). Fonctions PURES — la mise en forme est dérivée des
 * sources, jamais stockée comme vérité : changer de style recalcule tout.
 */
export type SourceType = "book" | "article" | "web" | "report" | "thesis" | "chapter";
export type CitationStyle = "apa" | "mla" | "iso690";

export interface BibSource {
  key: string;
  type: SourceType;
  /** Auteurs séparés par « ; » au format « Nom, Prénom ». */
  authors: string;
  title: string;
  year?: string;
  publisher?: string;
  place?: string;
  /** Revue, site web ou ouvrage collectif contenant la source. */
  container?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  edition?: string;
  url?: string;
  accessed?: string; // AAAA-MM-JJ
  doi?: string;
}

export const SOURCE_TYPE_LABELS: Record<SourceType, string> = {
  book: "Livre",
  article: "Article de revue",
  chapter: "Chapitre d'ouvrage",
  web: "Site web",
  report: "Rapport",
  thesis: "Thèse / mémoire",
};
export const STYLE_LABELS: Record<CitationStyle, string> = {
  apa: "APA (7e éd.)",
  mla: "MLA",
  iso690: "ISO 690 (auteur-date)",
};
export const BIBLIOGRAPHY_TITLES: Record<CitationStyle, string> = {
  apa: "Références",
  mla: "Ouvrages cités",
  iso690: "Références bibliographiques",
};

/** Segment de texte d'une référence : l'italique porte les titres d'ouvrages et de revues. */
export interface RefPart {
  t: string;
  i?: boolean;
}

export interface Author {
  last: string;
  first: string;
}

export function parseAuthors(raw: string | undefined): Author[] {
  return (raw ?? "")
    .split(";")
    .map((a) => a.trim())
    .filter(Boolean)
    .map((a) => {
      const [last, ...rest] = a.split(",");
      return rest.length ? { last: last!.trim(), first: rest.join(",").trim() } : { last: a, first: "" };
    });
}

const initials = (first: string): string =>
  first
    .split(/[\s]+/)
    .filter(Boolean)
    .map((p) => p.split("-").map((q) => `${q[0]!.toUpperCase()}.`).join("-"))
    .join(" ");

const trimDot = (s: string): string => s.replace(/[.\s]+$/, "");
const endDot = (s: string): string => (/[.!?…]$/.test(s) ? s : `${s}.`);

/** Clé stable d'une source (nom + année + début du titre). */
export function makeSourceKey(s: Pick<BibSource, "authors" | "year" | "title">): string {
  const a = parseAuthors(s.authors)[0]?.last ?? s.title.split(/\s+/)[0] ?? "src";
  const slug = (x: string) => x.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  return `${slug(a)}${s.year ?? ""}${slug(s.title).slice(0, 6)}`;
}

const shortTitle = (t: string): string => (t.length > 40 ? `${t.slice(0, 37)}…` : t);

/** Auteurs dans une citation courante. */
function inlineAuthors(src: BibSource, style: CitationStyle): string {
  const au = parseAuthors(src.authors);
  if (!au.length) return style === "iso690" ? shortTitle(src.title).toUpperCase() : `« ${shortTitle(src.title)} »`;
  const name = (a: Author) => (style === "iso690" ? a.last.toUpperCase() : a.last);
  if (au.length === 1) return name(au[0]!);
  if (au.length === 2) return `${name(au[0]!)} ${style === "iso690" ? "et" : "et"} ${name(au[1]!)}`;
  return style === "apa" ? `${name(au[0]!)} et al.` : `${name(au[0]!)} et al.`;
}

/** Texte d'une citation dans le corps : « (Dupont, 2020, p. 12) ». */
export function formatCitation(src: BibSource, style: CitationStyle, page?: string): string {
  const who = inlineAuthors(src, style);
  const pg = page?.trim();
  if (style === "mla") return `(${who}${pg ? ` ${pg}` : ""})`;
  const year = src.year?.trim() || "s. d.";
  return `(${who}, ${year}${pg ? `, p. ${pg}` : ""})`;
}

const frDate = (iso: string | undefined): string => {
  if (!iso) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const mois = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
  return `${Number(m[3])} ${mois[Number(m[2]) - 1] ?? ""} ${m[1]}`;
};
const link = (s: BibSource): string => (s.doi ? `https://doi.org/${s.doi.replace(/^https?:\/\/(dx\.)?doi\.org\//, "")}` : (s.url ?? ""));
const pageRange = (p: string | undefined): string => (p ? p.replace(/\s*[-–—]\s*/, "–") : "");

/** Référence complète pour la bibliographie, en segments (italique pour titres d'ouvrages/revues). */
export function formatReference(src: BibSource, style: CitationStyle): RefPart[] {
  const au = parseAuthors(src.authors);
  const out: RefPart[] = [];
  const push = (t: string, i = false) => {
    if (t) out.push(i ? { t, i } : { t });
  };
  const url = link(src);
  const year = src.year?.trim() || "s. d.";

  if (style === "apa") {
    const names = au.map((a) => (a.first ? `${a.last}, ${initials(a.first)}` : a.last));
    const who = names.length <= 1 ? (names[0] ?? "") : names.length === 2 ? `${names[0]} & ${names[1]}` : `${names.slice(0, -1).join(", ")}, & ${names[names.length - 1]}`;
    if (who) push(`${trimDot(who)}. `);
    // Sans auteur, le titre passe devant la date (règle APA) pour les ouvrages et sites.
    const titleFirst = !who && (src.type === "web" || src.type === "book" || src.type === "report" || src.type === "thesis");
    if (titleFirst) {
      push(trimDot(src.title), true);
      push(". ");
    }
    push(`(${year}). `);
    switch (src.type) {
      case "article":
        push(`${endDot(src.title)} `);
        push(src.container ?? "", true);
        if (src.volume) {
          push(", ");
          push(src.volume, true);
        }
        if (src.issue) push(`(${src.issue})`);
        if (src.pages) push(`, ${pageRange(src.pages)}`);
        push(". ");
        break;
      case "chapter":
        push(`${endDot(src.title)} Dans `);
        push(src.container ?? "", true);
        if (src.pages) push(` (p. ${pageRange(src.pages)})`);
        push(". ");
        push(src.publisher ? `${endDot(src.publisher)} ` : "");
        break;
      case "web":
        if (!titleFirst) {
          push(trimDot(src.title), true);
          push(". ");
        }
        if (src.container) push(`${endDot(src.container)} `);
        break;
      default:
        if (!titleFirst) {
          push(trimDot(src.title), true);
          if (src.edition) push(` (${src.edition})`);
          push(". ");
        }
        if (src.publisher) push(`${endDot(src.publisher)} `);
    }
    push(url);
    return trimParts(out);
  }

  if (style === "mla") {
    const first = au[0];
    let who = "";
    if (first) {
      who = first.first ? `${first.last}, ${first.first}` : first.last;
      if (au.length === 2) who += `, et ${au[1]!.first ? `${au[1]!.first} ${au[1]!.last}` : au[1]!.last}`;
      else if (au.length > 2) who += ", et al";
    }
    if (who) push(`${endDot(who)} `);
    switch (src.type) {
      case "article":
        push(`« ${trimDot(src.title)} ». `);
        push(src.container ?? "", true);
        push([src.volume ? `, vol. ${src.volume}` : "", src.issue ? `, no ${src.issue}` : "", `, ${year}`, src.pages ? `, p. ${pageRange(src.pages)}` : ""].join(""));
        push(". ");
        break;
      case "chapter":
        push(`« ${trimDot(src.title)} ». `);
        push(src.container ?? "", true);
        push(`${src.publisher ? `, ${src.publisher}` : ""}, ${year}${src.pages ? `, p. ${pageRange(src.pages)}` : ""}. `);
        break;
      case "web":
        push(`« ${trimDot(src.title)} ». `);
        push(src.container ?? "", true);
        push(`, ${year}${url ? `, ${url}` : ""}. `);
        if (src.accessed) push(`Consulté le ${frDate(src.accessed)}.`);
        return trimParts(out);
      default:
        push(trimDot(src.title), true);
        push(". ");
        push(`${[src.edition, src.publisher].filter(Boolean).join(", ")}${src.publisher || src.edition ? ", " : ""}${year}. `);
    }
    push(url ? `${url}.` : "");
    return trimParts(out);
  }

  // ISO 690 (auteur-date) : NOM, Prénom.
  const names = au.map((a) => (a.first ? `${a.last.toUpperCase()}, ${a.first}` : a.last.toUpperCase()));
  const who = names.length > 3 ? `${names[0]} et al.` : names.join(" ; ");
  if (who) push(`${endDot(who)} `);
  switch (src.type) {
    case "article":
      push(`${endDot(src.title)} `);
      push(src.container ?? "", true);
      push(`, ${year}${src.volume ? `, vol. ${src.volume}` : ""}${src.issue ? `, n° ${src.issue}` : ""}${src.pages ? `, p. ${pageRange(src.pages)}` : ""}. `);
      break;
    case "chapter":
      push(`${endDot(src.title)} In : `);
      push(src.container ?? "", true);
      push(`. ${src.place ? `${src.place} : ` : ""}${src.publisher ? `${src.publisher}, ` : ""}${year}${src.pages ? `, p. ${pageRange(src.pages)}` : ""}. `);
      break;
    case "web":
      push(trimDot(src.title), true);
      push(" [en ligne]. ");
      push(`${src.container ? `${src.container}, ` : ""}${year}`);
      if (src.accessed) push(` [consulté le ${frDate(src.accessed)}]`);
      push(". ");
      if (url) push(`Disponible à l'adresse : ${url}`);
      return trimParts(out);
    default:
      push(trimDot(src.title), true);
      push(". ");
      if (src.edition) push(`${endDot(src.edition)} `);
      push(`${src.place ? `${src.place} : ` : ""}${src.publisher ? `${src.publisher}, ` : ""}${year}. `);
  }
  push(url);
  return trimParts(out);
}

function trimParts(parts: RefPart[]): RefPart[] {
  const out = parts.map((p) => ({ ...p })).filter((p) => p.t);
  if (out.length) {
    out[0]!.t = out[0]!.t.replace(/^\s+/, "");
    out[out.length - 1]!.t = out[out.length - 1]!.t.replace(/\s+$/, "");
  }
  return out;
}

export const partsToText = (parts: RefPart[]): string => parts.map((p) => p.t).join("");

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export const partsToHtml = (parts: RefPart[]): string => parts.map((p) => (p.i ? `<i>${esc(p.t)}</i>` : esc(p.t))).join("");

/** Tri alphabétique des sources (nom du premier auteur, puis année, puis titre). */
export function sortSources(list: BibSource[]): BibSource[] {
  const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  return list.slice().sort((a, b) => {
    const an = norm(parseAuthors(a.authors)[0]?.last ?? a.title);
    const bn = norm(parseAuthors(b.authors)[0]?.last ?? b.title);
    return an.localeCompare(bn, "fr") || (a.year ?? "").localeCompare(b.year ?? "") || norm(a.title).localeCompare(norm(b.title), "fr");
  });
}

/** Sources citées dans un document JSON ProseMirror, dédoublonnées, dans l'ordre d'apparition. */
export function collectSources(doc: { type: string; attrs?: Record<string, unknown>; content?: unknown[] }): BibSource[] {
  const seen = new Map<string, BibSource>();
  const walk = (n: { type: string; attrs?: Record<string, unknown>; content?: unknown[] }) => {
    if (n.type === "citation") {
      const s = n.attrs?.source as BibSource | undefined;
      if (s?.key && !seen.has(s.key)) seen.set(s.key, s);
    }
    for (const c of (n.content ?? []) as (typeof n)[]) walk(c);
  };
  walk(doc);
  return [...seen.values()];
}

/** Entrées de bibliographie (triées) pour un ensemble de sources. */
export function buildBibliography(sources: BibSource[], style: CitationStyle): RefPart[][] {
  return sortSources(sources).map((s) => formatReference(s, style));
}

/** Validation d'une source avant enregistrement : liste de problèmes (français). */
export function validateSource(s: BibSource): string[] {
  const errs: string[] = [];
  if (!s.title.trim()) errs.push("Le titre est obligatoire.");
  if (!s.authors.trim() && s.type !== "web") errs.push("Indiquez au moins un auteur (« Nom, Prénom »).");
  if (s.year && !/^\d{4}[a-z]?$/.test(s.year.trim())) errs.push("L'année doit comporter quatre chiffres (ex. 2021).");
  if (s.type === "article" && !s.container?.trim()) errs.push("Indiquez le nom de la revue.");
  if (s.type === "web" && !(s.url?.trim() || s.doi?.trim())) errs.push("Indiquez l'adresse (URL) du site.");
  return errs;
}

/** Vrai si une citation ou une bibliographie ne correspond plus au style / aux sources (pur, sur le JSON). */
export function bibliographyStale(doc: { type: string; attrs?: Record<string, unknown>; content?: unknown[] }, style: CitationStyle): boolean {
  const sources = collectSources(doc);
  const entries = JSON.stringify(buildBibliography(sources, style));
  let stale = false;
  const walk = (n: { type: string; attrs?: Record<string, unknown>; content?: unknown[] }) => {
    if (n.type === "citation") {
      const s = n.attrs?.source as BibSource | undefined;
      if (s && formatCitation(s, style, String(n.attrs?.page ?? "")) !== n.attrs?.text) stale = true;
    } else if (n.type === "bibliography") {
      if (n.attrs?.style !== style || JSON.stringify(n.attrs?.entries ?? []) !== entries) stale = true;
    }
    for (const c of (n.content ?? []) as (typeof n)[]) walk(c);
  };
  walk(doc);
  return stale;
}
