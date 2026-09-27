/**
 * The stamp library — Acrobat's « Standard Business » and « Dynamic » sets,
 * in French, plus the user's own picture stamps.
 *
 * `name` is the PDF `/Name` Acrobat gives the stamp, so another reader shows
 * the right label and a stamp read back from a file finds its entry again.
 * A dynamic stamp carries who and when, frozen when it is placed (as in
 * Acrobat: the date does not change afterwards).
 */

import type { Annot } from "./types";

export type StampTone = NonNullable<Annot["stampTone"]>;

export interface StampDef {
  id: string;
  /** PDF `/Name`. */
  name: string;
  label: string;
  tone: StampTone;
  /** Adds « par <auteur>, le <date heure> » on a second line. */
  dynamic?: boolean;
}

export const STANDARD_STAMPS: readonly StampDef[] = [
  { id: "approved", name: "Approved", label: "Approuvé", tone: "green" },
  { id: "notApproved", name: "NotApproved", label: "Non approuvé", tone: "red" },
  { id: "draft", name: "Draft", label: "Brouillon", tone: "blue" },
  { id: "final", name: "Final", label: "Final", tone: "green" },
  { id: "confidential", name: "Confidential", label: "Confidentiel", tone: "red" },
  { id: "forComment", name: "ForComment", label: "Pour commentaire", tone: "blue" },
  { id: "forPublicRelease", name: "ForPublicRelease", label: "Diffusion publique", tone: "green" },
  { id: "notForPublicRelease", name: "NotForPublicRelease", label: "Diffusion interne", tone: "orange" },
  { id: "expired", name: "Expired", label: "Expiré", tone: "red" },
  { id: "experimental", name: "Experimental", label: "Expérimental", tone: "blue" },
  { id: "asIs", name: "AsIs", label: "Tel quel", tone: "neutral" },
  { id: "departmental", name: "Departmental", label: "Service interne", tone: "neutral" },
  { id: "topSecret", name: "TopSecret", label: "Top secret", tone: "red" },
  { id: "sold", name: "Sold", label: "Vendu", tone: "green" },
];

export const DYNAMIC_STAMPS: readonly StampDef[] = [
  { id: "dynApproved", name: "#DApproved", label: "Approuvé", tone: "green", dynamic: true },
  { id: "dynReviewed", name: "#DReviewed", label: "Vérifié", tone: "blue", dynamic: true },
  { id: "dynReceived", name: "#DReceived", label: "Reçu", tone: "blue", dynamic: true },
  { id: "dynRevised", name: "#DRevised", label: "Révisé", tone: "orange", dynamic: true },
  { id: "dynConfidential", name: "#DConfidential", label: "Confidentiel", tone: "red", dynamic: true },
];

const ALL = [...STANDARD_STAMPS, ...DYNAMIC_STAMPS];

export function stampById(id: string | undefined): StampDef {
  return ALL.find((s) => s.id === id) ?? STANDARD_STAMPS[0];
}

/** The entry of a stamp read from a file, by its `/Name` (Acrobat's or ours). */
export function stampByName(name: string | undefined): StampDef | undefined {
  if (!name) return undefined;
  const bare = name.replace(/^#?D(?=[A-Z])/, "").replace(/^SB/, "");
  return ALL.find((s) => s.name === name) ?? STANDARD_STAMPS.find((s) => s.name === bare);
}

/** The second line of a dynamic stamp: « par Marie Dupont, le 25/09/2026 14:32 ». */
export function dynamicLine(author: string, when: Date): string {
  const d = when.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric" });
  const t = when.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  return author ? `par ${author}, le ${d} ${t}` : `le ${d} ${t}`;
}

/** The fields a new stamp annotation takes from its library entry. */
export function stampFields(def: StampDef, author: string, when: Date): Partial<Annot> {
  return {
    stampLabel: def.label,
    stampTone: def.tone,
    stampName: def.name,
    stampSub: def.dynamic ? dynamicLine(author, when) : undefined,
  };
}

// ---------------------------------------------------------------------------
// Picture stamps of the user (kept in this browser)
// ---------------------------------------------------------------------------

export interface CustomStamp {
  id: string;
  label: string;
  src: string;
  /** Height / width of the picture. */
  ratio: number;
}

const KEY = "elium.pdf.customStamps";
/** A picture stamp bigger than this is used once but not remembered. */
const MAX_REMEMBERED = 600_000;
const MAX_COUNT = 12;

export function loadCustomStamps(): CustomStamp[] {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as CustomStamp[]) : [];
    return Array.isArray(list) ? list.filter((s) => s && typeof s.src === "string" && s.id) : [];
  } catch {
    return [];
  }
}

/** Remember a picture stamp (most recent first); returns the new list. */
export function rememberCustomStamp(stamp: CustomStamp): CustomStamp[] {
  const list = [stamp, ...loadCustomStamps().filter((s) => s.src !== stamp.src)].slice(0, MAX_COUNT);
  if (stamp.src.length > MAX_REMEMBERED) return list.slice(1);
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // Storage full or blocked: the stamp still works for this placement.
  }
  return list;
}

export function forgetCustomStamp(id: string): CustomStamp[] {
  const list = loadCustomStamps().filter((s) => s.id !== id);
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* ignore */
  }
  return list;
}
