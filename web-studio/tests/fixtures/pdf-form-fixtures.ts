/**
 * Form PDFs built on the fly for the form tests (Vitest and Playwright alike):
 * what the real forms users fill carry — Acrobat JavaScript (AFNumber_*,
 * AFSimple_Calculate, AFRange_Validate) with a calculation order (/CO), a
 * required field, a dropdown whose export values differ from its labels.
 */

import { PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, StandardFonts } from "pdf-lib";
import type { PDFField } from "pdf-lib";

function js(doc: PDFDocument, code: string): PDFDict {
  return doc.context.obj({ S: "JavaScript", JS: PDFHexString.fromText(code) }) as PDFDict;
}

function setActions(doc: PDFDocument, field: PDFField, aa: Record<string, string>): void {
  const dict = doc.context.obj({}) as PDFDict;
  for (const [k, code] of Object.entries(aa)) dict.set(PDFName.of(k), doc.context.register(js(doc, code)));
  field.acroField.dict.set(PDFName.of("AA"), dict);
}

function setFlag(field: PDFField, bit: number): void {
  const ff = field.acroField.dict.lookup(PDFName.of("Ff"));
  const cur = ff instanceof PDFNumber ? ff.asNumber() : 0;
  field.acroField.dict.set(PDFName.of("Ff"), PDFNumber.of(cur | bit));
}

/**
 * An order form: `qte` × `prix` = `total` (calculated, formatted « 1.234,56 € »),
 * `qte` limited to 0…100, `nom` required, `pays` with export ≠ label.
 */
export async function orderFormPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([400, 400]);
  const form = doc.getForm();
  page.drawText("Bon de commande", { x: 20, y: 370, size: 14, font });

  const nom = form.createTextField("nom");
  nom.addToPage(page, { x: 120, y: 320, width: 200, height: 22, font });
  setFlag(nom, 1 << 1); // Required

  const qte = form.createTextField("qte");
  qte.addToPage(page, { x: 120, y: 280, width: 80, height: 22, font });
  setActions(doc, qte, {
    K: 'AFNumber_Keystroke(0, 0, 0, 0, "", true);',
    F: 'AFNumber_Format(0, 0, 0, 0, "", true);',
    V: "AFRange_Validate(true, 0, true, 100);",
  });

  const prix = form.createTextField("prix");
  prix.addToPage(page, { x: 120, y: 240, width: 80, height: 22, font });
  setActions(doc, prix, {
    K: 'AFNumber_Keystroke(2, 0, 0, 0, "", true);',
    F: 'AFNumber_Format(2, 0, 0, 0, "", true);',
  });

  const total = form.createTextField("total");
  total.addToPage(page, { x: 120, y: 200, width: 120, height: 22, font });
  total.enableReadOnly();
  setActions(doc, total, {
    C: 'AFSimple_Calculate("PRD", new Array("qte", "prix"));',
    F: 'AFNumber_Format(2, 2, 0, 0, " €", false);',
  });

  const pays = form.createDropdown("pays");
  pays.addToPage(page, { x: 120, y: 160, width: 160, height: 22, font });
  pays.acroField.dict.set(
    PDFName.of("Opt"),
    doc.context.obj([
      [PDFHexString.fromText("FR"), PDFHexString.fromText("France")],
      [PDFHexString.fromText("CH"), PDFHexString.fromText("Suisse")],
    ]),
  );

  form.updateFieldAppearances(font);
  form.acroForm.dict.set(PDFName.of("CO"), doc.context.obj([total.ref]));
  return doc.save({ useObjectStreams: false, updateFieldAppearances: false });
}
