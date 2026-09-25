import { readFileSync, writeFileSync } from "node:fs";
import { PDFDocument, StandardFonts, rgb, PDFName, PDFString, PDFArray, PDFNumber } from "pdf-lib";
import { protectDocument, ALL_PERMISSIONS } from "C:/Users/ludov/Downloads/elium-main/elium-main/web-studio/src/pdf/ops/security.ts";
const H = process.argv[2];
async function form() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const p = doc.addPage([595, 842]);
  p.drawText("Formulaire de demande — CERFA de test", { x: 50, y: 790, size: 18, font });
  const f = doc.getForm();
  const labels = ["Nom", "Prénom", "Adresse", "Code postal", "Ville", "Courriel"];
  labels.forEach((l, i) => {
    p.drawText(l + " :", { x: 50, y: 740 - i * 40, size: 11, font });
    const t = f.createTextField("identite." + l.toLowerCase().replace(/\s/g, "_"));
    t.addToPage(p, { x: 160, y: 732 - i * 40, width: 360, height: 22 });
  });
  const multi = f.createTextField("motif"); multi.enableMultiline();
  p.drawText("Motif :", { x: 50, y: 480, size: 11, font }); multi.addToPage(p, { x: 160, y: 400, width: 360, height: 90 });
  const cb = f.createCheckBox("accepte_cgu"); cb.addToPage(p, { x: 160, y: 360, width: 16, height: 16 }); p.drawText("J'accepte les conditions", { x: 182, y: 363, size: 11, font });
  const rg = f.createRadioGroup("civilite");
  ["Madame", "Monsieur", "Autre"].forEach((o, i) => { rg.addOptionToPage(o, p, { x: 160 + i * 110, y: 320, width: 14, height: 14 }); p.drawText(o, { x: 180 + i * 110, y: 322, size: 11, font }); });
  const dd = f.createDropdown("departement"); dd.addOptions(["69 — Rhône", "75 — Paris", "13 — Bouches-du-Rhône"]); dd.addToPage(p, { x: 160, y: 270, width: 200, height: 22 });
  const ol = f.createOptionList("langues"); ol.addOptions(["Français", "Anglais", "Espagnol", "Allemand"]); ol.enableMultiselect(); ol.addToPage(p, { x: 160, y: 180, width: 200, height: 70 });
  p.drawText("Date (JJ/MM/AAAA) :", { x: 50, y: 140, size: 11, font });
  const d = f.createTextField("date"); d.addToPage(p, { x: 160, y: 132, width: 120, height: 22 });
  // Champ signature (vide) brut
  const sigDict = doc.context.obj({ FT: "Sig", T: PDFString.of("signature_demandeur"), Type: "Annot", Subtype: "Widget", Rect: [300, 60, 540, 120], F: 4, P: p.ref });
  const sigRef = doc.context.register(sigDict);
  p.node.addAnnot(sigRef);
  (f.acroForm.dict.lookup(PDFName.of("Fields")) as PDFArray).push(sigRef);
  writeFileSync(`${H}/corpus/form-acro.pdf`, await doc.save());
}
async function annotated() {
  const src = readFileSync(`${H}/corpus/word-contrat.pdf`);
  const doc = await PDFDocument.load(src);
  const p = doc.getPage(0);
  const { height } = p.getSize();
  const ctx = doc.context;
  const add = (o: Record<string, unknown>) => { const r = ctx.register(ctx.obj(o as never)); p.node.addAnnot(r); return r; };
  add({ Type: "Annot", Subtype: "Highlight", Rect: [70, height - 200, 400, height - 185], QuadPoints: [70, height - 185, 400, height - 185, 70, height - 200, 400, height - 200], C: [1, 1, 0], CA: 0.5, T: PDFString.of("Relecteur"), Contents: PDFString.of("À vérifier avec le service juridique"), M: PDFString.of("D:20260920101010+02'00'") });
  const note = add({ Type: "Annot", Subtype: "Text", Rect: [520, height - 120, 544, height - 96], C: [0.2, 0.5, 1], Name: "Comment", T: PDFString.of("Alice"), Contents: PDFString.of("Pourquoi 10 000 € ?"), Open: false });
  add({ Type: "Annot", Subtype: "Text", Rect: [520, height - 120, 544, height - 96], IRT: note, T: PDFString.of("Bob"), Contents: PDFString.of("C'est le capital social."), Name: "Comment" });
  add({ Type: "Annot", Subtype: "FreeText", Rect: [300, 80, 540, 120], DA: PDFString.of("/Helv 12 Tf 1 0 0 rg"), Contents: PDFString.of("Texte libre ajouté par un tiers"), T: PDFString.of("Carol") });
  add({ Type: "Annot", Subtype: "Ink", Rect: [100, 100, 250, 180], InkList: [[100, 100, 130, 170, 170, 110, 210, 175, 250, 100]], C: [1, 0, 0], BS: { W: 2 }, T: PDFString.of("Dan") });
  add({ Type: "Annot", Subtype: "Square", Rect: [60, 300, 260, 380], C: [0, 0.6, 0], BS: { W: 3 }, T: PDFString.of("Eve"), Contents: PDFString.of("Zone importante") });
  add({ Type: "Annot", Subtype: "StrikeOut", Rect: [70, height - 260, 300, height - 245], QuadPoints: [70, height - 245, 300, height - 245, 70, height - 260, 300, height - 260], C: [1, 0, 0], T: PDFString.of("Relecteur") });
  add({ Type: "Annot", Subtype: "Link", Rect: [70, 40, 200, 60], Border: [0, 0, 1], A: { S: "URI", URI: PDFString.of("https://example.com") } });
  writeFileSync(`${H}/corpus/annotated.pdf`, await doc.save({ useObjectStreams: false }));
}
async function encrypted() {
  const doc = await PDFDocument.load(readFileSync(`${H}/corpus/word-contrat.pdf`));
  const out = await protectDocument(doc, { userPassword: "test", ownerPassword: "owner", permissions: ALL_PERMISSIONS } as never);
  writeFileSync(`${H}/corpus/encrypted-aes256-pwd-test.pdf`, out);
  const doc2 = await PDFDocument.load(readFileSync(`${H}/corpus/edge-web.pdf`));
  const out2 = await protectDocument(doc2, { userPassword: "", ownerPassword: "owner", permissions: { ...ALL_PERMISSIONS, print: false, modify: false, copy: false } } as never);
  writeFileSync(`${H}/corpus/encrypted-owner-only.pdf`, out2);
}
await form(); await annotated(); await encrypted().catch((e) => console.error("encrypt failed", e));
console.log("forms ok");
