import { describe, it, expect } from "vitest";
import { PDFDocument, PDFName, PDFRawStream } from "pdf-lib";
import { updateXmp, syncXmp, xmpDate } from "../src/pdf/ops/xmp";
import { savePdf } from "../src/pdf/ops/save";
import * as D from "../src/pdf/model/doc";
import { emptyState } from "../src/pdf/model/types";

// Shaped like Word's packet (element form) plus attribute-form properties.
const WORD = `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/">
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:pdf="http://ns.adobe.com/pdf/1.3/">
<pdf:Producer>Microsoft® Word</pdf:Producer></rdf:Description>
<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:title><rdf:Alt><rdf:li xml:lang="x-default">Ancien titre</rdf:li></rdf:Alt></dc:title>
<dc:creator><rdf:Seq><rdf:li>Auteur A</rdf:li><rdf:li>Auteur B</rdf:li></rdf:Seq></dc:creator></rdf:Description>
<rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmp:ModifyDate="2020-01-01T00:00:00Z">
<xmp:CreateDate>2020-01-01T00:00:00Z</xmp:CreateDate></rdf:Description>
</rdf:RDF></x:xmpmeta>
<?xpacket end="w"?>`;

describe("XMP synchronisation", () => {
  it("updates the properties the packet carries, escaping text", () => {
    const when = new Date(2026, 8, 25, 10, 30, 0);
    const out = updateXmp(WORD, {
      title: "Nouveau <titre> & co",
      author: "Élise",
      producer: "Elium PDF",
      modified: when,
    })!;
    expect(out).toContain('<rdf:li xml:lang="x-default">Nouveau &lt;titre&gt; &amp; co</rdf:li>');
    expect(out).toContain("<dc:creator><rdf:Seq><rdf:li>Élise</rdf:li></rdf:Seq></dc:creator>");
    expect(out).toContain("<pdf:Producer>Elium PDF</pdf:Producer>");
    expect(out).toContain(`xmp:ModifyDate="${xmpDate(when)}"`);
    expect(out).toContain("<xmp:CreateDate>2020-01-01T00:00:00Z</xmp:CreateDate>"); // untouched
    expect(out).not.toContain("dc:description"); // nothing invented
  });

  it("returns null when there is nothing to change", () => {
    expect(updateXmp(WORD, { subject: "absent du paquet" })).toBeNull();
  });

  it("a title change reaches the XMP packet of the saved file", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([200, 200]);
    doc.setTitle("Ancien titre");
    const ref = doc.context.register(
      doc.context.stream(new TextEncoder().encode(WORD), { Type: "Metadata", Subtype: "XML" }),
    );
    doc.catalog.set(PDFName.of("Metadata"), ref);
    const src = await doc.save({ useObjectStreams: false });
    const state = { ...emptyState(), pages: D.pagesFromSource(1), metadata: { title: "Titre corrigé" } };
    const r = await savePdf({ source: src, state });
    expect(r.report.mode).toBe("incremental");
    const out = await PDFDocument.load(r.bytes, { updateMetadata: false });
    expect(out.getTitle()).toBe("Titre corrigé");
    const md = out.catalog.lookup(PDFName.of("Metadata")) as PDFRawStream;
    expect(new TextDecoder().decode(md.contents)).toContain(">Titre corrigé</rdf:li>");
    expect(syncXmp(out, {})).toBe(false);
  });
});
