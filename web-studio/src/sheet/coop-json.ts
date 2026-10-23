/**
 * Sérialisation JSON d'un classeur par tranches : un classeur de plusieurs centaines de
 * milliers de cellules ne doit pas bloquer l'interface pendant l'autosauvegarde (un seul
 * `JSON.stringify` puis un clone structuré de l'objet y prendraient plusieurs secondes).
 * Le JSON est assemblé en `Blob` par morceaux, en rendant la main au navigateur entre
 * deux tranches : IndexedDB stocke ensuite le Blob sans le recopier sur le fil principal.
 * Les petits classeurs gardent le chemin habituel (la fonction renvoie `null`).
 */
import type { Workbook } from "./model";

/** Au-dessus de ce nombre de cases (lignes × colonnes cumulées), on sérialise par tranches. */
const COOP_AREA = 150_000;
const SLICE_MS = 12;
const ENTRIES_PER_LINE = 400;
const PIECE_CHARS = 256 * 1024;

const nextTurn = () => new Promise<void>((r) => setTimeout(r, 0));

export async function stringifyWorkbookCooperative(wb: Workbook): Promise<Blob | null> {
  let area = 0;
  for (const s of wb.sheets) area += (s.rows || 0) * (s.cols || 0);
  if (area < COOP_AREA) return null;

  const pieces: Blob[] = [];
  let buf: string[] = [];
  let bufChars = 0;
  const emit = (s: string) => {
    buf.push(s);
    bufChars += s.length;
    if (bufChars >= PIECE_CHARS) {
      pieces.push(new Blob([buf.join("")]));
      buf = [];
      bufChars = 0;
    }
  };

  let last = performance.now();
  const yieldIfDue = async () => {
    if (performance.now() - last < SLICE_MS) return;
    await nextTurn();
    last = performance.now();
  };
  // Chaque tranche d'entrées tient sur sa propre ligne (préfixée d'une espace) : le texte reste du JSON
  // valide (les sauts de ligne ne sont que des espacements), mais `parseJsonCooperative` peut le relire
  // tranche par tranche au lieu d'un unique `JSON.parse` de plusieurs dizaines de Mo.
  const emitMap = async (m: Record<string, unknown>) => {
    const keys = Object.keys(m);
    await yieldIfDue();
    emit("{\n");
    for (let i = 0; i < keys.length; i += ENTRIES_PER_LINE) {
      const end = Math.min(keys.length, i + ENTRIES_PER_LINE);
      const line: string[] = [];
      for (let j = i; j < end; j++) line.push(`${JSON.stringify(keys[j]!)}:${JSON.stringify(m[keys[j]!])}`);
      emit(` ${line.join(",")}${end < keys.length ? "," : ""}\n`);
      await yieldIfDue();
    }
    emit("}");
  };

  const { sheets, ...top } = wb;
  const topJson = JSON.stringify(top);
  emit(`{\n${topJson.slice(1, -1)}${topJson.length > 2 ? "," : ""}"sheets":[`);
  for (let i = 0; i < sheets.length; i++) {
    const { cells, styles, notes, ...rest } = sheets[i]!;
    const base = JSON.stringify(rest); // toujours un objet non vide (au moins `name`)
    emit(`${i ? "," : ""}${base.slice(0, -1)},"cells":`);
    await emitMap(cells);
    if (styles) {
      emit(',"styles":');
      await emitMap(styles);
    }
    if (notes) {
      emit(',"notes":');
      await emitMap(notes);
    }
    emit("}");
    await yieldIfDue();
  }
  emit("]}");
  pieces.push(new Blob([buf.join("")]));
  return new Blob(pieces, { type: "application/json" });
}

/** En dessous de cette taille (caractères), un `JSON.parse` direct est assez rapide. */
const PARSE_DIRECT_MAX = 1_000_000;

/**
 * Relit un JSON produit par {@link stringifyWorkbookCooperative} sans geler l'interface : le squelette
 * (petit) est analysé d'un coup, puis chaque ligne d'entrées (cellules, styles, notes) l'est séparément,
 * avec une pause entre deux tranches. Tout autre texte (ancien format, petit classeur) passe par
 * `JSON.parse`. Même résultat que `JSON.parse(text)`.
 */
export async function parseJsonCooperative<T>(text: string): Promise<T> {
  if (text.length < PARSE_DIRECT_MAX || !text.startsWith("{\n")) return JSON.parse(text) as T;
  const parts: string[] = [];
  const runs: Record<string, unknown>[] = [];
  let cur: Record<string, unknown> | null = null;
  let last = performance.now();
  let pos = 0;
  while (pos < text.length) {
    let nl = text.indexOf("\n", pos);
    if (nl < 0) nl = text.length;
    if (text.charCodeAt(pos) === 32) {
      if (!cur) {
        cur = {};
        runs.push(cur);
        parts.push(`"__r":${runs.length - 1}`);
      }
      const end = text.charCodeAt(nl - 1) === 44 ? nl - 1 : nl;
      Object.assign(cur, JSON.parse(`{${text.slice(pos + 1, end)}}`));
    } else {
      cur = null;
      parts.push(text.slice(pos, nl));
    }
    pos = nl + 1;
    if (performance.now() - last >= SLICE_MS) {
      await nextTurn();
      last = performance.now();
    }
  }
  const skeleton = JSON.parse(parts.join("")) as { sheets?: Record<string, unknown>[] };
  for (const sheet of skeleton.sheets ?? []) {
    for (const k of ["cells", "styles", "notes"]) {
      const v = sheet[k] as Record<string, unknown> | undefined;
      if (v && typeof v === "object" && "__r" in v) sheet[k] = runs[v.__r as number];
    }
  }
  return skeleton as T;
}
