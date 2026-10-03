/**
 * Regenerates the pdf-lib and Chromium part of the « Modifier le texte »
 * corpus (tests/fixtures/textedit/); the Office part is made by
 * textedit-fixtures.py.
 *
 *   PW_CHROMIUM=/path/to/chromium node tests/support/textedit-fixtures.mjs
 *
 * - pdflib.pdf, page 1: Standard-14 fonts, not embedded (Helvetica, Times),
 *   a wrapped paragraph drawn line by line, a coloured line;
 *   page 2: an embedded Unicode face (Type0, Identity-H CID font).
 * - chromium.pdf: Chromium's `page.pdf()` (serif, sans, two columns);
 *   chromium-a4.pdf: a ragged Arial paragraph whose wrapped lines end alike.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import process from "node:process";
import { chromium } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "..", "fixtures", "textedit");
mkdirSync(OUT, { recursive: true });

/** Greedy wrap, for drawing a paragraph line by line as generators do. */
function wrap(font, text, size, width) {
  const out = [];
  let line = "";
  for (const w of text.split(" ")) {
    const cand = line ? `${line} ${w}` : w;
    if (line && font.widthOfTextAtSize(cand, size) > width) {
      out.push(line);
      line = w;
    } else line = cand;
  }
  if (line) out.push(line);
  return out;
}

const PARA =
  "Ce paragraphe est composé en Helvetica, une police standard que le fichier n'embarque pas : " +
  "le lecteur la fournit. Il occupe plusieurs lignes pour vérifier que le texte se recompose " +
  "correctement quand un mot est ajouté ou modifié.";

async function pdflib() {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const helvB = await doc.embedFont(StandardFonts.HelveticaBold);
  const times = await doc.embedFont(StandardFonts.TimesRoman);
  const p1 = doc.addPage([595, 842]);
  p1.drawText("Polices standard", { x: 60, y: 770, size: 20, font: helvB });
  wrap(helv, PARA, 11, 380).forEach((l, i) => p1.drawText(l, { x: 60, y: 730 - i * 14, size: 11, font: helv }));
  p1.drawText("Une ligne en bleu, seule.", { x: 60, y: 640, size: 11, font: helv, color: rgb(0.1, 0.3, 0.8) });
  wrap(times, PARA.replace("Helvetica", "Times"), 12, 360).forEach((l, i) =>
    p1.drawText(l, { x: 60, y: 600 - i * 15, size: 12, font: times }),
  );

  const ttf = readFileSync("/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf");
  const uni = await doc.embedFont(ttf, { subset: true });
  const p2 = doc.addPage([595, 842]);
  p2.drawText("Police CID (Identity-H)", { x: 60, y: 770, size: 18, font: uni });
  wrap(
    uni,
    PARA.replace(
      "Helvetica, une police standard que le fichier n'embarque pas : le lecteur la fournit",
      "Liberation Sans, embarquée en partie dans le fichier (Type0)",
    ),
    11,
    380,
  ).forEach((l, i) => p2.drawText(l, { x: 60, y: 735 - i * 14, size: 11, font: uni }));
  writeFileSync(join(OUT, "pdflib.pdf"), await doc.save());
}

async function chrome() {
  const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  const page = await browser.newPage();
  await page.setContent(`<html><body style="margin:40px;font-size:12px;line-height:1.4">
    <h1 style="font-family:'Liberation Serif',serif;font-size:22px;margin:0 0 8px">Rapport annuel</h1>
    <p style="font-family:'Liberation Serif',serif;margin:0 0 12px">Premier paragraphe du rapport, en police à empattements, sur plusieurs lignes pour vérifier le reflux du texte modifié dans sa zone et dans sa largeur d'origine, sans déborder.</p>
    <p style="font-family:'Liberation Sans',sans-serif;margin:0 0 12px">Second paragraphe, sans empattements, avec un mot <b>gras</b> et un mot <span style="color:#c00000">rouge</span> au milieu de la phrase, qui doivent garder leur style.</p>
    <div style="columns:2;column-gap:30px;font-family:'Liberation Sans',sans-serif;font-size:11px">
      <p style="margin:0 0 8px">Colonne gauche du document, assez longue pour occuper plusieurs lignes dans la colonne de gauche.</p>
      <p style="margin:0">Colonne droite, qui ne doit jamais être touchée quand on modifie la colonne gauche du document.</p>
    </div></body></html>`);
  writeFileSync(join(OUT, "chromium.pdf"), await page.pdf({ width: "595px", height: "420px" }));
  // A ragged paragraph whose two wrapped lines happen to end at the same place (it once read as justified).
  await page.setContent(`<html><body style="font-family:Arial,sans-serif;margin:40px">
    <h1 style="font-size:22px;margin:0 0 6px">Rapport annuel 2025</h1>
    <p style="font-size:12px;line-height:1.4;margin:0 0 12px">Premier paragraphe du rapport, sur plusieurs lignes pour vérifier le reflux du texte modifié dans sa zone et sa largeur d'origine, avec encore quelques mots pour faire trois lignes complètes.</p>
    <p style="font-size:12px;line-height:1.4;margin:0">Second paragraphe, plus court.</p></body></html>`);
  writeFileSync(join(OUT, "chromium-a4.pdf"), await page.pdf({ format: "A4" }));
  await browser.close();
}

await pdflib();
await chrome();
