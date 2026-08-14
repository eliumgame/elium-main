/**
 * The encrypted file browser.
 *
 * Navigates the node tree, decrypting names in the browser; creates folders and
 * co-edited documents, uploads/downloads (encrypt/decrypt), renames, moves,
 * shares and trashes. Every byte on the wire is ciphertext.
 *
 * The listing itself is deliberately dumb: sorting, filtering, selection ranges
 * and drop legality all live in `browser-model.ts`, which is unit-tested.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownUp, ChevronRight, Download, File as FileIcon, FileSpreadsheet, FileText, FileType,
  FilePlus2, Folder, FolderPlus, Grid2x2, History, Home, Image as ImageIcon, Info, LayoutList,
  Loader2, PenLine, Pencil, Presentation, RefreshCw, Search, Share2, Trash2, Upload, Users2, X,
} from "lucide-react";
import { useDrive } from "../session";
import { useDialogs } from "../../ui/dialogs";
import { ApiError } from "../api";
import {
  listFolder, createFolder, createCollabDoc, createCollabSheet, createCollabSlides, uploadFile,
  renameNode, downloadFile, nodeKeyFrom, triggerDownload, type DriveEntry, type OpsCtx,
} from "../ops";
import {
  EMPTY_FILTER, FILTER_LABELS, canDropInto, humanDate, humanSize, isCollab,
  movePayload, nextSelection, pruneSelection, quotaState, selectionSummary, visibleEntries,
  type BrowserFilter, type SortDir, type SortKey, type ViewMode,
} from "../browser-model";
import ShareDialog from "./ShareDialog";
import SignRequestDialog from "./SignRequestDialog";
import CollabDocEditor from "./CollabDocEditor";
import CollabSheetEditor from "./CollabSheetEditor";
import CollabSlidesEditor from "./CollabSlidesEditor";
import VersionsDialog from "./VersionsDialog";
import { importToDoc } from "../../format/importers";
import { docxToDoc } from "../../format/docx";
import type { ProseMirrorNode } from "../../format/types";

/** Extensions qu'on sait ouvrir dans le VRAI éditeur (import → document éditable). */
const DOC_IMPORT_EXT = new Set(["txt", "md", "markdown", "html", "htm", "docx"]);

/**
 * Le contenu d'un fichier-document, prêt pour l'éditeur, ou `null` si le format
 * n'est pas un document texte (image, PDF, tableur… → restent des blobs).
 *
 * Le DOCX se lit en binaire ; les formats texte passent par le dispatcher
 * d'import partagé avec la suite locale (même code, même rendu).
 */
async function parseImportedDoc(file: File): Promise<ProseMirrorNode | null> {
  const ext = file.name.toLowerCase().split(".").pop() ?? "";
  if (!DOC_IMPORT_EXT.has(ext)) return null;
  try {
    if (ext === "docx") return docxToDoc(new Uint8Array(await file.arrayBuffer())).doc;
    return importToDoc(file.name, await file.text());
  } catch {
    // Un import illisible ne doit pas bloquer : l'appelant retombe sur le blob.
    return null;
  }
}

function iconFor(e: DriveEntry, size = 18) {
  if (e.kind === "folder") return <Folder size={size} className="dc-ic dc-ic--folder" />;
  switch (e.appKind) {
    case "collab-doc": return <Users2 size={size} className="dc-ic--collab" />;
    case "collab-sheet": return <FileSpreadsheet size={size} className="dc-ic--collab" />;
    case "collab-slides": return <Presentation size={size} className="dc-ic--collab" />;
    case "doc": return <FileText size={size} />;
    case "sheet": return <FileSpreadsheet size={size} />;
    case "slides": return <Presentation size={size} />;
    case "pdf": return <FileType size={size} />;
    case "image": return <ImageIcon size={size} />;
    default: return <FileIcon size={size} />;
  }
}

const SORT_LABELS: { id: SortKey; label: string }[] = [
  { id: "name", label: "Nom" },
  { id: "modified", label: "Modifié" },
  { id: "size", label: "Taille" },
  { id: "kind", label: "Type" },
];

