// Aide de tests : fabrique un package .docx « tel que Word l'écrit » à partir de fragments XML.
import { zipSync, strToU8 } from "fflate";

export const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
export const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const REL = "http://schemas.openxmlformats.org/package/2006/relationships";

export function wordDocx(parts: {
  body: string;
  styles?: string;
  numbering?: string;
  comments?: string;
  header?: string;
  footer?: string;
  footnotes?: string;
  sectPr?: string;
  extraRels?: string;
  files?: Record<string, Uint8Array>;
}): Uint8Array {
  const rels = [
    parts.styles ? `<Relationship Id="rIdSt" Type="${R}/styles" Target="styles.xml"/>` : "",
    parts.numbering ? `<Relationship Id="rIdNum" Type="${R}/numbering" Target="numbering.xml"/>` : "",
    parts.comments ? `<Relationship Id="rIdCm" Type="${R}/comments" Target="comments.xml"/>` : "",
    parts.header ? `<Relationship Id="rIdHd" Type="${R}/header" Target="header1.xml"/>` : "",
    parts.footer ? `<Relationship Id="rIdFt" Type="${R}/footer" Target="footer1.xml"/>` : "",
    parts.footnotes ? `<Relationship Id="rIdFn" Type="${R}/footnotes" Target="footnotes.xml"/>` : "",
    parts.extraRels ?? "",
  ].join("");
  const sect =
    parts.sectPr ??
    `<w:sectPr>${parts.header ? `<w:headerReference w:type="default" r:id="rIdHd"/>` : ""}${
      parts.footer ? `<w:footerReference w:type="default" r:id="rIdFt"/>` : ""
    }<w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1417" w:right="1417" w:bottom="1417" w:left="1417" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>`;
  const wrap = (inner: string) =>
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${inner}`;
  const ns = `xmlns:w="${W}" xmlns:r="${R}" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"`;
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(
      wrap(
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
      ),
    ),
    "_rels/.rels": strToU8(wrap(`<Relationships xmlns="${REL}"><Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/></Relationships>`)),
    "word/_rels/document.xml.rels": strToU8(wrap(`<Relationships xmlns="${REL}">${rels}</Relationships>`)),
    "word/document.xml": strToU8(wrap(`<w:document ${ns}><w:body>${parts.body}${sect}</w:body></w:document>`)),
  };
  if (parts.styles) files["word/styles.xml"] = strToU8(wrap(`<w:styles ${ns}>${parts.styles}</w:styles>`));
  if (parts.numbering) files["word/numbering.xml"] = strToU8(wrap(`<w:numbering ${ns}>${parts.numbering}</w:numbering>`));
  if (parts.comments) files["word/comments.xml"] = strToU8(wrap(`<w:comments ${ns}>${parts.comments}</w:comments>`));
  if (parts.header) files["word/header1.xml"] = strToU8(wrap(`<w:hdr ${ns}>${parts.header}</w:hdr>`));
  if (parts.footer) files["word/footer1.xml"] = strToU8(wrap(`<w:ftr ${ns}>${parts.footer}</w:ftr>`));
  if (parts.footnotes) files["word/footnotes.xml"] = strToU8(wrap(`<w:footnotes ${ns}>${parts.footnotes}</w:footnotes>`));
  for (const [k, v] of Object.entries(parts.files ?? {})) files[k] = v;
  return zipSync(files, { level: 0 });
}
