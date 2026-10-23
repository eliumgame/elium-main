/**
 * Côté fil principal de l'enregistrement hors du fil principal (voir save-task.ts). Même signature que
 * `savePdf` / `readDiskState` ; l'exécution part dans un Worker pdf-lib PERSISTANT (il garde l'état du
 * fichier destination d'un enregistrement à l'autre) quand le document est assez gros et que la
 * demande n'a besoin ni de rappel (`transform`) ni du canvas du fil principal (`optimise`).
 * Sinon, ou si le Worker échoue faute de DOM, le même travail se fait en ligne, comme avant.
 */
import { runWorkerTask, workersAvailable } from "../../workers/worker-task";
import { customFontFilename, customFontNames, getCustomFont } from "../../ui/fonts";
import { readDiskState, savePdf, type DiskState, type SaveInput, type SaveResult } from "../ops/save";
import {
  runReadDiskTask,
  runSaveTask,
  type DiskProxy,
  type FontSnapshot,
  type ReadDiskRequest,
  type SaveRequest,
  type SaveResponse,
  type WireDisk,
} from "./save-task";

/** En dessous, le Worker coûterait plus (démarrage, copie) qu'il ne rapporte. */
export const OFF_THREAD_MIN_BYTES = 2 * 1024 * 1024;
export const OFF_THREAD_MIN_PAGES = 60;

type Req = SaveRequest | ReadDiskRequest;
type Res = SaveResponse | DiskProxy;

let shared: Worker | null = null;
const reuse = {
  get: () => shared,
  set: (w: Worker | null) => {
    shared = w;
  },
};
const createWorker = () => new Worker(new URL("./pdf-lib.worker.ts", import.meta.url), { type: "module" });

/** Un seul travail à la fois dans le Worker partagé (il garde un état). */
let chain: Promise<unknown> = Promise.resolve();
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const p = chain.then(fn, fn);
  chain = p.catch(() => undefined);
  return p;
}

const NEEDS_DOM =
  /(document|window|Image|DOMParser|OffscreenCanvas|FontFace|createImageBitmap) is not defined|transcodage d'image/;

const isProxy = (d: DiskState | null | undefined): d is DiskProxy => !!d && typeof (d as DiskProxy).token === "string";

const wireOf = (d: DiskState | null | undefined): WireDisk | null =>
  d ? { bytes: d.bytes, floor: d.floor, token: isProxy(d) ? d.token : null } : null;

async function fontSnapshot(): Promise<FontSnapshot> {
  const fonts: FontSnapshot["fonts"] = [];
  for (const name of customFontNames()) {
    const bytes = getCustomFont(name);
    if (bytes) fonts.push([name, bytes, customFontFilename(name)]);
  }
  let standardFontDataUrl: string | null = null;
  try {
    const { pdfjsAssetUrls } = await import("../core/assets");
    const u = pdfjsAssetUrls()?.standardFontDataUrl;
    if (u) standardFontDataUrl = new URL(u, globalThis.location?.href ?? "http://localhost/").href;
  } catch {
    /* sans polices standard : le Worker retombe sur ce qu'il trouve */
  }
  return { fonts, standardFontDataUrl };
}

/** Rend un vrai `DiskState` (pour une exécution en ligne) à partir d'un mandataire du Worker. */
async function realDisk(
  d: DiskState | null | undefined,
  password: string | null | undefined,
): Promise<DiskState | null> {
  if (!d) return null;
  if (!isProxy(d)) return d;
  const fresh = await readDiskState(d.bytes, password);
  return { ...fresh, floor: Math.max(fresh.floor, d.floor) };
}

async function rewrap(e: unknown): Promise<unknown> {
  if (!(e instanceof Error)) return e;
  const sec = await import("../ops/security");
  const ctor = {
    WrongPassword: sec.WrongPassword,
    UnsupportedEncryptedObjectStreams: sec.UnsupportedEncryptedObjectStreams,
    UnsupportedSecurityHandler: sec.UnsupportedSecurityHandler,
  }[e.name as string];
  return ctor ? Object.assign(new (ctor as new (m?: string) => Error)(e.message), { stack: e.stack }) : e;
}

function worthOffThread(bytes: number, pages: number): boolean {
  return workersAvailable() && (bytes >= OFF_THREAD_MIN_BYTES || pages >= OFF_THREAD_MIN_PAGES);
}

/** `savePdf`, hors du fil principal quand c'est possible. */
export async function savePdfAuto(input: SaveInput, retain = true): Promise<SaveResult> {
  const password = input.options?.password;
  const inline = async () => savePdf({ ...input, disk: await realDisk(input.disk, password) });
  const eligible =
    !input.transform &&
    !input.options?.optimise &&
    worthOffThread(Math.max(input.source.length, input.base?.length ?? 0), input.state.pages.length);
  if (!eligible) return inline();

  const { onProgress, pristineAnnots, pristineBookmarks, ...wireOptions } = input.options ?? {};
  const request: SaveRequest = {
    op: "save",
    retain,
    source: input.source,
    base: input.base,
    disk: wireOf(input.disk),
    state: input.state,
    options: wireOptions as SaveRequest["options"],
    pristineAnnotIds: pristineAnnots ? [...pristineAnnots].map((a) => a.id) : null,
    bookmarksPristine: pristineBookmarks != null && input.state.bookmarks === pristineBookmarks,
    mode: input.mode,
    security: input.security,
    forceFullReasons: input.forceFullReasons,
    ...(await fontSnapshot()),
  };
  try {
    return (await exclusive(() =>
      runWorkerTask<Req, Res>({
        create: createWorker,
        reuse,
        request,
        inline: (r, ctx) => runSaveTask(r as SaveRequest, ctx.progress),
        onProgress: (p) => onProgress?.(p.label, p.fraction),
      }),
    )) as SaveResult;
  } catch (e) {
    if (e instanceof Error && NEEDS_DOM.test(e.message)) return inline();
    throw await rewrap(e);
  }
}

/** `readDiskState`, hors du fil principal pour un gros fichier (renvoie alors un mandataire). */
export async function readDiskStateAuto(bytes: Uint8Array, password?: string | null): Promise<DiskState> {
  if (!worthOffThread(bytes.length, 0)) return readDiskState(bytes, password);
  const request: ReadDiskRequest = { op: "readDisk", bytes, password: password ?? null, ...(await fontSnapshot()) };
  try {
    return (await exclusive(() =>
      runWorkerTask<Req, Res>({
        create: createWorker,
        reuse,
        request,
        inline: (r) => runReadDiskTask(r as ReadDiskRequest),
      }),
    )) as DiskState;
  } catch (e) {
    if (e instanceof Error && NEEDS_DOM.test(e.message)) return readDiskState(bytes, password);
    throw await rewrap(e);
  }
}

/** `buildPdf` (copie complète : impression, exportation, extraction), hors du fil principal quand c'est possible. */
export async function buildPdfAuto(
  sourceBytes: Uint8Array,
  state: SaveInput["state"],
  options: SaveInput["options"] = {},
): Promise<{ bytes: Uint8Array; report: SaveResult["report"] }> {
  const { bytes, report } = await savePdfAuto({ source: sourceBytes, state, options, mode: "full" }, false);
  return { bytes, report };
}
