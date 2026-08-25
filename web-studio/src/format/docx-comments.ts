/**
 * The DOCX `word/comments.xml` part — real Word comment balloons, not frozen
 * text. Mirrors `docx-notes.ts` for footnotes/endnotes: a small dedicated part
 * plus the relationship/content-type declarations it needs.
 *
 * Scope, deliberately: only the ROOT comment (author/date/text) round-trips
 * through DOCX. Replies and the resolved flag are Elium-native extensions with
 * no standard OOXML representation — Word only supports threaded replies via
 * its own undocumented, version-gated `word/commentsExtended.xml` (`w15`,
 * paraId/paraIdParent GUIDs matching paragraphs across two parts). Bolting that
 * on for a cosmetic nesting improvement — over comments that already anchor
 * correctly and are already readable — is exactly the kind of fragile,
 * disproportionate fix this project avoids; replies/resolved stay perfectly
 * intact in the native `.elium` format and are dropped on DOCX export/import,
 * same policy as every other Elium-only extension in this exporter.
 */
export const COMMENTS_PART = "word/comments.xml";

const NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

const CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml";
const REL_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments";

function esc(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** One comment thread's root, as written to (and read from) `comments.xml`. */
export interface CommentEntry {
  /** The part-local numeric id (`w:id`) — Elium's own string id lives only in .elium. */
  docxId: number;
  author: string;
  date: string;
  text: string;
}

export function commentsPartXml(entries: CommentEntry[]): string {
  const body = entries
    .map(
      (e) =>
        `<w:comment w:id="${e.docxId}" w:author="${esc(e.author)}"${e.date ? ` w:date="${esc(e.date)}"` : ""}>` +
        `<w:p><w:r><w:t xml:space="preserve">${esc(e.text)}</w:t></w:r></w:p></w:comment>`,
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:comments ${NS}>${body}</w:comments>`;
}

export function commentsContentTypeXml(): string {
  return `<Override PartName="/${COMMENTS_PART}" ContentType="${CONTENT_TYPE}"/>`;
}

export function commentsRelXml(id: string): string {
  return `<Relationship Id="${id}" Type="${REL_TYPE}" Target="comments.xml"/>`;
}
