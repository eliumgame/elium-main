/**
 * Cœur PUR de l'internationalisation (aucune dépendance au navigateur) :
 * interpolation, pluriels et formats via Intl. Testé dans tests/i18n.test.ts.
 *
 * Convention des clés : `zone.sous_zone.nom`, en snake_case. Les pluriels se
 * déclarent par un couple `clé_one` / `clé_other` (catégories Intl.PluralRules) ;
 * on les appelle avec `tn("clé", n)`. Les paramètres s'écrivent `{nom}`.
 */

export type Locale = "fr" | "en";
export const LOCALES: Locale[] = ["fr", "en"];
export const DEFAULT_LOCALE: Locale = "fr";

/** Étiquette BCP-47 passée à Intl / toLocaleString pour chaque langue. */
export const LOCALE_TAGS: Record<Locale, string> = { fr: "fr-FR", en: "en-GB" };

export function isLocale(v: unknown): v is Locale {
  return v === "fr" || v === "en";
}

export type Params = Record<string, string | number>;

/** Remplace `{nom}` par la valeur du paramètre ; un paramètre absent reste visible (`{nom}`) pour être repéré. */
export function interpolate(template: string, params?: Params): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m));
}

/** Catégorie de pluriel Intl (« one » / « other »…) pour un nombre. */
export function pluralCategory(locale: Locale, n: number): Intl.LDMLPluralRule {
  return new Intl.PluralRules(LOCALE_TAGS[locale]).select(n);
}

export type Catalog = Record<string, string>;

export interface Translator {
  locale: Locale;
  t(key: string, params?: Params): string;
  /** Pluriel : cherche `key_<catégorie>` puis `key_other`. `{n}` est ajouté aux paramètres. */
  tn(key: string, n: number, params?: Params): string;
}

/**
 * Traducteur pour une langue. Clé manquante dans la langue → retombe sur le
 * français (source de vérité) ; manquante partout → renvoie la clé elle-même
 * (visible, jamais une chaîne vide).
 */
export function createTranslator(locale: Locale, catalogs: Record<Locale, Catalog>): Translator {
  const lookup = (key: string): string | undefined => catalogs[locale][key] ?? catalogs.fr[key];
  return {
    locale,
    t: (key, params) => interpolate(lookup(key) ?? key, params),
    tn(key, n, params) {
      const cat = pluralCategory(locale, n);
      const tpl = lookup(`${key}_${cat}`) ?? lookup(`${key}_other`) ?? key;
      return interpolate(tpl, { n: formatNumber(locale, n), ...params });
    },
  };
}

// --- Formats --------------------------------------------------------------

export function formatNumber(locale: Locale, n: number, opts?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(LOCALE_TAGS[locale], opts).format(n);
}

export function formatDate(locale: Locale, d: Date | string | number, opts?: Intl.DateTimeFormatOptions): string {
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(LOCALE_TAGS[locale], opts ?? { dateStyle: "medium" }).format(date);
}

export function formatDateTime(locale: Locale, d: Date | string | number): string {
  return formatDate(locale, d, { dateStyle: "medium", timeStyle: "short" });
}

const UNITS: Record<Locale, string[]> = {
  fr: ["o", "Ko", "Mo", "Go", "To"],
  en: ["B", "KB", "MB", "GB", "TB"],
};

/** 1 536 → « 1,5 Ko » (fr) / « 1.5 KB » (en). */
export function formatBytes(locale: Locale, bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < UNITS[locale].length - 1) {
    v /= 1024;
    i++;
  }
  const digits = i === 0 || v >= 10 ? 0 : 1;
  return `${formatNumber(locale, v, { maximumFractionDigits: digits, minimumFractionDigits: 0 })} ${UNITS[locale][i]}`;
}

/** « il y a 3 jours » / « 3 days ago » via Intl.RelativeTimeFormat. */
export function formatRelative(locale: Locale, d: Date | string | number, now: Date = new Date()): string {
  const date = d instanceof Date ? d : new Date(d);
  const diffSec = Math.round((date.getTime() - now.getTime()) / 1000);
  const rtf = new Intl.RelativeTimeFormat(LOCALE_TAGS[locale], { numeric: "auto" });
  const abs = Math.abs(diffSec);
  if (abs < 60) return rtf.format(diffSec, "second");
  if (abs < 3600) return rtf.format(Math.round(diffSec / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diffSec / 3600), "hour");
  if (abs < 86400 * 30) return rtf.format(Math.round(diffSec / 86400), "day");
  if (abs < 86400 * 365) return rtf.format(Math.round(diffSec / (86400 * 30)), "month");
  return rtf.format(Math.round(diffSec / (86400 * 365)), "year");
}

/** Liste « a, b et c » / « a, b and c ». */
export function formatList(locale: Locale, items: string[]): string {
  const LF = (Intl as unknown as { ListFormat?: new (l: string, o: object) => { format(i: string[]): string } })
    .ListFormat;
  return LF ? new LF(LOCALE_TAGS[locale], { style: "long", type: "conjunction" }).format(items) : items.join(", ");
}
