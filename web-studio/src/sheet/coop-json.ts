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
const CHECK_EVERY = 400;
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
  const emitMap = async (m: Record<string, unknown>) => {
    const keys = Object.keys(m);
    await yieldIfDue();
    emit("{");
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i]!;
      emit(`${i ? "," : ""}${JSON.stringify(k)}:${JSON.stringify(m[k])}`);
      if (i % CHECK_EVERY === 0) await yieldIfDue();
    }
    emit("}");
  };

  const { sheets, ...top } = wb;
  const topJson = JSON.stringify(top);
  emit(`${topJson.slice(0, -1)}${topJson.length > 2 ? "," : ""}"sheets":[`);
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
