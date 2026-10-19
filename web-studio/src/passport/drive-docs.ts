/**
 * Publie dans le Drive entreprise les VRAIS documents du passeport (PDF et Word), et non le seul JSON de
 * sauvegarde : un dossier « Passeport E4 — Nom Prénom » à la racine contient le passeport synoptique, chaque
 * fiche d'analyse de situation et le dossier complet. Chaque réécriture crée une nouvelle version du fichier
 * (le serveur garde l'historique) ; les fichiers sont chiffrés de bout en bout comme tout le reste du Drive.
 */
import { ensureRootFolder, pushNamedFile } from "../drive-cloud/named-file";
import type { OpsCtx } from "../drive-cloud/ops";
import { buildFicheDocx } from "./exportFiche";
import { buildSynopticDocx } from "./exportPasseport";
import { spLabel } from "./model";
import { buildDossierPdf, buildFichePdf, buildSynopticPdf, loadFonts } from "./pdf";
import type { PassportData, Situation } from "./types";

const PDF = "application/pdf";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** Nom de fichier sûr (Drive : tout est permis, mais on évite les séparateurs et les caractères de contrôle). */
const clean = (s: string) =>
  s
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export function whoLabel(data: Pick<PassportData, "holder">): string {
  return clean(`${data.holder.nom.toUpperCase()} ${data.holder.prenom}`) || "Candidat";
}

export const docsFolderName = (data: Pick<PassportData, "holder">): string => `Passeport E4 — ${whoLabel(data)}`;

export interface DocToPublish {
  name: string;
  mime: string;
  slot: string;
  build: () => Promise<Uint8Array>;
}

/** Liste des documents à publier (sans les construire : `build` est appelé à l'envoi). */
export function docsToPublish(data: PassportData, fonts: Awaited<ReturnType<typeof loadFonts>>): DocToPublish[] {
  const who = whoLabel(data);
  const sits = [...data.situations].sort((a, b) => a.id - b.id);
  const fiche = (s: Situation) =>
    clean(`Fiche d'analyse ${spLabel(s.id)}${s.intitule.trim() ? ` — ${s.intitule.trim().slice(0, 60)}` : ""}`);
  const out: DocToPublish[] = [
    {
      name: `Passeport professionnel — ${who}.pdf`,
      mime: PDF,
      slot: "pp-syn-pdf",
      build: () => buildSynopticPdf(data, fonts),
    },
    {
      name: `Passeport professionnel — ${who}.docx`,
      mime: DOCX,
      slot: "pp-syn-docx",
      build: async () => buildSynopticDocx(data),
    },
    {
      name: `Dossier E4 complet — ${who}.pdf`,
      mime: PDF,
      slot: "pp-dossier",
      build: () => buildDossierPdf(data, fonts, { onlyValidated: false }),
    },
  ];
  for (const s of sits) {
    out.push({
      name: `${fiche(s)}.pdf`,
      mime: PDF,
      slot: `pp-sp${s.id}-pdf`,
      build: () => buildFichePdf(data.holder, s, fonts),
    });
    out.push({
      name: `${fiche(s)}.docx`,
      mime: DOCX,
      slot: `pp-sp${s.id}-docx`,
      build: async () => buildFicheDocx(data.holder, s),
    });
  }
  return out;
}

/**
 * Envoie tous les documents. Les liens locaux sont indexés par `slot` : un renommage de fiche écrit donc un NOUVEAU
 * fichier (l'ancien reste, à ranger à la main) plutôt que d'écraser un autre document.
 */
export async function publishPassportDocs(
  ctx: OpsCtx,
  data: PassportData,
  onProgress?: (done: number, total: number, name: string) => void,
): Promise<{ folder: string; count: number }> {
  const fonts = await loadFonts();
  const folderId = await ensureRootFolder(ctx, docsFolderName(data));
  const docs = docsToPublish(data, fonts);
  let done = 0;
  for (const d of docs) {
    onProgress?.(done, docs.length, d.name);
    await pushNamedFile(ctx, `${d.slot}:${folderId}:${d.name}`, d.name, await d.build(), {
      force: true, // fichiers produits par Elium : la dernière version fait foi
      mime: d.mime,
      parentId: folderId,
    });
    done++;
  }
  onProgress?.(done, docs.length, "");
  return { folder: docsFolderName(data), count: docs.length };
}
