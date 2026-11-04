/**
 * Base de comparaison d'une demande de signature par lien : l'empreinte de contenu (`contentHash`) du
 * document AU MOMENT de l'envoi. Signer n'ajoute que des signatures : le contenu, lui, ne doit pas bouger.
 * Un signataire malveillant (ou un lien détourné) peut pourtant déposer un tout autre fichier signé ;
 * à la réception, l'émetteur compare donc l'empreinte du document revenu à celle d'origine.
 *
 * L'empreinte est mémorisée localement (navigateur de l'émetteur) : elle n'a pas besoin d'être secrète,
 * seulement de ne pas dépendre du serveur ni du signataire.
 */
import type { EliumFile } from "../format/types";

const KEY = "elium.drive.signBaseline.v1";
const MAX = 200;

function read(): Record<string, string> {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}") as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** Mémorise l'empreinte de base d'une demande (nœud + demande). Silencieux si le stockage est indisponible. */
export function saveSignBaseline(nodeId: string, requestId: string, contentHash: string | null | undefined): void {
  if (!contentHash) return;
  try {
    const all = read();
    all[`${nodeId}:${requestId}`] = contentHash.toLowerCase();
    const keys = Object.keys(all);
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX))) delete all[k];
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* stockage indisponible : pas de comparaison possible, jamais bloquant */
  }
}

export function getSignBaseline(nodeId: string, requestId: string): string | null {
  const v = read()[`${nodeId}:${requestId}`];
  return typeof v === "string" ? v : null;
}

export type SignedContentVerdict = "unchanged" | "modified" | "unknown";

/** Le document revenu a-t-il le même contenu que celui envoyé ? `unknown` si on n'a pas d'empreinte de base. */
export function compareSignedContent(
  baselineHash: string | null | undefined,
  signed: Pick<EliumFile, "manifest"> | null | undefined,
): SignedContentVerdict {
  const now = signed?.manifest?.integrity?.contentHash;
  if (!baselineHash || typeof now !== "string") return "unknown";
  return now.toLowerCase() === baselineHash.toLowerCase() ? "unchanged" : "modified";
}

export const SIGNED_CONTENT_MODIFIED_MESSAGE =
  "Contenu modifié par le signataire : l'empreinte du document signé diffère de celle du document envoyé. N'acceptez pas cette signature avant d'avoir comparé les deux versions.";
