import { describe, it, expect } from "vitest";
import { PDFDocument, PDFName, StandardFonts } from "pdf-lib";
import { savePdf } from "../src/pdf/ops/save";
import { xfaKind } from "../src/pdf/ops/xfa";
import { formOf } from "../src/pdf/ops/pdfform";
import * as D from "../src/pdf/model/doc";
import { emptyState } from "../src/pdf/model/types";

async function withXfa(withFields: boolean): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([300, 200]);
  const form = formOf(doc);
  if (withFields) form.createTextField("nom").addToPage(page, { x: 20, y: 100, width: 150, height: 20, font });
  const packet = doc.context.flateStream('<xdp:xdp xmlns:xdp="http://ns.adobe.com/xdp/"><xfa:datasets/></xdp:xdp>');
  form.acroForm.dict.set(PDFName.of("XFA"), doc.context.register(packet));
  if (!withFields) form.acroForm.dict.set(PDFName.of("Fields"), doc.context.obj([]));
  doc.catalog.set(PDFName.of("NeedsRendering"), doc.context.obj(true));
  return doc.save({ useObjectStreams: false, updateFieldAppearances: false });
}

const state = (formValues: Record<string, string>) => ({ ...emptyState(), pages: D.pagesFromSource(1), formValues });

describe("XFA forms", () => {
  it("drops the XFA of a hybrid form once its AcroForm is filled, and says so", async () => {
    const src = await withXfa(true);
    expect(xfaKind(await PDFDocument.load(src))).toBe("hybrid");
    const r = await savePdf({ source: src, state: state({ nom: "Dupont" }) });
    const out = await PDFDocument.load(r.bytes);
    expect(xfaKind(out)).toBe("none");
    expect(out.catalog.get(PDFName.of("NeedsRendering"))).toBeUndefined();
    expect(out.getForm().getTextField("nom").getText()).toBe("Dupont");
    expect(r.report.warnings.join(" ")).toContain("XFA");
    expect(r.report.mode).toBe("incremental");
  });

  it("leaves a hybrid form's XFA alone when nothing in the form changed", async () => {
    const r = await savePdf({ source: await withXfa(true), state: state({}) });
    expect(xfaKind(await PDFDocument.load(r.bytes))).toBe("hybrid");
  });

  it("never touches a dynamic XFA form", async () => {
    const r = await savePdf({ source: await withXfa(false), state: state({ nom: "x" }) });
    expect(xfaKind(await PDFDocument.load(r.bytes))).toBe("dynamic");
  });
});
