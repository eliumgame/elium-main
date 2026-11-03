import DOMPurify from "dompurify";
/** Slide rich text cannot host forms, application widgets or active embeds. */
export function sanitizeSlideHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      "p",
      "br",
      "span",
      "b",
      "strong",
      "i",
      "em",
      "u",
      "s",
      "strike",
      "ul",
      "ol",
      "li",
      "a",
      "sub",
      "sup",
      "div",
    ],
    ALLOWED_ATTR: ["style", "href", "title"],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
  });
}
