/**
 * Registre des raccourcis clavier personnalisables.
 *
 * Un raccourci s'écrit « Mod+Shift+K » : `Mod` = Ctrl (Windows/Linux) ou ⌘ (Mac),
 * puis Maj / Alt, puis UNE touche. Les réglages de l'utilisateur ne stockent
 * que les écarts au défaut (`elium_shortcuts`). Tout est pur (sauf lecture/
 * écriture localStorage en bas de fichier) : analyse, correspondance avec un
 * événement, détection de conflits, capture d'une combinaison.
 */
import { useSyncExternalStore } from "react";
import type { MessageKey } from "../i18n";

export type ShortcutId =
  | "palette"
  | "paletteGlobal"
  | "searchWorkspace"
  | "settings"
  | "goHome"
  | "newDocument"
  | "newSpreadsheet"
  | "newPresentation"
  | "openFile"
  | "save"
  | "saveAs";

export interface ShortcutDef {
  id: ShortcutId;
  labelKey: MessageKey;
  default: string;
}

export const SHORTCUTS: ShortcutDef[] = [
  { id: "palette", labelKey: "shortcut.palette", default: "Mod+K" },
  { id: "paletteGlobal", labelKey: "shortcut.paletteGlobal", default: "Mod+Shift+P" },
  { id: "searchWorkspace", labelKey: "shortcut.searchWorkspace", default: "Mod+Shift+F" },
  { id: "settings", labelKey: "shortcut.settings", default: "Mod+Comma" },
  { id: "goHome", labelKey: "shortcut.goHome", default: "Alt+H" },
  { id: "newDocument", labelKey: "shortcut.newDocument", default: "Alt+N" },
  { id: "newSpreadsheet", labelKey: "shortcut.newSpreadsheet", default: "Alt+Shift+N" },
  { id: "newPresentation", labelKey: "shortcut.newPresentation", default: "Alt+Shift+P" },
  { id: "openFile", labelKey: "shortcut.openFile", default: "Mod+O" },
  { id: "save", labelKey: "shortcut.save", default: "Mod+S" },
  { id: "saveAs", labelKey: "shortcut.saveAs", default: "Mod+Shift+S" },
];

export interface Binding {
  mod: boolean;
  shift: boolean;
  alt: boolean;
  /** Touche en minuscules : « k », « comma », « f5 », « delete »… */
  key: string;
}

const KEY_ALIASES: Record<string, string> = {
  ",": "comma",
  ".": "period",
  "/": "slash",
  "\\": "backslash",
  " ": "space",
  esc: "escape",
  del: "delete",
  return: "enter",
  arrowup: "up",
  arrowdown: "down",
  arrowleft: "left",
  arrowright: "right",
};
const MODIFIER_KEYS = new Set(["control", "shift", "alt", "meta", "altgraph", "os"]);

function normKey(k: string): string {
  const lower = k.toLowerCase();
  return KEY_ALIASES[lower] ?? lower;
}

export function parseBinding(s: string): Binding | null {
  const parts = s
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;
  const b: Binding = { mod: false, shift: false, alt: false, key: "" };
  for (const p of parts) {
    const l = p.toLowerCase();
    if (l === "mod" || l === "ctrl" || l === "cmd" || l === "meta") b.mod = true;
    else if (l === "shift") b.shift = true;
    else if (l === "alt" || l === "option") b.alt = true;
    else if (b.key === "") b.key = normKey(p);
    else return null; // deux touches : invalide
  }
  return b.key ? b : null;
}

/** Forme canonique (ordre Mod, Alt, Shift, touche) — deux écritures équivalentes donnent la même chaîne. */
export function canonical(b: Binding): string {
  return [
    b.mod ? "Mod" : "",
    b.alt ? "Alt" : "",
    b.shift ? "Shift" : "",
    b.key.length === 1 ? b.key.toUpperCase() : b.key.charAt(0).toUpperCase() + b.key.slice(1),
  ]
    .filter(Boolean)
    .join("+");
}

export interface KeyEventLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export function bindingFromEvent(e: KeyEventLike): Binding | null {
  if (MODIFIER_KEYS.has(e.key.toLowerCase())) return null;
  return { mod: e.ctrlKey || e.metaKey, shift: e.shiftKey, alt: e.altKey, key: normKey(e.key) };
}

export function matchesEvent(e: KeyEventLike, binding: string): boolean {
  const want = parseBinding(binding);
  const got = bindingFromEvent(e);
  if (!want || !got) return false;
  return want.mod === got.mod && want.alt === got.alt && want.shift === got.shift && want.key === got.key;
}

/**
 * Combinaison acceptable pour un raccourci : une touche de fonction seule, ou
 * au moins Ctrl/⌘ ou Alt (une lettre nue volerait la frappe du texte).
 */
export function isAcceptableBinding(b: Binding): boolean {
  if (/^f([1-9]|1[0-2])$/.test(b.key)) return true;
  return b.mod || b.alt;
}

/** Combinaisons réservées par le navigateur ou l'éditeur de texte : refusées. */
const RESERVED = new Set([
  "Mod+C",
  "Mod+V",
  "Mod+X",
  "Mod+Z",
  "Mod+Y",
  "Mod+A",
  "Mod+W",
  "Mod+T",
  "Mod+N",
  "Mod+R",
  "Mod+Q",
  "Mod+B",
  "Mod+I",
  "Mod+U",
  "Mod+P",
]);
export function isReserved(b: Binding): boolean {
  return RESERVED.has(canonical(b));
}

