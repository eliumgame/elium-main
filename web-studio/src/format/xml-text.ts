/**
 * Text that goes into XML (Office Open XML parts, HTML, RTF…) must only hold
 * characters XML 1.0 allows: `#x9 | #xA | #xD | [#x20-#xD7FF] | [#xE000-#xFFFD]
 * | [#x10000-#x10FFFF]`. PDFs routinely carry others (a ToUnicode map pointing
 * a glyph at U+0001 or U+FFFE, a lone surrogate from a broken CMap): written
 * raw they make Word / Excel / PowerPoint refuse the whole file.
 *
 * One sanitiser shared by every writer.
 */

// C0 controls except tab / LF / CR, the noncharacters U+FFFE / U+FFFF and
// unpaired surrogates (a high not followed by a low, a low not preceded by a high).
const XML_FORBIDDEN =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** `s` without the characters XML 1.0 forbids (see above). */
export function xmlSafeText(s: string): string {
  return String(s ?? "").replace(XML_FORBIDDEN, "");
}

/** Escape text for an XML element or a double-quoted attribute, forbidden characters removed. */
export function escapeXmlText(s: string): string {
  return xmlSafeText(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
