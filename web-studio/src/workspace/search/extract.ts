/**
 * Lecture du contenu RÉEL d'un élément pour l'indexer (accès IndexedDB, lecture
 * de .elium, pdf.js). Tout ce qui est pur est dans text.ts.
 *
 * Un document .elium chiffré par son propre mot de passe n'est PAS lisible ici :
 * seul son titre est indexé (on ne demande jamais de mot de passe en arrière-plan).
 */
import type { VaultSecret } from "../../crypto/local-vault";
import { getDriveDoc } from "../../format/drive-store";
import { EliumPasswordRequired, EliumRecipientKeyRequired, readEliumPackage } from "../../format/elium-package";
import type { ProseMirrorNode } from "../../format/types";
import { sheetStore } from "../../sheet/sheet-store";
import { deckStore } from "../../slides/deck-store";
import type { Workbook } from "../../sheet/model";
import type { Deck } from "../../slides/model";
import { pdfStore } from "../pdf-store";
import type { WorkItem } from "../types";
import { capText, deckText, docText, sheetText } from "./text";

/** Texte d'un .elium d'après son contenu (document, ou tableur/présentation exporté dans un .elium). */
export async function eliumBytesText(bytes: Uint8Array): Promise<string> {
  try {
    const { file } = await readEliumPackage(bytes, {});
    const first: ProseMirrorNode | undefined = file.document.doc?.content?.[0];
    if (first && (first.type === "eliumSheet" || first.type === "eliumSlides")) {
      const data = JSON.parse(String(first.attrs?.data ?? "null")) as Workbook | Deck | null;
      if (!data) return "";
      return first.type === "eliumSheet" ? sheetText(data as Workbook) : deckText(data as Deck);
    }
    return docText(file.document.doc);
  } catch (e) {
    if (e instanceof EliumPasswordRequired || e instanceof EliumRecipientKeyRequired) return ""; // chiffré : titre seul
    throw e;
  }
}

/** Texte d'un PDF (pdf.js chargé à la demande). Un PDF protégé par mot de passe : titre seul. */
export async function pdfBytesText(bytes: Uint8Array): Promise<string> {
  const { PdfEngine, PdfPasswordRequired } = await import("../../pdf/core/engine");
  let engine: Awaited<ReturnType<typeof PdfEngine.open>> | null = null;
  try {
    engine = await PdfEngine.open(bytes);
    return capText((await engine.allText()).join("\n"));
  } catch (e) {
    if (e instanceof PdfPasswordRequired) return "";
    throw e;
  } finally {
    engine?.destroy();
  }
}

export async function extractItemText(item: WorkItem, secret: VaultSecret | undefined): Promise<string> {
  switch (item.contentStore) {
    case "drive": {
      const doc = await getDriveDoc(item.id, secret);
      return doc ? eliumBytesText(doc.bytes) : "";
    }
    case "sheets": {
      const wb = await sheetStore.load(item.id, secret);
      return wb ? sheetText(wb) : "";
    }
    case "slides": {
      const deck = await deckStore.load(item.id, secret);
      return deck ? deckText(deck) : "";
    }
    case "pdfs": {
      const pdf = await pdfStore.get(item.id, secret);
      return pdf ? pdfBytesText(pdf.bytes) : "";
    }
  }
}
