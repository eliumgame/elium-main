/**
 * Éléments audio/vidéo des présentations (logique PURE) : validation d'un fichier, construction de
 * l'élément, bornes de rognage (début/fin), fragment de lecture `#t=début,fin`, extension de fichier
 * pour l'export PPTX. Le média est embarqué en data URL dans le document : lecture 100 % hors ligne.
 */
import { newElementId, type MediaData, type SlideElement } from "./model";

/** Au-delà, le document devient ingérable (chiffrement, synchronisation, mémoire). */
export const MAX_MEDIA_BYTES = 40 * 1024 * 1024;

const VIDEO = new Set(["video/mp4", "video/webm", "video/ogg", "video/quicktime", "video/x-m4v"]);
const AUDIO = new Set([
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "audio/x-m4a",
  "audio/aac",
  "audio/wav",
  "audio/x-wav",
  "audio/webm",
  "audio/ogg",
  "audio/flac",
]);

export const MEDIA_ACCEPT =
  "audio/*,video/mp4,video/webm,video/ogg,.mp4,.m4v,.webm,.ogv,.mp3,.m4a,.wav,.ogg,.aac,.flac";

export function mediaKindOf(mime: string, filename = ""): "audio" | "video" | null {
  const m = mime.toLowerCase();
  if (VIDEO.has(m)) return "video";
  if (AUDIO.has(m)) return "audio";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("audio/")) return "audio";
  // type MIME absent (certains navigateurs) : on se fie à l'extension
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  if (["mp4", "m4v", "webm", "ogv", "mov"].includes(ext)) return "video";
  if (["mp3", "m4a", "wav", "ogg", "oga", "aac", "flac"].includes(ext)) return "audio";
  return null;
}

/** Erreur lisible (français) si le fichier ne peut pas être inséré, sinon null. */
export function validateMediaFile(file: { name: string; type: string; size: number }): string | null {
  if (!mediaKindOf(file.type, file.name))
    return "Format non pris en charge : choisissez un fichier audio (MP3, M4A, WAV, OGG) ou vidéo (MP4, WebM).";
  if (file.size > MAX_MEDIA_BYTES)
    return `Fichier trop volumineux (${Math.round(file.size / 1048576)} Mo) : la limite est de ${Math.round(MAX_MEDIA_BYTES / 1048576)} Mo pour rester utilisable hors ligne et chiffré.`;
  if (file.size === 0) return "Le fichier est vide.";
  return null;
}

export function newMediaElement(m: MediaData): SlideElement {
  const audio = m.kind === "audio";
  return {
    id: newElementId(),
    type: "media",
    x: audio ? 30 : 20,
    y: audio ? 42 : 18,
    w: audio ? 40 : 60,
    h: audio ? 12 : 60,
    rotation: 0,
    opacity: 1,
    media: m,
  };
}

/** Rogne en restant cohérent : début ≥ 0, fin 0 (= jusqu'à la fin) ou > début, bornée par la durée connue. */
export function clampTrim(
  start: number | undefined,
  end: number | undefined,
  duration?: number,
): { trimStart: number; trimEnd: number } {
  const dur = duration && Number.isFinite(duration) && duration > 0 ? duration : Infinity;
  let s = Number.isFinite(start) ? Math.max(0, start as number) : 0;
  let e = Number.isFinite(end) ? Math.max(0, end as number) : 0;
  s = Math.min(s, Number.isFinite(dur) ? Math.max(0, dur - 0.1) : s);
  if (e > 0) {
    e = Math.min(e, dur);
    if (e <= s) e = 0;
  }
  return { trimStart: Math.round(s * 100) / 100, trimEnd: Math.round(e * 100) / 100 };
}

/** Source de lecture avec fragment média (`#t=début,fin`) : le navigateur applique le rognage tout seul. */
export function playbackSrc(m: MediaData): string {
  const s = m.trimStart && m.trimStart > 0 ? m.trimStart : 0;
  const e = m.trimEnd && m.trimEnd > s ? m.trimEnd : 0;
  if (!s && !e) return m.src;
  const base = m.src.split("#")[0]!;
  return `${base}#t=${s}${e ? `,${e}` : ""}`;
}

/** « 1:05 » / « 0:07,5 » pour l'interface. */
export function formatTime(sec: number): string {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  const rs = Number.isInteger(r) ? String(r).padStart(2, "0") : r.toFixed(1).replace(".", ",").padStart(4, "0");
  return `${m}:${rs}`;
}

/** Extension de fichier pour l'export PPTX (et type de contenu associé). */
export function mediaExt(mime: string): { ext: string; contentType: string } {
  const m = mime.toLowerCase();
  const table: Record<string, string> = {
    "video/mp4": "mp4",
    "video/x-m4v": "m4v",
    "video/quicktime": "mov",
    "video/webm": "webm",
    "video/ogg": "ogv",
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/mp4": "m4a",
    "audio/x-m4a": "m4a",
    "audio/aac": "aac",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/webm": "weba",
    "audio/ogg": "oga",
    "audio/flac": "flac",
  };
  return { ext: table[m] ?? (m.startsWith("video/") ? "mp4" : "mp3"), contentType: m };
}

/** MIME à partir de l'extension d'un fichier du paquet PPTX. */
export function mimeFromExt(ext: string): string {
  const e = ext.toLowerCase();
  const table: Record<string, string> = {
    mp4: "video/mp4",
    m4v: "video/x-m4v",
    mov: "video/quicktime",
    webm: "video/webm",
    ogv: "video/ogg",
    mp3: "audio/mpeg",
    m4a: "audio/mp4",
    aac: "audio/aac",
    wav: "audio/wav",
    weba: "audio/webm",
    oga: "audio/ogg",
    ogg: "audio/ogg",
    flac: "audio/flac",
  };
  return table[e] ?? "application/octet-stream";
}
