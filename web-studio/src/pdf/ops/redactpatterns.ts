/**
 * Search-and-redact patterns (Acrobat's « Rechercher du texte et le
 * caviarder » › motifs), French first. Each is a regular expression run on the
 * page text, and, when the format has one, a check (a key, Luhn) that keeps
 * only real numbers — and trims a match that ran into the next word.
 */

export interface RedactPattern {
  id: string;
  label: string;
  /** Regular expression source (the search adds the flags). */
  pattern: string;
  /** Match letters as written (IBAN: capitals only, so it does not run into the next word). */
  caseSensitive?: boolean;
  /**
   * The length of the valid part of a match (its start is kept), or 0 when
   * none is valid.
   */
  valid?: (match: string) => number;
}

const digits = (s: string) => s.replace(/[^0-9A-Za-z]/g, "");

/** Luhn checksum (cards, SIREN, SIRET). */
export function luhn(number: string): boolean {
  const d = number.replace(/\D/g, "");
  if (d.length < 9) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = d.charCodeAt(d.length - 1 - i) - 48;
    if (i % 2) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return sum % 10 === 0;
}

/** IBAN mod-97 check (ISO 13616). */
export function ibanValid(iban: string): boolean {
  const s = digits(iban).toUpperCase();
  if (s.length < 15 || s.length > 34 || !/^[A-Z]{2}\d{2}/.test(s)) return false;
  const moved = s.slice(4) + s.slice(0, 4);
  let rest = 0;
  for (const ch of moved) {
    const v = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
    for (const c of v) rest = (rest * 10 + (c.charCodeAt(0) - 48)) % 97;
  }
  return rest === 1;
}

/** French social security number (NIR) with its key; Corsica's 2A/2B count as 19/18. */
export function nirValid(nir: string): boolean {
  const s = nir.replace(/\s/g, "").toUpperCase();
  if (!/^[1-478]\d{4}(?:\d{2}|2A|2B)\d{8}$/.test(s)) return false;
  const body = s.slice(0, 13).replace("2A", "19").replace("2B", "18");
  const key = Number(s.slice(13));
  // 13 digits exceed 2^53 once multiplied: mod 97 by parts.
  const rest = Number(BigInt(body) % 97n);
  return 97 - rest === key;
}

/** The longest prefix (whole space-separated groups) that passes `check`: its length, or 0. */
function longestValid(match: string, check: (s: string) => boolean): number {
  let s = match.trimEnd();
  for (;;) {
    if (check(s)) return s.length;
    const cut = s.search(/[\s-]\S*$/);
    if (cut <= 0) return 0;
    s = s.slice(0, cut).trimEnd();
  }
}

const MONTHS = "janvier|f[ée]vrier|mars|avril|mai|juin|juillet|ao[uû]t|septembre|octobre|novembre|d[ée]cembre";

export const REDACT_PATTERNS: RedactPattern[] = [
  { id: "email", label: "Adresses e-mail", pattern: "[\\w.+-]+@[\\w-]+(?:\\.[\\w-]+)+" },
  {
    id: "phone",
    label: "Numéros de téléphone",
    // French (0x xx xx xx xx, +33 (0)x…), and international (+ or 00, then 6 to 14 digits).
    pattern:
      "(?:(?:\\+|00)33\\s?(?:\\(0\\)\\s?)?|\\b0)[1-9](?:[\\s.-]?\\d{2}){4}\\b|(?:\\+|\\b00)[1-9]\\d{0,2}(?:[\\s.-]?\\(?\\d{1,4}\\)?){2,5}\\b",
  },
  {
    id: "iban",
    label: "IBAN",
    pattern: "\\b[A-Z]{2}\\d{2}(?:\\s?[A-Z0-9]){11,30}\\b",
    caseSensitive: true,
    valid: (m) => longestValid(m, ibanValid),
  },
  {
    id: "card",
    label: "Cartes bancaires",
    pattern: "\\b(?:\\d[ -]?){12,18}\\d\\b",
    valid: (m) => longestValid(m, (s) => s.replace(/\D/g, "").length >= 13 && luhn(s)),
  },
  {
    id: "nir",
    label: "Numéros de sécurité sociale",
    pattern: "\\b[1-478]\\s?\\d{2}\\s?\\d{2}\\s?(?:\\d{2}|2[AB])\\s?\\d{3}\\s?\\d{3}\\s?\\d{2}\\b",
    valid: (m) => (nirValid(m) ? m.length : 0),
  },
  {
    id: "siret",
    label: "SIRET / SIREN",
    pattern: "\\b\\d{3}\\s?\\d{3}\\s?\\d{3}(?:\\s?\\d{5})?\\b",
    valid: (m) => (luhn(m) ? m.length : 0),
  },
  {
    id: "date",
    label: "Dates",
    pattern: `\\b(?:(?:0?[1-9]|[12]\\d|3[01])[/.-](?:0?[1-9]|1[0-2])[/.-](?:\\d{4}|\\d{2})|(?:1er|[12]?\\d|3[01])\\s(?:${MONTHS})\\s\\d{4})\\b`,
  },
];
