/**
 * Rechercher / remplacer dans TOUS les documents de l'espace de travail :
 * aperçu de chaque occurrence, application sélective, annulation.
 *
 * - `findInDoc` / `replaceInDoc` : purs, sur le JSON ProseMirror ; une
 *   occurrence peut chevaucher plusieurs nœuds de texte (gras au milieu d'un
 *   mot…) : on travaille sur le texte CONCATÉNÉ de chaque bloc.
 * - `scanDocuments` / `applyReplacements` / `undoReplacement` : orchestration,
 *   avec les E/S injectées (testable sans navigateur).
 *
 * Sécurité des données : l'original de chaque document modifié est conservé
 * (chiffré si le coffre est actif) pour l'annulation ; un document modifié
 * depuis l'analyse n'est jamais écrasé ; un document signé ou scellé n'est
 * touché que sur demande explicite (la modification invalide signatures et sceau).
 */
import {
  decryptAtRest,
  decryptBytesAtRest,
  encryptAtRest,
  encryptBytesAtRest,
  hasVaultSecret,
  type VaultSecret,
} from "../crypto/local-vault";
import type { ProseMirrorNode } from "../format/types";
import type { KvStore } from "./kv";
import type { WorkItem } from "./types";

export interface ReplaceOptions {
  find: string;
  replace: string;
  caseSensitive: boolean;
  wholeWord: boolean;
}

export interface DocMatch {
  /** Identifiant stable dans UN document : « chemin@début ». */
  id: string;
  /** Chemin des indices d'enfants depuis la racine jusqu'au bloc de texte. */
  path: number[];
  start: number;
  end: number;
  before: string;
  match: string;
  after: string;
}

const OBJECT_CHAR = "￼";
const CONTEXT = 40;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function compileFind(o: ReplaceOptions): RegExp | null {
  if (!o.find) return null;
  const core = escapeRegExp(o.find);
  const src = o.wholeWord ? `(?<![\\p{L}\\p{N}_])${core}(?![\\p{L}\\p{N}_])` : core;
  return new RegExp(src, o.caseSensitive ? "gu" : "giu");
}

/** Un bloc de texte : un nœud dont les enfants contiennent du texte en ligne. */
function isTextBlock(n: ProseMirrorNode): boolean {
  return !!n.content?.some((c) => typeof c.text === "string");
}

interface Segment {
  child: number;
  from: number;
  to: number;
  isText: boolean;
}

function segmentsOf(block: ProseMirrorNode): { text: string; segs: Segment[] } {
  let text = "";
  const segs: Segment[] = [];
  (block.content ?? []).forEach((c, i) => {
    const isText = typeof c.text === "string";
    const piece = isText ? c.text! : c.type === "hardBreak" ? "\n" : OBJECT_CHAR;
    segs.push({ child: i, from: text.length, to: text.length + piece.length, isText });
    text += piece;
  });
  return { text, segs };
}

function walkBlocks(node: ProseMirrorNode, path: number[], visit: (b: ProseMirrorNode, path: number[]) => void): void {
  if (isTextBlock(node)) {
    visit(node, path);
    return;
  }
  (node.content ?? []).forEach((c, i) => walkBlocks(c, [...path, i], visit));
}

export function findInDoc(doc: ProseMirrorNode | undefined, opts: ReplaceOptions): DocMatch[] {
  const re = compileFind(opts);
  if (!doc || !re) return [];
  const out: DocMatch[] = [];
  walkBlocks(doc, [], (block, path) => {
    const { text, segs } = segmentsOf(block);
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      const start = m.index;
      const end = start + m[0].length;
      // Une occurrence qui chevauche un objet non textuel (image, renvoi…) n'est pas remplaçable.
      if (segs.some((s) => !s.isText && s.from < end && s.to > start)) continue;
      out.push({
        id: `${path.join(".")}@${start}`,
        path,
        start,
        end,
        before: text.slice(Math.max(0, start - CONTEXT), start).replace(/\s+/g, " "),
        match: m[0],
        after: text.slice(end, end + CONTEXT).replace(/\s+/g, " "),
      });
    }
  });
  return out;
}

function clone<T>(v: T): T {
  return structuredClone(v);
}

function nodeAt(root: ProseMirrorNode, path: number[]): ProseMirrorNode | undefined {
  let cur: ProseMirrorNode | undefined = root;
  for (const i of path) cur = cur?.content?.[i];
  return cur;
}

