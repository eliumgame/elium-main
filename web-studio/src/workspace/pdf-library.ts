/**
 * PDF de l'espace de travail : import dans la bibliothèque locale et
 * « destination d'enregistrement » qui réécrit le PDF dans la bibliothèque
 * (comme le module PDF écrit dans un fichier du disque ou dans le Drive).
 */
import type { VaultSecret } from "../crypto/local-vault";
import type { SaveDestination } from "../pdf/core/destination";
import { pdfStore } from "./pdf-store";
import type { WorkspaceApi } from "./useWorkspace";

const stripPdf = (name: string) => name.replace(/\.pdf$/i, "") || "Document PDF";

export function isPdfFile(file: File): boolean {
  return file.type === "application/pdf" || /\.pdf$/i.test(file.name);
}

/** Ajoute un PDF à la bibliothèque ; renvoie l'identifiant de l'élément. */
export async function importPdf(
  ws: WorkspaceApi,
  file: File,
  getSecret: () => VaultSecret | undefined,
): Promise<{ id: string; bytes: Uint8Array; name: string }> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const id = ws.service.newItemId();
  await pdfStore.put({ id, name: file.name, bytes }, getSecret());
  await ws.registerSaved({ id, kind: "pdf", title: stripPdf(file.name), size: bytes.length });
  return { id, bytes, name: file.name };
}

/** Destination « Enregistrer » qui réécrit le PDF de la bibliothèque, puis met à jour sa taille et sa date. */
export function libraryDestination(opts: {
  id: string;
  name: string;
  label: string;
  getSecret: () => VaultSecret | undefined;
  onSaved: (size: number) => void;
}): SaveDestination {
  return {
    kind: "drive", // destination persistante interne : même contrat que le Drive, sans fichier sur le disque
    name: opts.name,
    label: opts.label,
    persistent: true,
    async prepare() {
      return true;
    },
    async write(bytes) {
      await pdfStore.put({ id: opts.id, name: opts.name, bytes }, opts.getSecret());
      opts.onSaved(bytes.length);
    },
  };
}
