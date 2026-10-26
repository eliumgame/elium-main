/** Points d'entrée PDF du passeport : fiche d'analyse, document synoptique, dossier complet. */
import type { SynopticOptions } from "../exportPasseport";
import { spLabel } from "../model";
import type { Holder, PassportData, Situation } from "../types";
import { drawFiche } from "./pdfFiche";
import { loadCarlito, newDoc, type FontBytes } from "./pdfKit";
import { appendAnnexes } from "./pdfAnnexes";
import { drawSynoptic } from "./pdfSynoptic";

export { buildFichePdf } from "./pdfFiche";
export { buildSynopticPdf } from "./pdfSynoptic";
export { buildAttestationPdf } from "./pdfAttestation";
export { buildContextePdf } from "./pdfContexte";
export { buildDossierE51Pdf } from "./pdfDossierE51";
export { loadCarlito, type FontBytes };

/** Passeport synoptique + fiches d'analyse (validées, ou toutes) dans un seul PDF. */
export async function buildDossierPdf(
  data: PassportData,
  fontBytes: FontBytes | null,
  opts: SynopticOptions & { onlyValidated?: boolean; annexes?: Map<string, Uint8Array> } = {},
): Promise<Uint8Array> {
  const { doc, fonts } = await newDoc(fontBytes);
  doc.setTitle(`Dossier E4 — ${data.holder.prenom} ${data.holder.nom}`.trim());
  doc.setProducer("Elium");
  drawSynoptic(doc, fonts, data, opts);
  const sits: Situation[] = [...data.situations]
    .filter((s) => !opts.onlyValidated || s.transfer)
    .sort((a, b) => a.id - b.id);
  const h: Holder = data.holder;
  for (const s of sits) {
    drawFiche(doc, fonts, h, s);
    if (opts.annexes && s.annexes.length)
      await appendAnnexes(
        doc,
        fonts,
        `Fiche ${spLabel(s.id)}${s.intitule.trim() ? ` — ${s.intitule.trim()}` : ""}`,
        s.annexes,
        (id) => opts.annexes!.get(id),
      );
  }
  return doc.save();
}

export async function loadFonts(): Promise<FontBytes | null> {
  return loadCarlito();
}
