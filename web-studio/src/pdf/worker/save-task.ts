/**
 * Enregistrement d'un PDF (`savePdf`) hors du fil principal : `PDFDocument.load`, l'application du modèle,
 * le caviardage et `doc.save` sont synchrones et se comptent en secondes sur un gros fichier.
 *
 * Le Worker GARDE l'état du fichier destination (`DiskState` : objets de chiffrement, empreintes) d'un
 * enregistrement à l'autre ; le fil principal n'en voit qu'un mandataire (`DiskProxy`, avec un jeton). Si
 * le Worker a été relancé, l'état est relu depuis les octets du fichier. Aucun accès au DOM ici.
 */
import type { PdfState } from "../model/types";
import {
  readDiskState,
  savePdf,
  type BuildOptions,
  type DiskState,
  type SaveInput,
  type SaveResult,
  type SecurityChange,
} from "../ops/save";
import type { PdfCrypt } from "../ops/security";
import { takeWorkerTranscodeFailure } from "../ops/images";

/** Ce que le fil principal garde du fichier destination. `crypt` n'y est qu'un témoin (sa présence). */
export type DiskProxy = DiskState & { token: string };

export type WireOptions = Omit<BuildOptions, "onProgress" | "pristineAnnots" | "pristineBookmarks">;

/** Fichier destination tel qu'il voyage : octets, plancher de numérotation et jeton éventuel. */
export interface WireDisk {
  bytes: Uint8Array;
  floor: number;
  token: string | null;
}

export interface FontSnapshot {
  fonts: [name: string, bytes: Uint8Array, filename: string][];
  /** Dossier des polices standard de pdf.js (Liberation Sans), résolu côté fil principal. */
  standardFontDataUrl: string | null;
}

export interface SaveRequest extends FontSnapshot {
  op: "save";
  /** Garder l'état du fichier écrit dans le Worker (enregistrements successifs). Faux pour une simple exportation. */
  retain: boolean;
  source: Uint8Array;
  base?: Uint8Array;
  disk: WireDisk | null;
  state: PdfState;
  options: WireOptions;
  /** Identifiants des annotations importées encore intactes (l'identité d'objet ne traverse pas le Worker). */
  pristineAnnotIds: string[] | null;
  /** Le plan de classement est resté celui du fichier. */
  bookmarksPristine: boolean;
  mode?: SaveInput["mode"];
  security?: SecurityChange | null;
  forceFullReasons?: readonly string[];
}

export interface ReadDiskRequest extends FontSnapshot {
  op: "readDisk";
  bytes: Uint8Array;
  password: string | null;
}

export type SaveResponse = SaveResult & { disk: DiskProxy };

const MAX_SESSIONS = 3;
const sessions = new Map<string, DiskState>();

const newToken = (): string => {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
};

const copyOf = (b: Uint8Array): Uint8Array => b.slice();

/** Mandataire du `DiskState` : mêmes octets (partagés avec le résultat), témoin de chiffrement, jeton. */
function proxyOf(disk: DiskState): DiskProxy {
  const token = newToken();
  // Le Worker garde SA copie : les octets du mandataire partent (transférés) vers le fil principal.
  sessions.set(token, { ...disk, bytes: copyOf(disk.bytes) });
  while (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value as string);
  const witness = disk.crypt
    ? ({ scheme: disk.crypt.scheme, permissions: disk.crypt.permissions, id0: disk.crypt.id0 } as unknown as PdfCrypt)
    : null;
  return { ...disk, crypt: witness, encryptRef: null, fingerprints: new Map(), token };
}

async function hydrate(wire: WireDisk | null, password: string | null | undefined): Promise<DiskState | null> {
  if (!wire) return null;
  const known = wire.token ? sessions.get(wire.token) : undefined;
  if (known && known.bytes.length === wire.bytes.length) return known;
  const fresh = await readDiskState(wire.bytes, password);
  return { ...fresh, floor: Math.max(fresh.floor, wire.floor) };
}

/** Polices importées et dossier des polices standard : le Worker n'a pas accès aux registres du fil principal. */
async function installFonts(snap: FontSnapshot): Promise<void> {
  if (typeof document !== "undefined") return; // fil principal (repli en ligne) : tout y est déjà
  const { registerCustomFont } = await import("../../ui/fonts");
  for (const [name, bytes, filename] of snap.fonts) registerCustomFont(name, bytes, filename);
  const { setStandardFontDataUrl } = await import("../ops/unicodefonts");
  setStandardFontDataUrl(snap.standardFontDataUrl);
}

function tagged(e: unknown, names: Record<string, new (...a: never[]) => Error>): Error {
  const err = e instanceof Error ? e : new Error(String(e));
  for (const [name, ctor] of Object.entries(names)) if (err instanceof ctor) err.name = name;
  return err;
}

export async function runSaveTask(
  req: SaveRequest,
  progress?: (fraction: number, label: string) => void,
): Promise<SaveResponse> {
  const { WrongPassword, UnsupportedEncryptedObjectStreams, UnsupportedSecurityHandler } =
    await import("../ops/security");
  try {
    takeWorkerTranscodeFailure(); // remet à zéro
    await installFonts(req);
    const pristine = req.pristineAnnotIds ? new Set(req.pristineAnnotIds) : null;
    const options: BuildOptions = {
      ...req.options,
      onProgress: progress ? (label, ratio) => progress(ratio, label) : undefined,
      pristineAnnots: pristine ? new Set(req.state.annots.filter((a) => pristine.has(a.id))) : undefined,
      pristineBookmarks: req.bookmarksPristine ? req.state.bookmarks : null,
    };
    const disk = await hydrate(req.disk, req.options.password);
    const res = await savePdf({
      source: req.source,
      base: req.base,
      disk,
      state: req.state,
      options,
      mode: req.mode,
      security: req.security,
      forceFullReasons: req.forceFullReasons,
    });
    // Une image n'a pu être transcodée sans DOM : le résultat serait incomplet, on le fait refaire sur le fil principal.
    if (takeWorkerTranscodeFailure()) throw new Error("document is not defined (transcodage d'image)");
    return { ...res, disk: req.retain ? proxyOf(res.disk) : (undefined as unknown as DiskProxy) };
  } catch (e) {
    throw tagged(e, { WrongPassword, UnsupportedEncryptedObjectStreams, UnsupportedSecurityHandler });
  }
}

export async function runReadDiskTask(req: ReadDiskRequest): Promise<DiskProxy> {
  const { WrongPassword, UnsupportedEncryptedObjectStreams, UnsupportedSecurityHandler } =
    await import("../ops/security");
  try {
    return proxyOf(await readDiskState(req.bytes, req.password));
  } catch (e) {
    throw tagged(e, { WrongPassword, UnsupportedEncryptedObjectStreams, UnsupportedSecurityHandler });
  }
}

/** Octets à transférer d'une réponse (sans doublon : le résultat et le mandataire partagent les mêmes). */
export function transferablesOf(res: SaveResponse | DiskProxy): ArrayBuffer[] {
  const seen = new Set<ArrayBuffer>();
  const add = (b: Uint8Array) => {
    if (b.byteOffset === 0 && b.byteLength === b.buffer.byteLength) seen.add(b.buffer as ArrayBuffer);
  };
  if ("token" in res) add(res.bytes);
  else {
    add(res.bytes);
    if (res.disk) add(res.disk.bytes);
  }
  return [...seen];
}
