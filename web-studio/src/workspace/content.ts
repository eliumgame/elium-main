/**
 * Câblage RÉEL de l'espace de travail sur IndexedDB : catalogue, magasins de
 * contenu (bibliothèque .elium, classeurs, présentations, PDF), duplication de
 * documents, import des anciens contenus, effacement des données annexes.
 * (La logique elle-même vit dans service.ts / model.ts, testée sans navigateur.)
 */
import type { VaultSecret } from "../crypto/local-vault";
import { WORKSPACE_SPEC } from "../format/db-specs";
import {
  deleteDriveDocs,
  driveDocInfo,
  getDriveDoc,
  listDriveDocs,
  listDriveKeys,
  putDriveDoc,
} from "../format/drive-store";
import { deleteDraft } from "../format/drafts-store";
import { EliumPackageError, readEliumPackage, writeEliumPackage } from "../format/elium-package";
import { deleteVersion, listVersions } from "../format/versions-store";
import { deleteWorkflow } from "../format/parapheur-store";
import { LEGACY_WORKBOOK_ID, sheetStore } from "../sheet/sheet-store";
import { LEGACY_DECK_ID, deckStore } from "../slides/deck-store";
import type { Workbook } from "../sheet/model";
import type { Deck } from "../slides/model";
import { Catalog } from "./catalog";
import { reencryptDriveVault } from "../format/drive-store";
import { reencryptParapheurVault } from "../format/parapheur-store";
import type { VaultParticipant } from "./vault-sync";
import type { ContentIO } from "./backup-io";
import { idbKv } from "./kv";
import { isDeckPristine, isWorkbookPristine } from "./pristine";
import { pdfStore } from "./pdf-store";
import { WorkspaceService, type ContentApi, type LegacySlot, type UntrackedDoc } from "./service";
import type { FolderRecord, ItemKind, ItemRecord } from "./types";

/** Type d'un .elium d'après son nœud marqueur (tableur / présentations / PDF exportés). Chiffré ou illisible → document. */
export async function sniffEliumKind(bytes: Uint8Array): Promise<ItemKind> {
  try {
    const { file } = await readEliumPackage(bytes, {});
    const t = file.document.doc?.content?.[0]?.type;
    return t === "eliumSheet" ? "sheet" : t === "eliumSlides" ? "slides" : t === "eliumPdf" ? "pdf" : "doc";
  } catch {
    return "doc";
  }
}

/**
 * Copie d'un .elium : même contenu, NOUVEL identifiant interne (sans quoi
 * l'enregistrer remplacerait l'original dans la bibliothèque) et nouveau titre.
 * Le sceau d'origine ne s'applique plus à la copie : elle est réécrite non scellée.
 * Un document chiffré par mot de passe doit être ouvert pour être copié.
 */
export async function duplicateEliumBytes(bytes: Uint8Array, newId: string, newTitle: string): Promise<Uint8Array> {
  let file;
  try {
    ({ file } = await readEliumPackage(bytes, {}));
  } catch (e) {
    if (e instanceof EliumPackageError)
      throw new Error(
        "Ce document est chiffré : ouvrez-le, puis utilisez « Enregistrer sous… » pour en faire une copie.",
      );
    throw e;
  }
  file.manifest.docId = newId;
  file.manifest.title = newTitle;
  return writeEliumPackage(file, {});
}

export function createContentApis(): Record<"drive" | "sheets" | "slides" | "pdfs", ContentApi> {
  return {
    drive: {
      keys: listDriveKeys,
      async info(id) {
        const i = await driveDocInfo(id);
        return i && { size: i.size, updatedAt: i.updatedAt };
      },
      remove: deleteDriveDocs,
    },
    sheets: {
      keys: () => sheetStore.keys(),
      info: (id) => sheetStore.info(id),
      remove: (ids) => sheetStore.removeMany(ids),
      copy: (a, b) => sheetStore.copy(a, b),
    },
    slides: {
      keys: () => deckStore.keys(),
      info: (id) => deckStore.info(id),
      remove: (ids) => deckStore.removeMany(ids),
      copy: (a, b) => deckStore.copy(a, b),
    },
    pdfs: {
      keys: () => pdfStore.keys(),
      info: (id) => pdfStore.info(id),
      remove: (ids) => pdfStore.removeMany(ids),
      copy: (a, b) => pdfStore.copy(a, b),
    },
  };
}

