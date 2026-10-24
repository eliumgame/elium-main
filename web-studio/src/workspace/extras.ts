/**
 * Pièces ANNEXES de la sauvegarde : tout ce qui n'est pas un élément du catalogue mais que
 * l'utilisateur doit retrouver à l'identique — brouillons de récupération (Documents et PDF),
 * historique de versions, polices importées, passeport (et annexes), circuits Parapheur.
 *
 * Chaque pièce est un zip : une entrée JSON par enregistrement, les octets (Uint8Array, Blob,
 * ArrayBuffer) à part (`b/<n>`), sans base64. Les enregistrements sont copiés BRUTS : un contenu
 * chiffré par le coffre ou par le mot de passe d'un document reste chiffré (même secret à la
 * restauration), et l'encodage ne déchiffre jamais rien. Les clés privées et identités
 * (`elium-keys`, `elium-pdf-ids`) n'en font volontairement pas partie.
 */
import { strFromU8, strToU8 } from "fflate";
import { unzipCooperative, zipCooperative } from "../format/coop-zip";
import {
  DRAFTS_SPEC,
  PARAPHEUR_SPEC,
  PASSPORT_SPEC,
  PDF_IDS_SPEC,
  PDF_RECOVERY_SPEC,
  VERSIONS_SPEC,
} from "../format/db-specs";
import { openMigrated, type DbSpec } from "../format/idb-migrate";

export interface ExtraStoreSpec {
  name: string;
  /** « keyed » : fusion par clé (le plus récent gagne) ; « versions » : déduplication par docKey+ts, nouvelles clés. */
  merge: "keyed" | "versions";
  /** Ne restaurer que si le magasin local est vide (passeport : une seule fiche, jamais écrasée en silence). */
  onlyIfEmpty?: boolean;
}

export interface ExtraPiece {
  /** Nom stable de la pièce (clé de `markDirty`) et du fichier Drive `_<nom>.elium-extra`. */
  piece: string;
  label: string;
  open: () => Promise<IDBDatabase>;
  stores: ExtraStoreSpec[];
}

const fromSpec = (spec: DbSpec) => () => openMigrated(spec);

function openFonts(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("elium-fonts", 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains("fonts")) req.result.createObjectStore("fonts", { keyPath: "name" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export const EXTRA_PIECES: ExtraPiece[] = [
  {
    piece: "brouillons",
    label: "Brouillons de récupération (Documents)",
    open: fromSpec(DRAFTS_SPEC),
    stores: [{ name: "drafts", merge: "keyed" }],
  },
  {
    piece: "brouillons-pdf",
    label: "Brouillons de récupération (PDF)",
    open: fromSpec(PDF_RECOVERY_SPEC),
    stores: [
      { name: "drafts", merge: "keyed" },
      { name: "sources", merge: "keyed" },
    ],
  },
  {
    piece: "versions",
    label: "Historique de versions",
    open: fromSpec(VERSIONS_SPEC),
    stores: [{ name: "versions", merge: "versions" }],
  },
  { piece: "polices", label: "Polices importées", open: openFonts, stores: [{ name: "fonts", merge: "keyed" }] },
  {
    piece: "passeport",
    label: "Passeport E4 et annexes",
    open: fromSpec(PASSPORT_SPEC),
    stores: [
      { name: "passport", merge: "keyed", onlyIfEmpty: true },
      { name: "annexes", merge: "keyed" },
    ],
  },
  {
    // Signatures et initiales manuscrites + identités de confiance. Les identités PRIVÉES (`ids`) en sont exclues.
    piece: "marques-pdf",
    label: "Signatures manuscrites et identités de confiance (PDF)",
    open: fromSpec(PDF_IDS_SPEC),
    stores: [
      { name: "marks", merge: "keyed" },
      { name: "trusted", merge: "keyed" },
    ],
  },
  {
    piece: "parapheur",
    label: "Circuits Parapheur",
    open: fromSpec(PARAPHEUR_SPEC),
    stores: [{ name: "workflows", merge: "keyed" }],
  },
];

export const extraByPiece = (piece: string): ExtraPiece | undefined => EXTRA_PIECES.find((p) => p.piece === piece);

// --- Encodage pur (testé sans navigateur) --------------------------------------------------------

export type Records = Record<string, unknown[]>;
const BIN = "$bin";

/** Remplace les valeurs binaires par `{ $bin: "b/<n>" }` et les range dans `bins`. */
export async function encodeValue(v: unknown, bins: Record<string, Uint8Array>): Promise<unknown> {
  const stash = (data: Uint8Array): string => {
    const k = `b/${Object.keys(bins).length}`;
    bins[k] = data;
    return k;
  };
  if (v instanceof Uint8Array) return { [BIN]: stash(v), t: "u8" };
  if (v instanceof ArrayBuffer) return { [BIN]: stash(new Uint8Array(v)), t: "ab" };
  if (typeof Blob !== "undefined" && v instanceof Blob)
    return { [BIN]: stash(new Uint8Array(await v.arrayBuffer())), t: "blob", mime: v.type };
  if (Array.isArray(v)) {
    const out: unknown[] = [];
    for (const x of v) out.push(await encodeValue(x, bins));
    return out;
  }
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = await encodeValue(x, bins);
    return out;
  }
  return v;
}

export function decodeValue(v: unknown, bins: Record<string, Uint8Array>): unknown {
  if (Array.isArray(v)) return v.map((x) => decodeValue(x, bins));
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o[BIN] === "string") {
      const data = bins[o[BIN]] ?? new Uint8Array();
      if (o.t === "ab") return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      if (o.t === "blob") return new Blob([data as BlobPart], { type: typeof o.mime === "string" ? o.mime : "" });
      return data;
    }
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(o)) out[k] = decodeValue(x, bins);
    return out;
  }
  return v;
}

