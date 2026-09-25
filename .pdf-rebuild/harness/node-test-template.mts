// Gabarit : script Node (tsx) qui exerce le code PDF de production directement.
// Lancer depuis CE dossier : npx tsx <script>.ts   (node_modules = jonction vers web-studio)
import "./ws/tests/pdfjs-node-shim.ts"; // DOIT être le 1er import si PdfEngine est atteint
import { readFileSync, writeFileSync } from "node:fs";
import { PDFDocument } from "pdf-lib";
import { buildPdf } from "./ws/src/pdf/ops/save.ts";
import * as D from "./ws/src/pdf/model/doc.ts";
const CORPUS = "C:/Users/ludov/AppData/Local/Temp/claude/C--Users-ludov-Downloads-elium-main/72cb6376-9846-4238-a19b-d350714b8a76/scratchpad/harness/corpus";
const src = new Uint8Array(readFileSync(`${CORPUS}/word-contrat.pdf`));
console.log((await PDFDocument.load(src)).getPageCount());
