/**
 * Entry point for the PDF module.
 *
 * The whole workspace lives in `ui/PdfWorkspace`; this file stays as the lazy
 * import boundary the app already knows about, so pdf.js, pdf-lib and the OCR
 * engine never enter the main bundle.
 */
export { default } from "./ui/PdfWorkspace";
export type { PdfFile } from "./model/persist";