export default function DriveBrowser() {
  const d = useDrive();
  const dialogs = useDialogs();
  const [path, setPath] = useState<{ id: string; name: string }[]>([]);
  const [entries, setEntries] = useState<DriveEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [shareTarget, setShareTarget] = useState<DriveEntry | null>(null);
  const [signTarget, setSignTarget] = useState<DriveEntry | null>(null);
  const [versionsTarget, setVersionsTarget] = useState<DriveEntry | null>(null);
  const [collab, setCollab] = useState<{ kind: "doc" | "sheet" | "slides"; entry: DriveEntry; nodeKey: Uint8Array; seed?: ProseMirrorNode } | null>(null);

  const [view, setView] = useState<ViewMode>("list");
  const [filter, setFilter] = useState<BrowserFilter>(EMPTY_FILTER);
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [selection, setSelection] = useState<string[]>([]);
  const [anchor, setAnchor] = useState<string | null>(null);
  const [details, setDetails] = useState(false);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [fileDragOver, setFileDragOver] = useState(false);
  const [usage, setUsage] = useState<{ usedBytes: number; quotaBytes: number | null } | null>(null);

  const fileRef = useRef<HTMLInputElement>(null);
  const draggingIds = useRef<string[]>([]);

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
    setSelection([]);
  }, [d.currentOrg?.id]);

  const currentId = path.length ? path[path.length - 1]!.id : null;

  const reload = useCallback(async () => {
    if (!ctx) return;
    setLoading(true);
    setErr(null);
    try {
      const next = await listFolder(ctx, currentId);
      setEntries(next);
      setSelection((sel) => pruneSelection(sel, next));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Chargement impossible.");
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [ctx, currentId]);

  useEffect(() => { void reload(); }, [reload]);

  // Rafraîchissement SILENCIEUX (ni spinner, ni vidage en cas d'erreur
  // transitoire) : sert au rafraîchissement automatique ci-dessous sans faire
  // clignoter l'affichage courant.
  const silentRefresh = useCallback(async () => {
    if (!ctx) return;
    try {
      const next = await listFolder(ctx, currentId);
      setEntries(next);
      setSelection((sel) => pruneSelection(sel, next));
    } catch {
      /* transitoire (réseau/token en cours de refresh) : on garde l'affichage */
    }
  }, [ctx, currentId]);

  // `silentRefresh` change à chaque navigation de dossier ; on le garde dans une
  // ref pour que l'abonnement WS (branché sur l'ORG) n'ait pas à se reconnecter
  // en changeant de dossier.
  const silentRefreshRef = useRef(silentRefresh);
  silentRefreshRef.current = silentRefresh;

  // Actualisations INSTANTANÉES via WebSocket : le serveur pousse un ping
  // « nodes-changed » (sans contenu) à chaque mutation dans l'organisation ; on
  // rafraîchit le dossier courant dans la foulée (débounce pour coalescer les
  // rafales). Reconnexion automatique. Un poll de SECOURS très espacé couvre les
  // coupures WS (proxys, veille). setTimeout, jamais rAF (gelé hors 1er plan).
  const orgId = ctx?.orgId;
  useEffect(() => {
    if (!orgId) return;
    let closed = false;
    let ws: WebSocket | null = null;
    let debounce: number | undefined;
    let reconnect: number | undefined;
    const bump = () => {
      window.clearTimeout(debounce);
      debounce = window.setTimeout(() => { if (document.visibilityState !== "hidden") void silentRefreshRef.current(); }, 250);
    };
    const connect = () => {
      if (closed) return;
      try {
        ws = new WebSocket(d.api.orgEventsSocketUrl(orgId));
      } catch {
        reconnect = window.setTimeout(connect, 4000);
        return;
      }
      ws.onmessage = (ev) => {
        try { if ((JSON.parse(String(ev.data)) as { type?: string }).type === "nodes-changed") bump(); }
        catch { /* ping non-JSON ignoré */ }
      };
      ws.onclose = () => { if (!closed) { window.clearTimeout(reconnect); reconnect = window.setTimeout(connect, 4000); } };
      ws.onerror = () => { try { ws?.close(); } catch { /* ignore */ } };
    };
    connect();
    // Filet de sécurité : poll rare (25 s) seulement quand l'onglet est visible,
    // + rafraîchissement au retour de focus (couvre une reconnexion manquée).
    const poll = window.setInterval(() => { if (document.visibilityState === "visible") void silentRefreshRef.current(); }, 25000);
    const onVisible = () => { if (document.visibilityState === "visible") void silentRefreshRef.current(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      closed = true;
      window.clearTimeout(debounce);
      window.clearTimeout(reconnect);
      window.clearInterval(poll);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      try { ws?.close(); } catch { /* ignore */ }
    };
  }, [orgId, d.api]);

  // Storage gauge — refreshed alongside the listing, best effort.
  useEffect(() => {
    if (!ctx) return;
    let cancelled = false;
    void d.api.getOrgUsage(ctx.orgId)
      .then((u) => { if (!cancelled) setUsage({ usedBytes: u.usedBytes, quotaBytes: u.quotaBytes }); })
      .catch(() => { /* quota is informational */ });
    return () => { cancelled = true; };
  }, [ctx, d.api, entries.length]);

  const canCreateHere = currentId
    ? true // server enforces node.create on the parent
    : (d.currentOrg?.roleKey === "owner" || d.currentOrg?.roleKey === "admin" || d.currentOrg?.roleKey === "manager");

  const shown = useMemo(
    () => visibleEntries(entries, filter, sortKey, sortDir),
    [entries, filter, sortKey, sortDir],
  );
  const shownIds = useMemo(() => shown.map((e) => e.id), [shown]);
  const selected = useMemo(() => entries.filter((e) => selection.includes(e.id)), [entries, selection]);
  const only = selected.length === 1 ? selected[0] : null;

  // -- actions ---------------------------------------------------------------

  const fail = async (title: string, e: unknown) => {
    await dialogs.alert({ title, message: e instanceof Error ? e.message : "Erreur." });
  };

  const newFolder = async () => {
    if (!ctx) return;
    const name = await dialogs.prompt({ title: "Nouveau dossier", label: "Nom du dossier", defaultValue: "Dossier" });
    if (!name) return;
    try {
      await createFolder(ctx, currentId, name);
      await reload();
    } catch (e) { await fail("Création impossible", e); }
  };

  const newCollab = async (kind: "doc" | "sheet" | "slides") => {
    if (!ctx) return;
    const label = kind === "doc" ? "Document" : kind === "sheet" ? "Tableur" : "Présentation";
    const name = await dialogs.prompt({ title: `${label} collaboratif`, label: "Nom", defaultValue: `${label} sans titre` });
    if (!name) return;
    try {
      const create = kind === "doc" ? createCollabDoc : kind === "sheet" ? createCollabSheet : createCollabSlides;
      const node = await create(ctx, currentId, name);
      // Recharge la liste ET ouvre l'éditeur tout de suite : créer un fichier
      // pour devoir ensuite le retrouver et double-cliquer était le pas de trop.
      // On relit le dossier directement (l'état `entries` ne serait pas encore à
      // jour dans ce tour de rendu) afin de retrouver le nœud fraîchement créé.
      const next = await listFolder(ctx, currentId);
      setEntries(next);
      const entry = next.find((e) => e.id === node.id);
      if (entry) await openCollab(entry);
    } catch (e) { await fail("Création impossible", e); }
  };

  const openCollab = async (e: DriveEntry, seed?: ProseMirrorNode) => {
    if (!ctx) return;
    const key = await nodeKeyFrom(ctx, e.myWrappedKey);
    if (!key) {
      await dialogs.alert({ title: "Ouverture impossible", message: "Clé du document indisponible." });
      return;
    }
    const kind = e.appKind === "collab-sheet" ? "sheet" : e.appKind === "collab-slides" ? "slides" : "doc";
    setCollab({ kind, entry: e, nodeKey: key, ...(seed ? { seed } : {}) });
  };

  /**
   * Import d'un fichier-document : au lieu d'un blob inerte, on crée un document
   * collaboratif et on l'ouvre dans le VRAI éditeur, amorcé avec le contenu du
   * fichier. Les formats non-document (image, PDF, tableur…) retombent sur
   * l'envoi chiffré ordinaire.
   */
  const importAsDoc = async (file: File): Promise<boolean> => {
    if (!ctx) return false;
    const doc = await parseImportedDoc(file);
    if (!doc) return false; // pas un document texte : laisser l'appelant l'envoyer en blob
    const name = file.name.replace(/\.[^.]+$/, "") || file.name;
    const node = await createCollabDoc(ctx, currentId, name);
    const next = await listFolder(ctx, currentId);
    setEntries(next);
    const entry = next.find((e) => e.id === node.id);
    if (entry) await openCollab(entry, doc);
    return true;
  };

  const uploadMany = useCallback(async (files: File[]) => {
    if (!ctx || !files.length) return;
    try {
      for (let i = 0; i < files.length; i++) {
        setBusyLabel(`Chiffrement et envoi ${i + 1}/${files.length} — ${files[i].name}`);
        await uploadFile(ctx, currentId, files[i]);
      }
      await reload();
    } catch (e) {
      await fail("Envoi impossible", e);
    } finally {
      setBusyLabel(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx, currentId, reload]);

  /**
   * Point d'entrée de l'import (bouton et glisser-déposer).
   *
   * Un SEUL fichier-document ouvre le vrai éditeur, amorcé avec son contenu.
   * Plusieurs fichiers, ou un format non-document, partent en envoi chiffré
   * ordinaire — ouvrir un éditeur n'aurait pas de sens pour un lot ou une image.
   */
  const handleImport = useCallback(async (files: File[]) => {
    if (!ctx || !files.length) return;
    if (files.length === 1) {
      try {
        setBusyLabel(`Import — ${files[0].name}`);
        const opened = await importAsDoc(files[0]);
        if (opened) return;
      } catch (e) {
        await fail("Import impossible", e);
        return;
      } finally {
        setBusyLabel(null);
      }
    }
    await uploadMany(files);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx, currentId, uploadMany]);

  const onUpload = async (ev: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(ev.target.files ?? []);
    ev.target.value = "";
    await handleImport(files);
  };

  const open = (e: DriveEntry) => {
    if (e.kind === "folder") { setPath((p) => [...p, { id: e.id, name: e.name }]); setSelection([]); }
    else if (isCollab(e)) void openCollab(e);
    else void download(e);
  };

  const download = async (e: DriveEntry) => {
    if (!ctx) return;
    try {
      setBusyLabel(`Déchiffrement — ${e.name}`);
      const { bytes, name } = await downloadFile(ctx, e);
      triggerDownload(bytes, name);
    } catch (e2) { await fail("Téléchargement impossible", e2); }
    finally { setBusyLabel(null); }
  };

  const rename = async (e: DriveEntry) => {
    if (!ctx) return;
    const name = await dialogs.prompt({ title: "Renommer", label: "Nouveau nom", defaultValue: e.name });
    if (!name || name === e.name) return;
    try {
      await renameNode(ctx, e, name);
      await reload();
    } catch (e2) { await fail("Renommage impossible", e2); }
  };

  const trashMany = async (targets: DriveEntry[]) => {
    if (!targets.length) return;
    const label = targets.length === 1 ? `« ${targets[0].name} »` : `${targets.length} éléments`;
    const ok = await dialogs.confirm({
      title: "Mettre à la corbeille",
      message: `Déplacer ${label} vers la corbeille ?`,
      danger: true,
      confirmLabel: "Corbeille",
    });
    if (!ok) return;
    try {
      setBusyLabel("Suppression…");
      for (const t of targets) await d.api.trashNode(t.id);
      setSelection([]);
      await reload();
    } catch (e) { await fail("Suppression impossible", e); }
    finally { setBusyLabel(null); }
  };

  /** Move by drag & drop. The server re-fans the key shares for the new parent. */
  const moveTo = async (targetId: string | null, dragged: DriveEntry[]) => {
    const payload = movePayload(dragged, targetId);
    if (!payload.length) return;
    try {
      setBusyLabel(payload.length === 1 ? "Déplacement…" : `Déplacement de ${payload.length} éléments…`);
      for (const p of payload) await d.api.patchNode(p.id, { parentId: p.parentId });
      setSelection([]);
      await reload();
    } catch (e) { await fail("Déplacement impossible", e); }
    finally { setBusyLabel(null); }
  };

  // -- selection & keyboard --------------------------------------------------

  const click = (e: React.MouseEvent, entry: DriveEntry) => {
    const { selection: next, anchor: nextAnchor } = nextSelection(
      shownIds, selection, anchor, entry.id, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey },
    );
    setSelection(next);
    setAnchor(nextAnchor);
  };

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const t = ev.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (collab || shareTarget || signTarget || versionsTarget) return;
      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "a") {
        ev.preventDefault();
        setSelection(shownIds);
        return;
      }
      if (ev.key === "Escape") { setSelection([]); return; }
      if (ev.key === "Enter" && only) { ev.preventDefault(); open(only); return; }
      if (ev.key === "F2" && only) { ev.preventDefault(); void rename(only); return; }
      if (ev.key === "Delete" && selected.length) { ev.preventDefault(); void trashMany(selected); return; }
      if (ev.key === "Backspace" && path.length) { ev.preventDefault(); setPath((p) => p.slice(0, -1)); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownIds, only, selected, path.length, collab, shareTarget, signTarget, versionsTarget]);

  // -- render ----------------------------------------------------------------

  const gauge = usage ? quotaState(usage.usedBytes, usage.quotaBytes) : null;

  const rowProps = (e: DriveEntry) => ({
    draggable: true,
    onDragStart: (ev: React.DragEvent) => {
      const ids = selection.includes(e.id) ? selection : [e.id];
      draggingIds.current = ids;
      if (!selection.includes(e.id)) setSelection(ids);
      ev.dataTransfer.effectAllowed = "move";
      ev.dataTransfer.setData("text/plain", ids.join(","));
    },
    onDragEnd: () => { draggingIds.current = []; setDropTarget(null); },
    onDragOver: (ev: React.DragEvent) => {
      const dragged = entries.filter((x) => draggingIds.current.includes(x.id));
      if (!canDropInto(dragged, e, currentId)) return;
      ev.preventDefault();
      ev.dataTransfer.dropEffect = "move";
      setDropTarget(e.id);
    },
    onDragLeave: () => setDropTarget((t) => (t === e.id ? null : t)),
    onDrop: (ev: React.DragEvent) => {
      ev.preventDefault();
      ev.stopPropagation();
      setDropTarget(null);
      const dragged = entries.filter((x) => draggingIds.current.includes(x.id));
      if (canDropInto(dragged, e, currentId)) void moveTo(e.id, dragged);
      draggingIds.current = [];
    },
    onClick: (ev: React.MouseEvent) => click(ev, e),
    onDoubleClick: () => open(e),
  });

  return (
    <div
      className={`dcx elx ${fileDragOver ? "is-filedrop" : ""}`}
      onDragOver={(ev) => {
        if (!ev.dataTransfer.types.includes("Files")) return;
        ev.preventDefault();
        setFileDragOver(true);
      }}
      onDragLeave={(ev) => { if (ev.currentTarget === ev.target) setFileDragOver(false); }}
      onDrop={(ev) => {
        if (!ev.dataTransfer.types.includes("Files")) return;
        ev.preventDefault();
        setFileDragOver(false);
        void handleImport(Array.from(ev.dataTransfer.files ?? []));
      }}
    >
      {/* --- breadcrumbs + creation ------------------------------------- */}
      <div className="dcx-bar">
        <nav className="dcx-crumbs">
          <button
            className={`dcx-crumb ${dropTarget === "__root" ? "is-drop" : ""}`}
            onClick={() => { setPath([]); setSelection([]); }}
            onDragOver={(ev) => {
              const dragged = entries.filter((x) => draggingIds.current.includes(x.id));
              if (!canDropInto(dragged, null, currentId)) return;
              ev.preventDefault();
              setDropTarget("__root");
            }}
            onDragLeave={() => setDropTarget((t) => (t === "__root" ? null : t))}
            onDrop={(ev) => {
              ev.preventDefault();
              setDropTarget(null);
              const dragged = entries.filter((x) => draggingIds.current.includes(x.id));
              if (canDropInto(dragged, null, currentId)) void moveTo(null, dragged);
            }}
          >
            <Home size={14} /> Racine
          </button>
          {path.map((p, i) => (
            <span key={p.id} className="dcx-crumb-wrap">
              <ChevronRight size={13} className="dcx-crumb-sep" />
              <button
                className={`dcx-crumb ${dropTarget === p.id ? "is-drop" : ""}`}
                onClick={() => { setPath((cur) => cur.slice(0, i + 1)); setSelection([]); }}
                onDragOver={(ev) => {
                  if (i === path.length - 1) return; // already here
                  const dragged = entries.filter((x) => draggingIds.current.includes(x.id));
                  if (!dragged.length) return;
                  ev.preventDefault();
                  setDropTarget(p.id);
                }}
                onDragLeave={() => setDropTarget((t) => (t === p.id ? null : t))}
                onDrop={(ev) => {
                  ev.preventDefault();
                  setDropTarget(null);
                  const dragged = entries.filter((x) => draggingIds.current.includes(x.id));
                  if (dragged.length) void moveTo(p.id, dragged);
                }}
              >
                {p.name}
              </button>
            </span>
          ))}
        </nav>

        <span className="elx-spacer" />

        <button className="elx-mini" onClick={newFolder} disabled={!canCreateHere} title={canCreateHere ? "Nouveau dossier" : "Vous n'avez pas le droit de créer ici"}>
          <FolderPlus size={14} /> Dossier
        </button>
        <button className="elx-mini" onClick={() => void newCollab("doc")} disabled={!canCreateHere} title="Document collaboratif (co-édition temps réel)">
          <FilePlus2 size={14} /> Doc
        </button>
        <button className="elx-mini" onClick={() => void newCollab("sheet")} disabled={!canCreateHere} title="Tableur collaboratif">
          <FileSpreadsheet size={14} /> Tableur
        </button>
        <button className="elx-mini" onClick={() => void newCollab("slides")} disabled={!canCreateHere} title="Présentation collaborative">
          <Presentation size={14} /> Présentation
        </button>
        <button className="elx-mini elx-mini--primary" onClick={() => fileRef.current?.click()} disabled={!canCreateHere}>
          <Upload size={14} /> Importer
        </button>
        <button className="elx-icon" title="Actualiser" onClick={() => void reload()}><RefreshCw size={15} /></button>
        <input ref={fileRef} type="file" multiple hidden onChange={onUpload} />
      </div>

      {/* --- search, filters, sort, view --------------------------------- */}
      <div className="dcx-filters">
        <label className="dcx-search">
          <Search size={14} />
          <input
            value={filter.query}
            placeholder="Rechercher dans ce dossier…"
            onChange={(e) => setFilter((f) => ({ ...f, query: e.target.value }))}
          />
          {filter.query && (
            <button className="elx-icon" title="Effacer" onClick={() => setFilter((f) => ({ ...f, query: "" }))}><X size={13} /></button>
          )}
        </label>

        <div className="elx-chips">
          {FILTER_LABELS.map((f) => (
            <button
              key={f.id}
              className={`elx-chip ${filter.kind === f.id ? "is-on" : ""}`}
              onClick={() => setFilter((cur) => ({ ...cur, kind: cur.kind === f.id ? null : f.id }))}
            >
              {f.label}
            </button>
          ))}
        </div>

        <span className="elx-spacer" />

        <select className="elx-select" value={sortKey} onChange={(e) => setSortKey(e.target.value as SortKey)} title="Trier par">
          {SORT_LABELS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
        <button
          className="elx-icon"
          title={sortDir === "asc" ? "Ordre croissant" : "Ordre décroissant"}
          onClick={() => setSortDir((v) => (v === "asc" ? "desc" : "asc"))}
        >
          <ArrowDownUp size={15} style={{ transform: sortDir === "desc" ? "scaleY(-1)" : undefined }} />
        </button>
        <button className={`elx-icon ${view === "list" ? "is-on" : ""}`} title="Vue liste" onClick={() => setView("list")}><LayoutList size={15} /></button>
        <button className={`elx-icon ${view === "grid" ? "is-on" : ""}`} title="Vue grille" onClick={() => setView("grid")}><Grid2x2 size={15} /></button>
        <button className={`elx-icon ${details ? "is-on" : ""}`} title="Volet de détails" onClick={() => setDetails((v) => !v)}><Info size={15} /></button>
      </div>

      {/* --- bulk action bar --------------------------------------------- */}
      {selected.length > 1 && (
        <div className="dcx-bulk">
          <b>{selected.length} sélectionnés</b>
          <span className="dcx-bulk__meta">{selectionSummary(selected)}</span>
          <span className="elx-spacer" />
          <button className="elx-mini" onClick={() => selected.filter((e) => e.kind === "file" && !isCollab(e)).forEach((e) => void download(e))}>
            <Download size={13} /> Télécharger
          </button>
          <button className="elx-mini elx-mini--danger" onClick={() => void trashMany(selected)}><Trash2 size={13} /> Corbeille</button>
          <button className="elx-icon" title="Désélectionner" onClick={() => setSelection([])}><X size={14} /></button>
        </div>
      )}

      {err && <p className="dc-error">{err}</p>}

      <div className="dcx-body">
        <div className="dcx-listing" onClick={(e) => { if (e.target === e.currentTarget) setSelection([]); }}>
          {loading ? (
            <div className="elx-empty"><Loader2 size={22} className="elx-spin" /><br />Chargement…</div>
          ) : !shown.length ? (
            <div className="elx-empty">
              <Folder size={30} />
              <p>
                {entries.length
                  ? "Aucun élément ne correspond à votre recherche."
                  : currentId ? "Ce dossier est vide." : "Aucun fichier."}
              </p>
              {!entries.length && (
                <p>{canCreateHere
                  ? "Créez un dossier, ou déposez des fichiers ici."
                  : "Demandez à un administrateur de partager un espace avec vous."}</p>
              )}
            </div>
          ) : view === "list" ? (
            <table className="dcx-table">
              <thead>
                <tr>
                  <th>Nom</th>
                  <th className="dcx-col-size">Taille</th>
                  <th className="dcx-col-date">Modifié</th>
                  <th className="dcx-col-actions">Actions</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((e) => (
                  <tr
                    key={e.id}
                    className={`dcx-row ${selection.includes(e.id) ? "is-selected" : ""} ${dropTarget === e.id ? "is-drop" : ""}`}
                    {...rowProps(e)}
                  >
                    <td className="dcx-row__name">{iconFor(e)}<span>{e.name}</span></td>
                    <td className="dcx-row__muted">{e.kind === "folder" ? "—" : humanSize(e.sizeBytes)}</td>
                    <td className="dcx-row__muted" title={new Date(e.modifiedAt).toLocaleString("fr-FR")}>{humanDate(e.modifiedAt)}</td>
                    <td className="dcx-row__actions" onClick={(ev) => ev.stopPropagation()}>
                      {e.kind === "file" && !isCollab(e) && (
                        <>
                          <button className="elx-icon" title="Télécharger" onClick={() => void download(e)}><Download size={15} /></button>
                          <button className="elx-icon" title="Historique des versions" onClick={() => setVersionsTarget(e)}><History size={15} /></button>
                        </>
                      )}
                      <button className="elx-icon" title="Partager" onClick={() => setShareTarget(e)}><Share2 size={15} /></button>
                      {e.appKind === "elium" && (
                        <button className="elx-icon" title="Demander une signature par lien" onClick={() => setSignTarget(e)}><PenLine size={15} /></button>
                      )}
                      <button className="elx-icon" title="Renommer (F2)" onClick={() => void rename(e)}><Pencil size={15} /></button>
                      <button className="elx-icon" title="Corbeille (Suppr)" onClick={() => void trashMany([e])}><Trash2 size={15} /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="dcx-grid">
              {shown.map((e) => (
                <div
                  key={e.id}
                  className={`dcx-tile ${selection.includes(e.id) ? "is-selected" : ""} ${dropTarget === e.id ? "is-drop" : ""}`}
                  {...rowProps(e)}
                >
                  <span className="dcx-tile__icon">{iconFor(e, 30)}</span>
                  <span className="dcx-tile__name" title={e.name}>{e.name}</span>
                  <span className="dcx-tile__meta">
                    {e.kind === "folder" ? "Dossier" : humanSize(e.sizeBytes)} · {humanDate(e.modifiedAt)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {details && (
          <aside className="dcx-details">
            <div className="elx-panel">
              <div className="elx-panel__head">
                <span className="elx-panel__title">Détails</span>
                <button className="elx-icon" onClick={() => setDetails(false)} title="Fermer"><X size={14} /></button>
              </div>
              <div className="elx-panel__body">
                {!only ? (
                  <p className="elx-empty">
                    {selected.length > 1
                      ? `${selected.length} éléments sélectionnés.\n${selectionSummary(selected)}`
                      : "Sélectionnez un élément pour voir ses informations."}
                  </p>
                ) : (
                  <>
                    <div className="dcx-details__hero">
                      {iconFor(only, 34)}
                      <b>{only.name}</b>
                    </div>
                    <dl className="elx-facts">
                      <div><dt>Type</dt><dd>{only.kind === "folder" ? "Dossier" : (only.appKind ?? "Fichier")}</dd></div>
                      <div><dt>Taille</dt><dd>{only.kind === "folder" ? "—" : humanSize(only.sizeBytes)}</dd></div>
                      <div><dt>Modifié</dt><dd>{new Date(only.modifiedAt).toLocaleString("fr-FR")}</dd></div>
                      <div><dt>Créé</dt><dd>{new Date(only.createdAt).toLocaleString("fr-FR")}</dd></div>
                      <div><dt>Chiffrement</dt><dd>bout en bout</dd></div>
                      {only.keyEpoch !== undefined && <div><dt>Génération de clé</dt><dd>{only.keyEpoch}</dd></div>}
                    </dl>
                    <div className="dcx-details__actions">
                      <button className="elx-mini" onClick={() => setShareTarget(only)}><Share2 size={13} /> Partager</button>
                      {only.appKind === "elium" && (
                        <button className="elx-mini" onClick={() => setSignTarget(only)}><PenLine size={13} /> Demander signature</button>
                      )}
                      {only.kind === "file" && !isCollab(only) && (
                        <button className="elx-mini" onClick={() => setVersionsTarget(only)}><History size={13} /> Versions</button>
                      )}
                      <button className="elx-mini" onClick={() => void rename(only)}><Pencil size={13} /> Renommer</button>
                    </div>
                  </>
                )}
              </div>
            </div>
          </aside>
        )}
      </div>

      {/* --- status bar --------------------------------------------------- */}
      <div className="elx-status dcx-status">
        <span>{shown.length} élément{shown.length > 1 ? "s" : ""}{entries.length !== shown.length ? ` sur ${entries.length}` : ""}</span>
        {selected.length > 0 && <><span>·</span><span>{selectionSummary(selected)}</span></>}
        {busyLabel && <><span>·</span><span><Loader2 size={12} className="elx-spin" /> {busyLabel}</span></>}
        <span className="elx-status__spacer" />
        {gauge && (
          <span className={`dcx-quota is-${gauge.tone}`} title="Stockage utilisé par l'organisation">
            <span className="dcx-quota__bar"><span style={{ width: `${Math.round(gauge.ratio * 100)}%` }} /></span>
            {gauge.label}
          </span>
        )}
      </div>

      {fileDragOver && (
        <div className="dcx-dropveil"><Upload size={26} /> Déposez pour chiffrer et importer ici</div>
      )}

      {shareTarget && ctx && (
        <ShareDialog ctx={ctx} entry={shareTarget} onClose={() => setShareTarget(null)} />
      )}

      {signTarget && ctx && (
        <SignRequestDialog ctx={ctx} entry={signTarget} onClose={() => setSignTarget(null)} />
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
        return <CollabDocEditor key={collab.entry.id} {...common} seed={collab.seed} />;
      })()}
    </div>
  );
}