export function formatBinding(binding: string, mac = false): string {
  const b = parseBinding(binding);
  if (!b) return binding;
  const keyLabel: Record<string, string> = {
    comma: ",",
    period: ".",
    slash: "/",
    backslash: "\\",
    space: mac ? "␣" : "Espace",
    escape: "Échap",
    delete: mac ? "⌫" : "Suppr",
    enter: mac ? "↵" : "Entrée",
    up: "↑",
    down: "↓",
    left: "←",
    right: "→",
  };
  const k = keyLabel[b.key] ?? (b.key.length === 1 ? b.key.toUpperCase() : b.key.toUpperCase());
  if (mac) return `${b.alt ? "⌥" : ""}${b.shift ? "⇧" : ""}${b.mod ? "⌘" : ""}${k}`;
  return [b.mod ? "Ctrl" : "", b.alt ? "Alt" : "", b.shift ? "Maj" : "", k].filter(Boolean).join("+");
}

export type Overrides = Partial<Record<ShortcutId, string>>;

/** Liaisons effectives : défaut, sauf écart enregistré (chaîne vide = raccourci désactivé). */
export function resolveBindings(defs: ShortcutDef[], overrides: Overrides): Record<ShortcutId, string> {
  const out = {} as Record<ShortcutId, string>;
  for (const d of defs) {
    const o = overrides[d.id];
    out[d.id] = o !== undefined ? o : d.default;
  }
  return out;
}

/** Paires d'actions partageant la même combinaison. */
export function findConflicts(bindings: Record<string, string>): [string, string][] {
  const seen = new Map<string, string>();
  const out: [string, string][] = [];
  for (const [id, raw] of Object.entries(bindings)) {
    const b = raw ? parseBinding(raw) : null;
    if (!b) continue;
    const c = canonical(b);
    const prev = seen.get(c);
    if (prev) out.push([prev, id]);
    else seen.set(c, id);
  }
  return out;
}

/** Action déjà liée à cette combinaison (hors `except`), s'il y en a une. */
export function conflictFor(bindings: Record<string, string>, binding: string, except: string): string | null {
  const want = parseBinding(binding);
  if (!want) return null;
  const c = canonical(want);
  for (const [id, raw] of Object.entries(bindings)) {
    if (id === except || !raw) continue;
    const b = parseBinding(raw);
    if (b && canonical(b) === c) return id;
  }
  return null;
}

/** Identifiant du raccourci que déclenche cet événement, d'après les liaisons. */
export function shortcutFor(e: KeyEventLike, bindings: Record<string, string>): ShortcutId | null {
  for (const [id, raw] of Object.entries(bindings)) if (raw && matchesEvent(e, raw)) return id as ShortcutId;
  return null;
}

/** Nettoie ce qui a été lu du stockage : ignore ids inconnus et combinaisons illisibles. */
export function sanitizeOverrides(raw: unknown, defs: ShortcutDef[] = SHORTCUTS): Overrides {
  const out: Overrides = {};
  if (!raw || typeof raw !== "object") return out;
  for (const d of defs) {
    const v = (raw as Record<string, unknown>)[d.id];
    if (typeof v !== "string") continue;
    if (v === "") out[d.id] = "";
    else {
      const b = parseBinding(v);
      if (b && isAcceptableBinding(b)) out[d.id] = canonical(b);
    }
  }
  return out;
}

// --- Persistance ------------------------------------------------------------

const KEY = "elium_shortcuts";

function read(): Overrides {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(KEY);
    return sanitizeOverrides(raw ? JSON.parse(raw) : null);
  } catch {
    return {};
  }
}

let overrides: Overrides = read();
let resolved = resolveBindings(SHORTCUTS, overrides);
const listeners = new Set<() => void>();

function commit(next: Overrides): void {
  overrides = next;
  resolved = resolveBindings(SHORTCUTS, overrides);
  try {
    if (Object.keys(next).length === 0) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* stockage indisponible : valable pour la session */
  }
  for (const fn of listeners) fn();
}

export function getBindings(): Record<ShortcutId, string> {
  return resolved;
}

export function getOverrides(): Overrides {
  return overrides;
}

/** Lie une action à une combinaison ("" = désactiver). Renvoie l'action en conflit si la combinaison est prise (rien n'est alors modifié). */
export function setBinding(id: ShortcutId, binding: string): { ok: true } | { ok: false; conflict: string } {
  if (binding) {
    const b = parseBinding(binding)!;
    const conflict = conflictFor(resolved, canonical(b), id);
    if (conflict) return { ok: false, conflict };
    binding = canonical(b);
  }
  const def = SHORTCUTS.find((d) => d.id === id)!;
  const next = { ...overrides };
  if (binding === def.default) delete next[id];
  else next[id] = binding;
  commit(next);
  return { ok: true };
}

export function resetBinding(id: ShortcutId): void {
  const next = { ...overrides };
  delete next[id];
  commit(next);
}

export function resetAllBindings(): void {
  commit({});
}

export function useBindings(): Record<ShortcutId, string> {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    getBindings,
    getBindings,
  );
}

let capturing = false;
/** Pendant la capture d'une nouvelle combinaison (Réglages), les raccourcis globaux se taisent. */
export function setShortcutCapture(on: boolean): void {
  capturing = on;
}
export const isCapturingShortcut = (): boolean => capturing;

export const isMac = (): boolean =>
  typeof navigator !== "undefined" && /mac|iphone|ipad/i.test(navigator.platform || "");
