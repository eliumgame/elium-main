/**
 * Bates, en-têtes, pieds de page et filigrane en lot : les mêmes marques que
 * celles d'un document ouvert, appliquées à plusieurs fichiers d'un coup.
 * La numérotation Bates peut se poursuivre d'un fichier au suivant (le dernier
 * numéro de chacun est rapporté, pour le registre de production).
 */
import { PDFDocument } from "pdf-lib";
import { pagesFromSource } from "../model/doc";
import {
  DEFAULT_BATES,
  DEFAULT_WATERMARK,
  emptyBand,
  emptyState,
  type Bates,
  type HeaderFooter,
  type Watermark,
} from "../model/types";
import { batesLabel } from "./decorate";
import { buildPdf } from "./save";

export interface BatchMarksSpec {
  watermark: Watermark;
  header: HeaderFooter;
  footer: HeaderFooter;
  bates: Bates;
  /** Poursuit la numérotation Bates d'un fichier au suivant (sinon elle repart de `bates.start`). */
  continueBates: boolean;
}

export const DEFAULT_BATCH_MARKS: BatchMarksSpec = {
  watermark: { ...DEFAULT_WATERMARK },
  header: emptyBand(),
  footer: emptyBand(),
  bates: { ...DEFAULT_BATES },
  continueBates: true,
};

export interface BatchInput {
  name: string;
  bytes: Uint8Array;
}

export interface BatchOutput {
  name: string;
  bytes?: Uint8Array;
  /** Raison lisible quand le fichier n'a pas pu être traité. */
  error?: string;
  /** Premier et dernier numéros Bates de ce fichier. */
  bates?: { first: string; last: string };
  pages?: number;
}

/** Aucune marque activée : rien à faire (évite de réécrire les fichiers pour rien). */
export function hasAnyMark(spec: BatchMarksSpec): boolean {
  return spec.watermark.enabled || spec.header.enabled || spec.footer.enabled || spec.bates.enabled;
}

/** `scan.pdf` → `scan-marque.pdf` */
export function outputName(name: string): string {
  return name.replace(/\.pdf$/i, "") + "-marque.pdf";
}

export async function applyMarksToFiles(
  files: readonly BatchInput[],
  spec: BatchMarksSpec,
  opts: { onProgress?: (done: number, total: number, name: string) => void; signal?: AbortSignal } = {},
): Promise<BatchOutput[]> {
  const out: BatchOutput[] = [];
  let next = spec.bates.start;
  for (let i = 0; i < files.length; i++) {
    if (opts.signal?.aborted) break;
    const f = files[i]!;
    opts.onProgress?.(i, files.length, f.name);
    try {
      const doc = await PDFDocument.load(f.bytes, { ignoreEncryption: false, updateMetadata: false });
      const count = doc.getPageCount();
      const bates: Bates = { ...spec.bates, start: spec.continueBates ? next : spec.bates.start };
      const state = {
        ...emptyState(),
        pages: pagesFromSource(count),
        watermark: spec.watermark,
        header: spec.header,
        footer: spec.footer,
        bates,
      };
      const built = await buildPdf(f.bytes, state, { keepSkipped: true });
      const result: BatchOutput = { name: outputName(f.name), bytes: built.bytes, pages: count };
      if (bates.enabled) {
        const numbered = Math.max(0, count);
        result.bates = { first: batesLabel(bates, 0), last: batesLabel(bates, Math.max(0, numbered - 1)) };
        next = bates.start + numbered;
      }
      out.push(result);
    } catch (e) {
      const encrypted = e instanceof Error && /encrypt/i.test(e.message);
      out.push({
        name: f.name,
        error: encrypted
          ? "Fichier protégé par mot de passe : ouvrez-le individuellement."
          : e instanceof Error
            ? e.message
            : String(e),
      });
    }
    opts.onProgress?.(i + 1, files.length, f.name);
  }
  return out;
}

/** Registre de production (CSV) : fichier source, pages, plage Bates. */
export function batesRegister(inputs: readonly BatchInput[], outputs: readonly BatchOutput[]): string {
  const cell = (v: string | number | undefined) => {
    const s = v === undefined ? "" : String(v);
    const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    return /[;"\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const lines = ["Fichier;Fichier produit;Pages;Premier numéro;Dernier numéro;Remarque"];
  outputs.forEach((o, i) =>
    lines.push(
      [inputs[i]?.name, o.error ? "" : o.name, o.pages, o.bates?.first, o.bates?.last, o.error].map(cell).join(";"),
    ),
  );
  return "﻿" + lines.join("\r\n") + "\r\n";
}
