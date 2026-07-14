/**
 * The encrypted file browser. Navigates the node tree, decrypting names in the
 * browser; creates folders, uploads/downloads (encrypt/decrypt) files, renames,
 * shares, and trashes. Every byte on the wire is ciphertext.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Folder, File as FileIcon, FileText, FileSpreadsheet, Presentation, FileType, Image as ImageIcon,
  Upload, FolderPlus, Download, Share2, Pencil, Trash2, ChevronRight, RefreshCw, Home, Users2, FilePlus2, History,
} from "lucide-react";
import { useDrive } from "../session";
import { useDialogs } from "../../ui/dialogs";
import { ApiError } from "../api";
import { listFolder, createFolder, createCollabDoc, createCollabSheet, createCollabSlides, uploadFile, renameNode, downloadFile, nodeKeyFrom, triggerDownload, type DriveEntry, type OpsCtx } from "../ops";
import ShareDialog from "./ShareDialog";
import CollabDocEditor from "./CollabDocEditor";
import CollabSheetEditor from "./CollabSheetEditor";
import CollabSlidesEditor from "./CollabSlidesEditor";
import VersionsDialog from "./VersionsDialog";

function iconFor(e: DriveEntry) {
  if (e.kind === "folder") return <Folder size={18} className="dc-ic dc-ic--folder" />;
  switch (e.appKind) {
    case "collab-doc": return <Users2 size={18} className="dc-ic--collab" />;
    case "collab-sheet": return <FileSpreadsheet size={18} className="dc-ic--collab" />;
    case "collab-slides": return <Presentation size={18} className="dc-ic--collab" />;
    case "doc": return <FileText size={18} />;
    case "sheet": return <FileSpreadsheet size={18} />;
    case "slides": return <Presentation size={18} />;
    case "pdf": return <FileType size={18} />;
    case "image": return <ImageIcon size={18} />;
    default: return <FileIcon size={18} />;
  }
}

function humanSize(n: number): string {
  if (!n) return "—";
  const u = ["o", "Ko", "Mo", "Go"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i ? 1 : 0)} ${u[i]}`;
}

export default function DriveBrowser() {
  const d = useDrive();
  const dialogs = useDialogs();
  const [path, setPath] = useState<{ id: string; name: string }[]>([]);
  const [entries, setEntries] = useState<DriveEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [shareTarget, setShareTarget] = useState<DriveEntry | null>(null);
  const [versionsTarget, setVersionsTarget] = useState<DriveEntry | null>(null);
  const [collab, setCollab] = useState<{ kind: "doc" | "sheet" | "slides"; entry: DriveEntry; nodeKey: Uint8Array } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const ctx = useMemo<OpsCtx | null>(() => {
    if (!d.keys || !d.user || !d.currentOrg) return null;
    return {
      api: d.api,
      keys: d.keys,
      userId: d.user.id,
      orgId: d.currentOrg.id,
      orgPublicHex: d.currentOrg.orgPublicHex,
      roleIdByKey: d.roleIdByKey,
    };
  }, [d.api, d.keys, d.user, d.currentOrg, d.roleIdByKey]);

  // The breadcrumb holds node ids from whichever org we were browsing. Those
  // ids don't exist in a differently-scoped org, so switching orgs must drop
  // back to the root — otherwise the crumbs keep showing the old org's folder
  // names while the (failed) reload silently empties the listing.
  useEffect(() => {
    setPath([]);
  }, [d.currentOrg?.id]);

  const currentId = path.length ? path[path.length - 1]!.id : null;

  const reload = useCallback(async () => {
    if (!ctx) return;
    setLoading(true);
    setErr(null);
    try {
      setEntries(await listFolder(ctx, currentId));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Chargement impossible.");
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [ctx, currentId]);

  useEffect(() => { void reload(); }, [reload]);

  const canCreateHere = currentId
    ? true // server enforces node.create on the parent
    : (d.currentOrg?.roleKey === "owner" || d.currentOrg?.roleKey === "admin" || d.currentOrg?.roleKey === "manager");

  const newFolder = async () => {
    if (!ctx) return;
    const name = await dialogs.prompt({ title: "Nouveau dossier", label: "Nom du dossier", defaultValue: "Dossier" });
    if (!name) return;
    try {
      await createFolder(ctx, currentId, name);
      await reload();
    } catch (e) {
      await dialogs.alert({ title: "Création impossible", message: e instanceof Error ? e.message : "Erreur." });
    }
  };

  const newCollab = async (kind: "doc" | "sheet" | "slides") => {
    if (!ctx) return;
    const label = kind === "doc" ? "Document" : kind === "sheet" ? "Tableur" : "Présentation";
    const name = await dialogs.prompt({ title: `${label} collaboratif`, label: `Nom`, defaultValue: `${label} sans titre` });
    if (!name) return;
    try {
      const create = kind === "doc" ? createCollabDoc : kind === "sheet" ? createCollabSheet : createCollabSlides;
      await create(ctx, currentId, name);
      await reload();
    } catch (e) {
      await dialogs.alert({ title: "Création impossible", message: e instanceof Error ? e.message : "Erreur." });
    }
  };

  const openCollab = async (e: DriveEntry) => {
    if (!ctx) return;
    const key = await nodeKeyFrom(ctx, e.myWrappedKey);
    if (!key) {
      await dialogs.alert({ title: "Ouverture impossible", message: "Clé du document indisponible." });
      return;
    }
    const kind = e.appKind === "collab-sheet" ? "sheet" : e.appKind === "collab-slides" ? "slides" : "doc";
    setCollab({ kind, entry: e, nodeKey: key });
  };

  const onUpload = async (ev: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(ev.target.files ?? []);
    ev.target.value = "";
    if (!ctx || !files.length) return;
    setLoading(true);
    try {
      for (const f of files) await uploadFile(ctx, currentId, f);
      await reload();
    } catch (e) {
      await dialogs.alert({ title: "Envoi impossible", message: e instanceof Error ? e.message : "Erreur." });
    } finally {
      setLoading(false);
    }
  };

  const open = (e: DriveEntry) => {
    if (e.kind === "folder") setPath((p) => [...p, { id: e.id, name: e.name }]);
    else if (e.appKind === "collab-doc" || e.appKind === "collab-sheet" || e.appKind === "collab-slides") void openCollab(e);
    else void download(e);
  };

  const download = async (e: DriveEntry) => {
    if (!ctx) return;
    try {
      const { bytes, name } = await downloadFile(ctx, e);
      triggerDownload(bytes, name);
    } catch (err2) {
      await dialogs.alert({ title: "Téléchargement impossible", message: err2 instanceof Error ? err2.message : "Erreur." });
    }
  };

  const rename = async (e: DriveEntry) => {
    if (!ctx) return;
    const name = await dialogs.prompt({ title: "Renommer", label: "Nouveau nom", defaultValue: e.name });
    if (!name || name === e.name) return;
    try {
      await renameNode(ctx, e, name);
      await reload();
    } catch (err2) {
      await dialogs.alert({ title: "Renommage impossible", message: err2 instanceof Error ? err2.message : "Erreur." });
    }
  };

  const trash = async (e: DriveEntry) => {
    const ok = await dialogs.confirm({ title: "Mettre à la corbeille", message: `Déplacer « ${e.name} » vers la corbeille ?`, danger: true, confirmLabel: "Corbeille" });
    if (!ok) return;
    try {
      await d.api.trashNode(e.id);
      await reload();
    } catch (err2) {
      await dialogs.alert({ title: "Suppression impossible", message: err2 instanceof Error ? err2.message : "Erreur." });
    }
  };

  return (
    <div className="dc-browser">
      <div className="dc-toolbar">
        <nav className="dc-crumbs">
          <button className="dc-crumb" onClick={() => setPath([])}><Home size={14} /> Racine</button>
          {path.map((p, i) => (
            <span key={p.id} className="dc-crumb-wrap">
              <ChevronRight size={13} className="dc-crumb-sep" />
              <button className="dc-crumb" onClick={() => setPath((cur) => cur.slice(0, i + 1))}>{p.name}</button>
            </span>
          ))}
        </nav>
        <div className="dc-toolbar__spacer" />
        <button className="eb eb--sm eb--outline" onClick={newFolder} disabled={!canCreateHere} title={canCreateHere ? "" : "Vous n'avez pas le droit de créer ici"}>
          <FolderPlus size={15} /> Dossier
        </button>
        <button className="eb eb--sm eb--outline" onClick={() => void newCollab("doc")} disabled={!canCreateHere} title="Document collaboratif (co-édition temps réel)">
          <FilePlus2 size={15} /> Doc
        </button>
        <button className="eb eb--sm eb--outline" onClick={() => void newCollab("sheet")} disabled={!canCreateHere} title="Tableur collaboratif (co-édition temps réel)">
          <FileSpreadsheet size={15} /> Tableur
        </button>
        <button className="eb eb--sm eb--outline" onClick={() => void newCollab("slides")} disabled={!canCreateHere} title="Présentation collaborative (co-édition temps réel)">
          <Presentation size={15} /> Présentation
        </button>
        <button className="eb eb--sm eb--primary" onClick={() => fileRef.current?.click()} disabled={!canCreateHere}>
          <Upload size={15} /> Importer
        </button>
        <button className="icon-btn" title="Actualiser" onClick={() => void reload()}><RefreshCw size={15} /></button>
        <input ref={fileRef} type="file" multiple hidden onChange={onUpload} />
      </div>

      {err && <p className="dc-error">{err}</p>}

      {loading ? (
        <p className="muted dc-pad">Chargement…</p>
      ) : entries.length === 0 ? (
        <div className="dc-empty-list">
          <Folder size={34} />
          <p>{currentId ? "Ce dossier est vide." : "Aucun fichier."} {canCreateHere ? "Créez un dossier ou importez un fichier." : "Demandez à un administrateur de partager un espace avec vous."}</p>
        </div>
      ) : (
        <table className="dc-table">
          <thead>
            <tr><th>Nom</th><th>Taille</th><th>Modifié</th><th className="dc-table__actions">Actions</th></tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id} className="dc-row" onDoubleClick={() => open(e)}>
                <td className="dc-row__name" onClick={() => open(e)}>{iconFor(e)}<span>{e.name}</span></td>
                <td className="dc-row__muted">{e.kind === "folder" ? "—" : humanSize(e.sizeBytes)}</td>
                <td className="dc-row__muted">{new Date(e.modifiedAt).toLocaleDateString("fr-FR")}</td>
                <td className="dc-row__actions">
                  {e.kind === "file" && !String(e.appKind ?? "").startsWith("collab-") && <button className="icon-btn" title="Télécharger" onClick={() => void download(e)}><Download size={15} /></button>}
                  {e.kind === "file" && !String(e.appKind ?? "").startsWith("collab-") && <button className="icon-btn" title="Historique des versions" onClick={() => setVersionsTarget(e)}><History size={15} /></button>}
                  <button className="icon-btn" title="Partager" onClick={() => setShareTarget(e)}><Share2 size={15} /></button>
                  <button className="icon-btn" title="Renommer" onClick={() => void rename(e)}><Pencil size={15} /></button>
                  <button className="icon-btn icon-btn--danger" title="Corbeille" onClick={() => void trash(e)}><Trash2 size={15} /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {shareTarget && ctx && (
        <ShareDialog ctx={ctx} entry={shareTarget} onClose={() => setShareTarget(null)} />
      )}

      {versionsTarget && ctx && (
        <VersionsDialog ctx={ctx} entry={versionsTarget} onClose={() => setVersionsTarget(null)} />
      )}

      {collab && ctx && d.user && (() => {
        const common = {
          api: ctx.api,
          nodeId: collab.entry.id,
          nodeKey: collab.nodeKey,
          title: collab.entry.name,
          user: { id: d.user.id, name: d.user.displayName || d.user.email },
          onClose: () => setCollab(null),
          // After a key rotation the relay evicts the room; re-unwrap our
          // (freshly re-wrapped) node key and resume seamlessly.
          //
          // getNode() failing does NOT necessarily mean access was revoked —
          // it can just as well be a transient network hiccup, a timeout, or a
          // server 5xx during the rotation. Only a confirmed 403/404 (or the
          // server telling us we have no key share for the node) means access
          // was actually revoked; anything else is retried a few times before
          // giving up, and if still failing, the error is rethrown so the
          // caller (EncryptedCollabChannel) treats it like an ordinary
          // reconnect instead of a permanent, definitive closure.
          refetchKey: async () => {
            const attempts = 3;
            for (let i = 0; i < attempts; i++) {
              try {
                const { myWrappedKey } = await ctx.api.getNode(collab.entry.id);
                return await nodeKeyFrom(ctx, myWrappedKey);
              } catch (e) {
                if (e instanceof ApiError && (e.status === 403 || e.status === 404)) {
                  return null; // access genuinely revoked — stop for good
                }
                if (i === attempts - 1) throw e; // transient — let the caller retry later
                await new Promise((r) => setTimeout(r, 400 * (i + 1)));
              }
            }
            return null;
          },
        };
        if (collab.kind === "sheet") return <CollabSheetEditor key={collab.entry.id} {...common} />;
        if (collab.kind === "slides") return <CollabSlidesEditor key={collab.entry.id} {...common} />;
        return <CollabDocEditor key={collab.entry.id} {...common} />;
      })()}
    </div>
  );
}
