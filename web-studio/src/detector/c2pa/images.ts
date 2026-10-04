import type { ImageModel } from "../types";
import { verifyC2pa, type C2paReport } from "./verify";

/** Vérifie le manifeste C2PA de chaque image ; une erreur inattendue vaut « non vérifié », jamais un crash. */
export async function verifyImagesC2pa(images: ImageModel[], signal?: AbortSignal): Promise<Map<number, C2paReport>> {
  const out = new Map<number, C2paReport>();
  for (const image of images) {
    if (signal?.aborted) throw new DOMException("Analyse annulée", "AbortError");
    try {
      const report = await verifyC2pa(image.bytes);
      if (report.status !== "absent") out.set(image.index, report);
    } catch {
      // Image illisible : l'analyse par octets bruts prend le relais.
    }
  }
  return out;
}