export async function packRecords(records: Records): Promise<Uint8Array> {
  const bins: Record<string, Uint8Array> = {};
  const files: Record<string, Uint8Array> = {};
  const index: Record<string, number> = {};
  for (const [store, list] of Object.entries(records)) {
    index[store] = list.length;
    for (let i = 0; i < list.length; i++) {
      const enc = await encodeValue(list[i], bins);
      files[`s/${encodeURIComponent(store)}/${i}.json`] = strToU8(JSON.stringify(enc));
    }
  }
  files["manifest.json"] = strToU8(JSON.stringify({ format: "elium-extra", version: 1, stores: index }));
  return zipCooperative({ ...files, ...bins }, 4);
}

export async function unpackRecords(bytes: Uint8Array): Promise<Records> {
  const files = await unzipCooperative(bytes, () => true);
  const manifest = JSON.parse(strFromU8(files["manifest.json"] ?? strToU8("{}"))) as {
    format?: string;
    stores?: Record<string, number>;
  };
  if (manifest.format !== "elium-extra") throw new Error("Pièce de sauvegarde illisible.");
  const bins: Record<string, Uint8Array> = {};
  for (const [n, d] of Object.entries(files)) if (n.startsWith("b/")) bins[n] = d;
  const out: Records = {};
  for (const [store, count] of Object.entries(manifest.stores ?? {})) {
    out[store] = [];
    for (let i = 0; i < count; i++) {
      const f = files[`s/${encodeURIComponent(store)}/${i}.json`];
      if (f) out[store]!.push(decodeValue(JSON.parse(strFromU8(f)), bins));
    }
  }
  return out;
}

const STAMP_FIELDS = ["updatedAt", "ts", "savedAt", "addedAt", "modifiedAt"];
const stampOf = (v: unknown): string => {
  if (v && typeof v === "object")
    for (const f of STAMP_FIELDS) {
      const x = (v as Record<string, unknown>)[f];
      if (typeof x === "string") return x;
    }
  return "";
};

/**
 * Fusion pure : renvoie les enregistrements à ÉCRIRE localement. « keyed » : absent en local, ou plus
 * récent que le local. « versions » : instantané inconnu (docKey+ts) — sa clé auto-incrémentée est retirée.
 */
export function mergePlan(
  spec: ExtraStoreSpec,
  local: unknown[],
  remote: unknown[],
  keyOf: (v: unknown) => string,
): unknown[] {
  if (spec.onlyIfEmpty && local.length > 0) return [];
  if (spec.merge === "versions") {
    const sig = (v: unknown) => `${(v as { docKey?: string }).docKey}|${(v as { ts?: string }).ts}`;
    const known = new Set(local.map(sig));
    return remote
      .filter((v) => !known.has(sig(v)))
      .map((v) => {
        const { id: _id, ...rest } = v as Record<string, unknown>;
        void _id;
        return rest;
      });
  }
  const byKey = new Map(local.map((v) => [keyOf(v), v] as const));
  return remote.filter((v) => {
    const mine = byKey.get(keyOf(v));
    return !mine || stampOf(v) > stampOf(mine);
  });
}

// --- Accès IndexedDB (fin) -----------------------------------------------------------------------

const req = <T>(r: IDBRequest<T>): Promise<T> =>
  new Promise((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });

export async function dumpExtra(p: ExtraPiece): Promise<Records> {
  const db = await p.open();
  try {
    const out: Records = {};
    for (const s of p.stores) {
      if (!db.objectStoreNames.contains(s.name)) continue;
      out[s.name] = await req(db.transaction(s.name, "readonly").objectStore(s.name).getAll());
    }
    return out;
  } finally {
    db.close();
  }
}

/** Applique une pièce reçue ; renvoie le nombre d'enregistrements écrits. */
export async function applyExtra(p: ExtraPiece, remote: Records): Promise<number> {
  const db = await p.open();
  try {
    let written = 0;
    for (const s of p.stores) {
      const incoming = remote[s.name];
      if (!incoming?.length || !db.objectStoreNames.contains(s.name)) continue;
      const store = db.transaction(s.name, "readonly").objectStore(s.name);
      const keyPath = store.keyPath as string | null;
      const local = await req(store.getAll());
      const keyOf = (v: unknown) => String(keyPath ? (v as Record<string, unknown>)[keyPath] : "");
      const toWrite = mergePlan(s, local, incoming, keyOf);
      if (!toWrite.length) continue;
      const tx = db.transaction(s.name, "readwrite");
      for (const v of toWrite) tx.objectStore(s.name).put(v);
      await new Promise<void>((res, rej) => {
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
        tx.onabort = () => rej(tx.error);
      });
      written += toWrite.length;
    }
    return written;
  } finally {
    db.close();
  }
}