/** Copie du document avec les occurrences choisies remplacées (`selected` = identifiants de `findInDoc`). */
export function replaceInDoc(
  doc: ProseMirrorNode,
  selected: Set<string>,
  replacement: string,
  opts: ReplaceOptions,
): ProseMirrorNode {
  const out = clone(doc);
  const all = findInDoc(out, opts).filter((m) => selected.has(m.id));
  // Par bloc, de la fin vers le début : les décalages précédents restent valides.
  const byBlock = new Map<string, DocMatch[]>();
  for (const m of all) byBlock.set(m.path.join("."), [...(byBlock.get(m.path.join(".")) ?? []), m]);
  for (const list of byBlock.values()) {
    const block = nodeAt(out, list[0]!.path);
    if (!block?.content) continue;
    for (const m of list.sort((a, b) => b.start - a.start)) {
      const { segs } = segmentsOf(block);
      const first = segs.find((s) => s.from <= m.start && m.start < s.to);
      const last = segs.find((s) => s.from < m.end && m.end <= s.to);
      if (!first || !last || !first.isText || !last.isText) continue;
      const kids = block.content!;
      const a = kids[first.child]!;
      const head = a.text!.slice(0, m.start - first.from);
      if (first.child === last.child) {
        a.text = head + replacement + a.text!.slice(m.end - first.from);
      } else {
        const z = kids[last.child]!;
        a.text = head + replacement;
        z.text = z.text!.slice(m.end - last.from);
        for (let i = first.child + 1; i < last.child; i++) kids[i]!.text = "";
      }
    }
    // Les nœuds de texte vidés disparaissent (ProseMirror refuse un texte vide).
    block.content = block.content.filter((c) => typeof c.text !== "string" || c.text.length > 0);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/** Un .elium analysé pour le remplacement. */
export interface ParsedDoc {
  doc: ProseMirrorNode | undefined;
  /** Au moins une signature : la modifier invalide les preuves. */
  signed: boolean;
  /** Scellé : la modification retire le sceau. */
  sealed: boolean;
  /** Réécrit le fichier avec ce nouveau contenu. */
  rewrite(doc: ProseMirrorNode): Promise<Uint8Array>;
}

/** Levée par `parse` quand le document est chiffré par son propre mot de passe. */
export class EncryptedDocument extends Error {}

export interface ReplaceDeps {
  /** Contenu .elium d'un document de la bibliothèque + sa date d'enregistrement (preuve de non-modification). */
  read(id: string): Promise<{ bytes: Uint8Array; version: string } | undefined>;
  parse(bytes: Uint8Array): Promise<ParsedDoc>;
  /** Écrit le nouveau contenu ; renvoie la nouvelle version (date d'enregistrement). */
  write(id: string, bytes: Uint8Array, title: string): Promise<string>;
  undo: KvStore<UndoRecord>;
  getSecret: () => VaultSecret | undefined;
  now?: () => Date;
  newId?: () => string;
}

export type DocScanStatus = "ok" | "encrypted" | "error";

export interface DocScan {
  itemId: string;
  title: string;
  status: DocScanStatus;
  signed: boolean;
  sealed: boolean;
  /** Date d'enregistrement vue à l'analyse : l'application refuse un document modifié depuis. */
  version: string;
  matches: DocMatch[];
  error?: string;
}

export async function scanDocuments(
  items: WorkItem[],
  opts: ReplaceOptions,
  deps: Pick<ReplaceDeps, "read" | "parse">,
  onProgress?: (done: number, total: number) => void,
): Promise<DocScan[]> {
  const docs = items.filter((i) => i.kind === "doc" && i.contentStore === "drive" && !i.trashedAt && !i.locked);
  const out: DocScan[] = [];
  let done = 0;
  for (const item of docs) {
    const base = {
      itemId: item.id,
      title: item.title,
      signed: false,
      sealed: false,
      version: "",
      matches: [] as DocMatch[],
    };
    try {
      const file = await deps.read(item.id);
      if (!file) {
        out.push({ ...base, status: "error", error: "Introuvable dans la bibliothèque." });
      } else {
        const parsed = await deps.parse(file.bytes);
        const matches = findInDoc(parsed.doc, opts);
        if (matches.length)
          out.push({
            ...base,
            status: "ok",
            signed: parsed.signed,
            sealed: parsed.sealed,
            version: file.version,
            matches,
          });
      }
    } catch (e) {
      if (e instanceof EncryptedDocument) out.push({ ...base, status: "encrypted" });
      else out.push({ ...base, status: "error", error: e instanceof Error ? e.message : String(e) });
    }
    onProgress?.(++done, docs.length);
  }
  return out;
}

export interface UndoEntry {
  itemId: string;
  /** Version écrite par le remplacement : l'annulation ne s'applique que si rien n'a changé depuis. */
  afterVersion: string;
  title?: string;
  bytes?: Uint8Array;
  enc?: string; // { title } chiffré
  encBytes?: string;
}

export interface UndoRecord {
  id: string;
  at: string;
  find: string;
  replace: string;
  entries: UndoEntry[];
}

export const UNDO_KEEP = 3;

export interface ApplyResult {
  batchId: string | null;
  replaced: number;
  documents: number;
  skipped: { itemId: string; title: string; reason: "changed" | "error" | "unselected"; message?: string }[];
}

/**
 * Applique les occurrences choisies. `selection` : identifiant d'élément → occurrences retenues.
 * Chaque document est relu et comparé à la version de l'analyse avant d'être réécrit.
 */
export async function applyReplacements(
  scans: DocScan[],
  selection: Map<string, Set<string>>,
  opts: ReplaceOptions,
  deps: ReplaceDeps,
): Promise<ApplyResult> {
  const now = deps.now ?? (() => new Date());
  const secret = deps.getSecret();
  const entries: UndoEntry[] = [];
  const skipped: ApplyResult["skipped"] = [];
  let replaced = 0;
  for (const scan of scans) {
    const chosen = selection.get(scan.itemId);
    if (!chosen || chosen.size === 0) continue;
    try {
      const file = await deps.read(scan.itemId);
      if (!file || file.version !== scan.version) {
        skipped.push({ itemId: scan.itemId, title: scan.title, reason: "changed" });
        continue;
      }
      const parsed = await deps.parse(file.bytes);
      if (!parsed.doc) continue;
      const before = findInDoc(parsed.doc, opts).filter((m) => chosen.has(m.id));
      if (before.length === 0) continue;
      const next = replaceInDoc(parsed.doc, new Set(before.map((m) => m.id)), opts.replace, opts);
      const bytes = await parsed.rewrite(next);
      const afterVersion = await deps.write(scan.itemId, bytes, scan.title);
      entries.push(
        hasVaultSecret(secret)
          ? {
              itemId: scan.itemId,
              afterVersion,
              enc: await encryptAtRest({ title: scan.title }, secret),
              encBytes: await encryptBytesAtRest(file.bytes, secret),
            }
          : { itemId: scan.itemId, afterVersion, title: scan.title, bytes: file.bytes },
      );
      replaced += before.length;
    } catch (e) {
      skipped.push({
        itemId: scan.itemId,
        title: scan.title,
        reason: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }
  if (entries.length === 0) return { batchId: null, replaced, documents: 0, skipped };
  const id = (deps.newId ?? (() => `undo-${now().getTime()}`))();
  await deps.undo.put({ id, at: now().toISOString(), find: opts.find, replace: opts.replace, entries });
  // Ne garde que les dernières opérations annulables.
  const all = (await deps.undo.getAll()).sort((a, b) => (a.at < b.at ? 1 : -1));
  const drop = all.slice(UNDO_KEEP).map((r) => r.id);
  if (drop.length) await deps.undo.deleteMany(drop);
  return { batchId: id, replaced, documents: entries.length, skipped };
}

export interface UndoResult {
  restored: number;
  skipped: { title: string; reason: "changed" | "error"; message?: string }[];
}

/** Annule un remplacement : restaure les originaux des documents restés tels que le remplacement les a laissés. */
export async function undoReplacement(
  batchId: string,
  deps: Pick<ReplaceDeps, "read" | "write" | "undo" | "getSecret">,
): Promise<UndoResult> {
  const rec = await deps.undo.get(batchId);
  if (!rec) throw new Error("Cette opération ne peut plus être annulée.");
  const secret = deps.getSecret();
  let restored = 0;
  const skipped: UndoResult["skipped"] = [];
  const keep: UndoEntry[] = [];
  for (const e of rec.entries) {
    let title = e.title ?? "";
    try {
      let bytes = e.bytes;
      if (e.enc && e.encBytes) {
        if (!hasVaultSecret(secret)) throw new Error("Coffre local verrouillé : impossible de relire la sauvegarde.");
        title = (await decryptAtRest<{ title: string }>(e.enc, secret)).title;
        bytes = await decryptBytesAtRest(e.encBytes, secret);
      }
      if (!bytes) throw new Error("Sauvegarde vide.");
      const cur = await deps.read(e.itemId);
      if (!cur || cur.version !== e.afterVersion) {
        skipped.push({ title, reason: "changed" });
        continue; // modifié depuis : on n'écrase pas le travail récent
      }
      await deps.write(e.itemId, bytes, title);
      restored++;
    } catch (err) {
      skipped.push({ title, reason: "error", message: err instanceof Error ? err.message : String(err) });
      keep.push(e);
    }
  }
  if (keep.length === 0) await deps.undo.delete(batchId);
  else await deps.undo.put({ ...rec, entries: keep });
  return { restored, skipped };
}
