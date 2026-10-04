/**
 * Internationalisation d'Elium — sans dépendance.
 *
 *   import { t, tn, useI18n } from "../i18n";
 *   t("common.cancel")                      // chaîne simple
 *   t("workspace.moved", { name: "A" })     // « {name} » interpolé
 *   tn("workspace.items_selected", 3)       // pluriel (clés `_one` / `_other`)
 *   const { t, fmt } = useI18n();           // dans un composant : se met à jour au changement de langue
 *
 * Le FRANÇAIS (`messages/fr/*`) est la source de vérité : une clé s'y déclare
 * d'abord ; l'anglais (`messages/en/*`) est typé pour être complet (le compilateur
 * ET tests/i18n.test.ts échouent s'il manque une clé). Chemin incrémental pour
 * traduire un module : voir docs/ dans la documentation intégrée, section
 * « Langue de l'interface ».
 */
import { useSyncExternalStore } from "react";
import {
  DEFAULT_LOCALE,
  LOCALE_TAGS,
  createTranslator,
  formatBytes,
  formatDate,
  formatDateTime,
  formatList,
  formatNumber,
  formatRelative,
  isLocale,
  type Locale,
  type Params,
} from "./core";
import { catalogs, type MessageKey, type PluralKey } from "./catalog";

export type { Locale, MessageKey, PluralKey };
export { LOCALES, LOCALE_TAGS } from "./core";

const STORAGE_KEY = "elium_locale";

function readStored(): Locale {
  try {
    const v = typeof localStorage === "undefined" ? null : localStorage.getItem(STORAGE_KEY);
    return isLocale(v) ? v : DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
}

let current: Locale = readStored();
const listeners = new Set<() => void>();

function applyDocumentLang(l: Locale) {
  if (typeof document !== "undefined") document.documentElement.lang = l;
}
applyDocumentLang(current);

export function getLocale(): Locale {
  return current;
}

/** Change la langue de l'interface et la mémorise (réglages). */
export function setLocale(l: Locale): void {
  if (l === current) return;
  current = l;
  try {
    localStorage.setItem(STORAGE_KEY, l);
  } catch {
    /* stockage indisponible : la langue ne survivra pas au rechargement */
  }
  applyDocumentLang(l);
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Étiquette Intl de la langue active (« fr-FR » / « en-GB ») — remplace les « fr-FR » codés en dur. */
export function localeTag(): string {
  return LOCALE_TAGS[current];
}

export function t(key: MessageKey, params?: Params): string {
  return createTranslator(current, catalogs).t(key, params);
}

export function tn(key: PluralKey, n: number, params?: Params): string {
  return createTranslator(current, catalogs).tn(key, n, params);
}

/** Formats liés à la langue active. */
export const fmt = {
  number: (n: number, o?: Intl.NumberFormatOptions) => formatNumber(current, n, o),
  date: (d: Date | string | number, o?: Intl.DateTimeFormatOptions) => formatDate(current, d, o),
  dateTime: (d: Date | string | number) => formatDateTime(current, d),
  bytes: (n: number) => formatBytes(current, n),
  relative: (d: Date | string | number, now?: Date) => formatRelative(current, d, now),
  list: (items: string[]) => formatList(current, items),
};

/** Hook : renvoie `t`, `tn`, `fmt` et la langue ; le composant se redessine quand la langue change. */
export function useI18n() {
  const locale = useSyncExternalStore(subscribe, getLocale, getLocale);
  const tr = createTranslator(locale, catalogs);
  return {
    locale,
    t: (key: MessageKey, params?: Params) => tr.t(key, params),
    tn: (key: PluralKey, n: number, params?: Params) => tr.tn(key, n, params),
    fmt: {
      number: (n: number, o?: Intl.NumberFormatOptions) => formatNumber(locale, n, o),
      date: (d: Date | string | number, o?: Intl.DateTimeFormatOptions) => formatDate(locale, d, o),
      dateTime: (d: Date | string | number) => formatDateTime(locale, d),
      bytes: (n: number) => formatBytes(locale, n),
      relative: (d: Date | string | number, now?: Date) => formatRelative(locale, d, now),
      list: (items: string[]) => formatList(locale, items),
    },
  };
}
