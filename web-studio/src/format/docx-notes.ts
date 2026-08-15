/**
 * Les parties OOXML des notes de bas de page et des notes de fin.
 *
 * L'export précédent était en trompe-l'œil : il écrivait « [1] » en exposant et
 * un titre « Notes » suivi de paragraphes. Word ne voyait donc aucune note — pas
 * de renumérotation, pas de placement en bas de page, rien dans son propre
 * gestionnaire de notes. Ce module produit les vraies parties `footnotes.xml` et
 * `endnotes.xml` avec les `w:footnoteReference`/`w:endnoteReference`
 * correspondants, de sorte que Word les gère comme les siennes.
 *
 * Les identifiants -1 et 0 sont réservés par ECMA-376 aux séparateurs, donc les
 * notes réelles commencent à 1 ; c'est pour cela que `noteXmlId` décale le rang.
 */

import { NOTE_TITLES, noteNumFmt, type NoteEntry, type NoteKind } from "../editor/notes";

/** Nom de la partie OOXML, par famille. */
export const NOTE_PART: Record<NoteKind, string> = {
  footnote: "word/footnotes.xml",
  endnote: "word/endnotes.xml",
};

/** Élément racine de la partie, par famille. */
const ROOT: Record<NoteKind, string> = { footnote: "w:footnotes", endnote: "w:endnotes" };
/** Élément de note, par famille. */
const ITEM: Record<NoteKind, string> = { footnote: "w:footnote", endnote: "w:endnote" };
/** L'auto-référence qui imprime le numéro dans le corps de la note. */
const SELF_REF: Record<NoteKind, string> = { footnote: "w:footnoteRef", endnote: "w:endnoteRef" };
/** L'appel de note, posé dans le flux du texte. */
const REFERENCE: Record<NoteKind, string> = {
  footnote: "w:footnoteReference",
  endnote: "w:endnoteReference",
};
/** Style de paragraphe du corps de la note, et style de caractère de l'appel. */
export const NOTE_TEXT_STYLE: Record<NoteKind, string> = {
  footnote: "FootnoteText",
  endnote: "EndnoteText",
};
export const NOTE_REF_STYLE: Record<NoteKind, string> = {
  footnote: "FootnoteReference",
  endnote: "EndnoteReference",
};

const CONTENT_TYPE: Record<NoteKind, string> = {
  footnote: "application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml",
  endnote: "application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml",
};

const REL_TYPE: Record<NoteKind, string> = {
  footnote: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes",
  endnote: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/endnotes",
};

const NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

function esc(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Identifiant OOXML de la n-ième note (rang à partir de 1).
 *
 * Décalé de 1 parce que 0 et -1 appartiennent au séparateur et au séparateur de
 * continuation : réutiliser 0 pour une vraie note fait rejeter le fichier.
 */
export function noteXmlId(number: number): number {
  return number + 1;
}

/** L'appel de note à insérer dans le flux du texte. */
export function noteReferenceXml(kind: NoteKind, number: number): string {
  return (
    `<w:r><w:rPr><w:rStyle w:val="${NOTE_REF_STYLE[kind]}"/>` +
    `<w:vertAlign w:val="superscript"/></w:rPr>` +
    `<${REFERENCE[kind]} w:id="${noteXmlId(number)}"/></w:r>`
  );
}

/** Les deux notes réservées : séparateur et séparateur de continuation. */
function separators(kind: NoteKind): string {
  const item = ITEM[kind];
  const blank = '<w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr>';
  return (
    `<${item} w:type="separator" w:id="-1"><w:p>${blank}<w:r><w:separator/></w:r></w:p></${item}>` +
    `<${item} w:type="continuationSeparator" w:id="0"><w:p>${blank}` +
    `<w:r><w:continuationSeparator/></w:r></w:p></${item}>`
  );
}

/**
 * La partie `footnotes.xml` / `endnotes.xml` complète.
 *
 * Word exige la présence des deux notes réservées même sans aucune note réelle,
 * dès lors que la partie est déclarée.
 */
export function notesPartXml(kind: NoteKind, entries: NoteEntry[]): string {
  const item = ITEM[kind];
  const body = entries
    .map((entry) => {
      const text = entry.text ? `<w:r><w:t xml:space="preserve"> ${esc(entry.text)}</w:t></w:r>` : "";
      return (
        `<${item} w:id="${noteXmlId(entry.number)}">` +
        `<w:p><w:pPr><w:pStyle w:val="${NOTE_TEXT_STYLE[kind]}"/></w:pPr>` +
        `<w:r><w:rPr><w:rStyle w:val="${NOTE_REF_STYLE[kind]}"/></w:rPr><${SELF_REF[kind]}/></w:r>` +
        `${text}</w:p></${item}>`
      );
    })
    .join("");
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    `<${ROOT[kind]} ${NS}>${separators(kind)}${body}</${ROOT[kind]}>`
  );
}

/** La déclaration de type de contenu de la partie. */
export function notesContentTypeXml(kind: NoteKind): string {
  return `<Override PartName="/${NOTE_PART[kind].replace(/^word\//, "word/")}" ContentType="${CONTENT_TYPE[kind]}"/>`;
}

/** La relation depuis `document.xml` vers la partie. */
export function notesRelXml(kind: NoteKind, id: string): string {
  const target = NOTE_PART[kind].replace(/^word\//, "");
  return `<Relationship Id="${id}" Type="${REL_TYPE[kind]}" Target="${target}"/>`;
}

/**
 * Les propriétés de numérotation à placer dans `w:sectPr`.
 *
 * Sans cela Word numéroterait les notes de fin en romains minuscules par défaut
 * mais les notes de bas de page en arabe : on le déclare explicitement pour que
 * le document ouvert dans Word affiche exactement les marqueurs vus à l'écran.
 */
export function notePrXml(kind: NoteKind): string {
  const tag = kind === "endnote" ? "w:endnotePr" : "w:footnotePr";
  const pos = kind === "endnote" ? '<w:pos w:val="docEnd"/>' : "";
  return `<${tag}>${pos}<w:numFmt w:val="${noteNumFmt(kind)}"/></${tag}>`;
}

/**
 * Les styles de note à ajouter à `styles.xml`.
 *
 * Word les recrée au besoin, mais un document qui les porte s'ouvre avec la
 * bonne taille de corps (10 pt) au lieu du style Normal du document.
 */
export function noteStylesXml(): string {
  const styles: string[] = [];
  for (const kind of ["footnote", "endnote"] as NoteKind[]) {
    const text = NOTE_TEXT_STYLE[kind];
    const ref = NOTE_REF_STYLE[kind];
    styles.push(
      `<w:style w:type="paragraph" w:styleId="${text}">` +
        `<w:name w:val="${kind === "endnote" ? "endnote text" : "footnote text"}"/>` +
        '<w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr>' +
        '<w:rPr><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr></w:style>',
    );
    styles.push(
      `<w:style w:type="character" w:styleId="${ref}">` +
        `<w:name w:val="${kind === "endnote" ? "endnote reference" : "footnote reference"}"/>` +
        '<w:rPr><w:vertAlign w:val="superscript"/></w:rPr></w:style>',
    );
  }
  return styles.join("");
}

/** Le titre de la liste, pour les exports qui rendent les notes en corps de texte. */
export function notesHeading(kind: NoteKind): string {
  return NOTE_TITLES[kind];
}