/** Lecture/écriture BRUTE du contenu de chaque élément (sauvegarde et restauration). */
export function createContentIO(
  getSecret: () => VaultSecret | undefined,
): Record<"drive" | "sheets" | "slides" | "pdfs", ContentIO> {
  const json = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
  const parse = <T>(b: Uint8Array) => JSON.parse(new TextDecoder().decode(b)) as T;
  return {
    drive: {
      async read(item) {
        return (await getDriveDoc(item.id, getSecret()))?.bytes;
      },
      async write(item, bytes) {
        await putDriveDoc(
          {
            id: item.id,
            title: item.title,
            profile: item.profile ?? "standard",
            savedAt: item.modifiedAt,
            size: bytes.length,
            bytes,
          },
          getSecret(),
        );
      },
    },
    sheets: {
      async read(item) {
        const wb = await sheetStore.load(item.id, getSecret());
        return wb ? json(wb) : undefined;
      },
      write: (item, bytes) => sheetStore.save(item.id, parse<Workbook>(bytes), getSecret(), item.modifiedAt),
    },
    slides: {
      async read(item) {
        const d = await deckStore.load(item.id, getSecret());
        return d ? json(d) : undefined;
      },
      write: (item, bytes) => deckStore.save(item.id, parse<Deck>(bytes), getSecret(), item.modifiedAt),
    },
    pdfs: {
      async read(item) {
        return (await pdfStore.get(item.id, getSecret()))?.bytes;
      },
      write: (item, bytes) => pdfStore.put({ id: item.id, name: item.title, bytes }, getSecret(), item.modifiedAt),
    },
  };
}

export function createLegacySlots(): LegacySlot[] {
  return [
    {
      store: "sheets",
      legacyId: LEGACY_WORKBOOK_ID,
      title: "Classeur importé",
      async isPristine(secret) {
        const wb = await sheetStore.load(LEGACY_WORKBOOK_ID, secret);
        return !wb || isWorkbookPristine(wb as Workbook);
      },
      move: (a, b) => sheetStore.move(a, b),
    },
    {
      store: "slides",
      legacyId: LEGACY_DECK_ID,
      title: "Présentation importée",
      async isPristine(secret) {
        const d = await deckStore.load(LEGACY_DECK_ID, secret);
        return !d || isDeckPristine(d as Deck);
      },
      move: (a, b) => deckStore.move(a, b),
    },
  ];
}

export function createWorkspaceService(
  getSecret: () => VaultSecret | undefined,
  getCurrentFolder?: () => string | null,
) {
  const catalog = new Catalog({
    items: idbKv<ItemRecord>(WORKSPACE_SPEC, "items"),
    folders: idbKv<FolderRecord>(WORKSPACE_SPEC, "folders"),
    getSecret,
  });
  const service = new WorkspaceService({
    catalog,
    contents: createContentApis(),
    getSecret,
    getCurrentFolder,
    legacySlots: createLegacySlots(),
    async duplicateDoc(id, newId, newTitle) {
      const secret = getSecret();
      const src = await getDriveDoc(id, secret);
      if (!src) throw new Error("Document introuvable dans la bibliothèque.");
      const bytes = await duplicateEliumBytes(src.bytes, newId, newTitle);
      await putDriveDoc(
        {
          id: newId,
          title: newTitle,
          profile: src.profile,
          savedAt: new Date().toISOString(),
          size: bytes.length,
          bytes,
        },
        secret,
      );
      return { size: bytes.length };
    },
    async describeUntrackedDocs(ids): Promise<UntrackedDoc[]> {
      const secret = getSecret();
      const wanted = new Set(ids);
      const entries = (await listDriveDocs(secret)).filter((e) => wanted.has(e.id));
      const out: UntrackedDoc[] = [];
      for (const e of entries) {
        let kind: ItemKind | undefined;
        if (!e.locked) {
          try {
            const full = await getDriveDoc(e.id, secret);
            if (full) kind = await sniffEliumKind(full.bytes);
          } catch {
            /* illisible : traité comme un document */
          }
        }
        out.push({
          id: e.id,
          title: e.title,
          profile: e.profile === "?" ? undefined : e.profile,
          size: e.size,
          savedAt: e.savedAt,
          vaultProtected: e.vaultProtected,
          kind,
        });
      }
      return out;
    },
    async purgeSideData(items) {
      for (const it of items) {
        if (it.contentStore !== "drive") continue;
        await deleteDraft(it.id).catch(() => undefined);
        await deleteWorkflow(it.id).catch(() => undefined);
        for (const v of await listVersions(it.id).catch(() => []))
          if (v.id !== undefined) await deleteVersion(v.id).catch(() => undefined);
      }
    },
  });
  return { catalog, service };
}

/** Tous les magasins à rechiffrer quand le coffre change (ordre : contenus d'abord, catalogue en dernier). */
export function vaultParticipants(catalog: Catalog): VaultParticipant[] {
  return [
    { name: "bibliothèque", reencrypt: reencryptDriveVault },
    { name: "Parapheur", reencrypt: reencryptParapheurVault },
    { name: "classeurs", reencrypt: (a, b) => sheetStore.reencrypt(a, b) },
    { name: "présentations", reencrypt: (a, b) => deckStore.reencrypt(a, b) },
    { name: "PDF", reencrypt: (a, b) => pdfStore.reencrypt(a, b) },
    { name: "catalogue", reencrypt: (a, b) => catalog.reencrypt(a, b) },
  ];
}
