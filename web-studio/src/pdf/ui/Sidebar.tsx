import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  Bookmark,
  ChevronDown,
  Crosshair,
  ExternalLink,
  ChevronRight,
  Copy,
  Download,
  FileText,
  Filter,
  Layers,
  Lock,
  Save,
  MessageSquare,
  Paperclip,
  Pencil,
  Plus,
  RotateCw,
  Search,
  Trash2,
  X,
  Check,
  Ban,
  CircleDot,
  FormInput,
  ArrowUpDown,
} from "lucide-react";
import type { PdfEngine, Attachment, LayerInfo } from "../core/engine";
import { thumbAspect, thumbnailsFor } from "../core/thumbs";
import { scrollIntoRow, stackRows } from "../core/viewer/virtual";
import ThumbCanvas from "./ThumbCanvas";
import { useCurrentPage, type CurrentPage } from "./currentPage";
import { useListWindow } from "./useListWindow";
import type { Annot, Bookmark as Mark, CreatedField, Page, ReviewStatus } from "../model/types";
import { commentable, filterComments, flattenBookmarks, type CommentFilter, type CommentSort } from "../model/doc";
import { textMatches, type SearchHit, type SearchOptions } from "../core/search";
import { KIND_LABEL, shortDate, type SidePanel } from "./state";

/** The multi-panel navigation rail. Each panel mirrors an Acrobat pane. */

export interface SidebarProps {
  panel: SidePanel;
  engine: PdfEngine;
  pages: Page[];
  /** The page being read (the thumbnail pane highlights and follows it). */
  currentPage: CurrentPage;
  selectedPages: string[];
  annots: Annot[];
  bookmarks: Mark[];
  fields: CreatedField[];
  attachments: Attachment[];
  layers: LayerInfo[];
  searchHits: SearchHit[];
  searchIndex: number;
  searchQuery: string;
  /** The find bar's options: comments and bookmarks are matched with them too. */
  searchOptions: SearchOptions;
  searchBusy: boolean;
  filter: CommentFilter;
  sort: CommentSort;
  author: string;
  onGoTo: (page: number) => void;
  onSelectPages: (ids: string[]) => void;
  onReorderPages: (ids: string[], to: number) => void;
  onPageAction: (action: "rotate" | "delete" | "duplicate" | "insert", ids: string[]) => void;
  onSelectAnnot: (id: string) => void;
  onAnnotStatus: (ids: string[], status: ReviewStatus) => void;
  onAnnotReply: (id: string, text: string) => void;
  onAnnotDelete: (ids: string[]) => void;
  onAnnotEditContents: (id: string, text: string) => void;
  /** Acrobat's checkmark. */
  onAnnotCheck: (ids: string[], checked: boolean) => void;
  onReplyEdit: (annotId: string, replyId: string, text: string) => void;
  onReplyDelete: (annotId: string, replyId: string) => void;
  onFilterChange: (f: CommentFilter) => void;
  onSortChange: (s: CommentSort) => void;
  onBookmarkGoTo: (b: Mark) => void;
  onBookmarkAdd: (parentId: string | null) => void;
  onBookmarkRename: (id: string, title: string) => void;
  onBookmarkDelete: (id: string) => void;
  onBookmarkToggle: (id: string) => void;
  /** Point the bookmark at the current view. */
  onBookmarkRetarget: (id: string) => void;
  onSearchSelect: (index: number) => void;
  onLayerToggle: (id: string) => void;
  /** The current visibility becomes the file's default (/OCProperties /D). */
  onLayersSaveDefault: () => void;
  onAttachmentOpen: (a: Attachment) => void;
  onFieldSelect: (id: string) => void;
  onFieldDelete: (id: string) => void;
}

export default function Sidebar(p: SidebarProps) {
  switch (p.panel) {
    case "thumbnails":
      return <Thumbnails {...p} />;
    case "bookmarks":
      return <Bookmarks {...p} />;
    case "comments":
      return <Comments {...p} />;
    case "search":
      return <SearchResults {...p} />;
    case "attachments":
      return <Attachments {...p} />;
    case "layers":
      return <LayersPane {...p} />;
    case "fields":
      return <FieldsPane {...p} />;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Thumbnails
// ---------------------------------------------------------------------------

/** Gap between two thumbnails (`.pdfx-thumbs { gap }`). */
const THUMB_GAP = 10;
/** Widest thumbnail picture (`.pdfx-thumb { max-width: 168px }` minus its padding and borders). */
const THUMB_MAX_W = 154;
/** Extra list height kept mounted above and below the visible part. */
const THUMB_OVERSCAN = 700;
/** The pane follows the current page when the page view is idle, or after this long at most. */
const FOLLOW_MAX_WAIT_MS = 300;

function Thumbnails(p: SidebarProps) {
  const [dragOver, setDragOver] = useState<number | null>(null);
  const dragging = useRef<string[]>([]);
  const current = useCurrentPage(p.currentPage);
  // Latest props for the handlers shared by every (memoised) item.
  const live = useRef(p);
  live.current = p;

  /** Measured once mounted: picture width, and item height minus picture height. */
  const [metrics, setMetrics] = useState({ imgW: 132, chrome: 39 });
  const imgW = Math.max(40, Math.min(THUMB_MAX_W, metrics.imgW));
  // Page sizes start as estimates: the engine's geometry version keys the memo.
  const geometry = p.engine.geometryVersion;
  const items = useMemo(
    () =>
      p.pages.map((page) => {
        const { aspect, rotation } = thumbAspect(p.engine, page);
        return { rotation, imgH: Math.round(imgW * aspect) };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [p.pages, p.engine, imgW, geometry],
  );
  const stack = useMemo(
    () =>
      stackRows(
        items.map((it) => it.imgH + metrics.chrome),
        THUMB_GAP,
      ),
    [items, metrics.chrome],
  );

  // --- windowing: only the thumbnails near the visible part are mounted -----
  const bodyRef = useRef<HTMLDivElement>(null);
  const engine = p.engine;
  const win = useListWindow(bodyRef, {
    overscan: THUMB_OVERSCAN,
    initial: { width: 180, height: 600 },
    // Thumbnails wait for the list to stop moving.
    onScroll: () => thumbnailsFor(engine).noteScroll(),
  });
  const range = win.band(stack);
  const hasItems = !!range;

  // Measure the real item chrome and picture width from a mounted thumbnail
  // (CSS decides them; the windowing maths only needs them to be right).
  useLayoutEffect(() => {
    const el = bodyRef.current?.querySelector<HTMLElement>(".pdfx-thumb");
    const img = el?.querySelector<HTMLElement>(".pdfx-thumb__img");
    const canvas = img?.querySelector("canvas");
    if (!el || !img || !canvas) return;
    const next = { imgW: img.clientWidth, chrome: el.offsetHeight - canvas.offsetHeight };
    if (next.imgW > 0 && (Math.abs(next.imgW - metrics.imgW) > 0.5 || Math.abs(next.chrome - metrics.chrome) > 0.5)) {
      setMetrics(next);
    }
    // Once items exist and whenever the pane's width changes — not on every
    // band change: reading `offsetHeight` forces a layout.
  }, [metrics.imgW, metrics.chrome, win.width, hasItems]);

  // Keep the current page's thumbnail in view, like Acrobat's pane — once the
  // page view has drawn what it shows (or `FOLLOW_MAX_WAIT_MS` later at most,
  // so a long scroll is still followed): scrolling the pane mounts a row of
  // thumbnails, work that must not delay the pages the reader is waiting for.
  const followStack = useRef(stack);
  followStack.current = stack;
  const followTarget = useRef(current);
  const followPending = useRef<(() => void) | null>(null);
  useEffect(() => {
    followTarget.current = current;
    if (followPending.current) return;
    followPending.current = thumbnailsFor(engine).whenIdle(() => {
      followPending.current = null;
      const el = bodyRef.current;
      const st = followStack.current;
      const i = followTarget.current - 1;
      if (!el || i < 0 || i >= st.tops.length) return;
      const to = scrollIntoRow(st, i, el.scrollTop, el.clientHeight);
      if (to != null) el.scrollTop = to;
    }, FOLLOW_MAX_WAIT_MS);
    // Only when the current page changes (or the panel reopens), not on every scroll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);
  useEffect(
    () => () => {
      followPending.current?.();
      followPending.current = null;
    },
    [],
  );

  const onPick = useCallback((id: string, e: React.MouseEvent, index: number) => {
    const q = live.current;
    if (e.shiftKey && q.selectedPages.length) {
      const last = q.pages.findIndex((x) => x.id === q.selectedPages[q.selectedPages.length - 1]);
      const [from, to] = last < index ? [last, index] : [index, last];
      q.onSelectPages(q.pages.slice(from, to + 1).map((x) => x.id));
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      q.onSelectPages(
        q.selectedPages.includes(id) ? q.selectedPages.filter((x) => x !== id) : [...q.selectedPages, id],
      );
      return;
    }
    q.onSelectPages([id]);
    q.onGoTo(index + 1);
  }, []);
  const onAction = useCallback(
    (action: "rotate" | "delete" | "duplicate", id: string) => live.current.onPageAction(action, [id]),
    [],
  );
  const onDragStart = useCallback((id: string, selected: boolean) => {
    dragging.current = selected ? live.current.selectedPages : [id];
  }, []);
  const onDrop = useCallback((index: number) => {
    setDragOver(null);
    if (dragging.current.length) live.current.onReorderPages(dragging.current, index);
    dragging.current = [];
  }, []);

  const selected = useMemo(() => new Set(p.selectedPages), [p.selectedPages]);

  return (
    <div className="pdfx-panel">
      <div className="pdfx-panel__head">
        <span className="pdfx-panel__title">Vignettes</span>
        <span className="pdfx-panel__count">{p.pages.length}</span>
      </div>
      <div className="pdfx-panel__body pdfx-thumbs" ref={bodyRef}>
        {range && range.first > 0 && (
          <div className="pdfx-thumbs__spacer" style={{ height: Math.max(0, stack.tops[range.first] - THUMB_GAP) }} />
        )}
        {range &&
          p.pages.slice(range.first, range.last + 1).map((page, k) => {
            const i = range.first + k;
            return (
              <ThumbItem
                key={page.id}
                engine={p.engine}
                page={page}
                index={i}
                rotation={items[i].rotation}
                width={imgW}
                height={items[i].imgH}
                current={current === i + 1}
                selected={selected.has(page.id)}
                dropTarget={dragOver === i}
                onPick={onPick}
                onAction={onAction}
                onDragStart={onDragStart}
                onDragOverItem={setDragOver}
                onDrop={onDrop}
              />
            );
          })}
        {range && range.last < p.pages.length - 1 && (
          <div
            className="pdfx-thumbs__spacer"
            style={{
              height: Math.max(0, stack.total - (stack.tops[range.last] + stack.heights[range.last]) - THUMB_GAP),
            }}
          />
        )}
      </div>
      <div className="pdfx-panel__foot">
        <button className="pdfx-mini" onClick={() => p.onPageAction("insert", p.selectedPages)}>
          <Plus size={13} /> Page blanche
        </button>
      </div>
    </div>
  );
}

interface ThumbItemProps {
  engine: PdfEngine;
  page: Page;
  index: number;
  rotation: number;
  width: number;
  height: number;
  current: boolean;
  selected: boolean;
  dropTarget: boolean;
  onPick: (id: string, e: React.MouseEvent, index: number) => void;
  onAction: (action: "rotate" | "delete" | "duplicate", id: string) => void;
  onDragStart: (id: string, selected: boolean) => void;
  onDragOverItem: (updater: (v: number | null) => number | null) => void;
  onDrop: (index: number) => void;
}

/**
 * One thumbnail of the pane. Memoised: moving the current page re-renders the
 * two items whose highlight changes, not every mounted one.
 */
const ThumbItem = memo(function ThumbItem(t: ThumbItemProps) {
  const { page, index: i } = t;
  return (
    <div
      className={`pdfx-thumb ${t.current ? "is-current" : ""} ${t.selected ? "is-selected" : ""} ${t.dropTarget ? "is-droptarget" : ""} ${page.skipped ? "is-skipped" : ""}`}
      draggable
      onDragStart={() => t.onDragStart(page.id, t.selected)}
      onDragOver={(e) => {
        e.preventDefault();
        t.onDragOverItem(() => i);
      }}
      onDragLeave={() => t.onDragOverItem((v) => (v === i ? null : v))}
      onDrop={(e) => {
        e.preventDefault();
        t.onDrop(i);
      }}
      onClick={(e) => t.onPick(page.id, e, i)}
    >
      <div className="pdfx-thumb__img">
        <ThumbCanvas engine={t.engine} page={page} rotation={t.rotation} width={t.width} height={t.height} />
      </div>
      <div className="pdfx-thumb__bar">
        <span className="pdfx-thumb__num">{page.label || i + 1}</span>
        <span className="pdfx-thumb__ops">
          <button
            type="button"
            title="Pivoter 90°"
            onClick={(e) => {
              e.stopPropagation();
              t.onAction("rotate", page.id);
            }}
          >
            <RotateCw size={12} />
          </button>
          <button
            type="button"
            title="Dupliquer"
            onClick={(e) => {
              e.stopPropagation();
              t.onAction("duplicate", page.id);
            }}
          >
            <Copy size={12} />
          </button>
          <button
            type="button"
            title="Supprimer"
            onClick={(e) => {
              e.stopPropagation();
              t.onAction("delete", page.id);
            }}
          >
            <Trash2 size={12} />
          </button>
        </span>
      </div>
    </div>
  );
});

// ---------------------------------------------------------------------------
// Bookmarks
// ---------------------------------------------------------------------------

function Bookmarks(p: SidebarProps) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const flat = useMemo(() => flattenBookmarks(p.bookmarks), [p.bookmarks]);

  return (
    <div className="pdfx-panel">
      <div className="pdfx-panel__head">
        <span className="pdfx-panel__title">Signets</span>
        <button className="pdfx-icon" title="Nouveau signet sur la page courante" onClick={() => p.onBookmarkAdd(null)}>
          <Plus size={14} />
        </button>
      </div>
      <div className="pdfx-panel__body">
        {!flat.length && (
          <p className="pdfx-empty">
            Ce document ne contient aucun signet.
            <br />
            Ajoutez-en un pour créer un sommaire.
          </p>
        )}
        {flat.map(({ node, depth }) => (
          <div key={node.id} className="pdfx-mark" style={{ paddingLeft: 8 + depth * 14 }}>
            {node.children.length > 0 ? (
              <button
                className="pdfx-mark__twist"
                onClick={() => p.onBookmarkToggle(node.id)}
                title={node.closed ? "Déplier" : "Replier"}
              >
                {node.closed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
              </button>
            ) : (
              <span className="pdfx-mark__twist" />
            )}
            {editing === node.id ? (
              <input
                className="pdfx-mark__input"
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => {
                  p.onBookmarkRename(node.id, draft.trim() || node.title);
                  setEditing(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    p.onBookmarkRename(node.id, draft.trim() || node.title);
                    setEditing(null);
                  }
                  if (e.key === "Escape") setEditing(null);
                }}
              />
            ) : (
              <button
                className="pdfx-mark__title"
                style={{
                  fontWeight: node.bold ? 700 : 500,
                  fontStyle: node.italic ? "italic" : undefined,
                  color: node.color,
                }}
                onClick={() => p.onBookmarkGoTo(node)}
                onDoubleClick={() => {
                  setDraft(node.title);
                  setEditing(node.id);
                }}
                title={
                  node.action
                    ? node.action.kind === "uri"
                      ? node.action.url
                      : node.action.kind === "named"
                        ? `Action : ${node.action.name}`
                        : node.action.label
                    : `Page ${node.page}`
                }
              >
                {node.title}
              </button>
            )}
            <span className="pdfx-mark__page">
              {node.action ? (
                node.action.kind === "uri" ? (
                  <ExternalLink size={11} aria-label="Lien" />
                ) : (
                  "·"
                )
              ) : (
                node.page
              )}
            </span>
            <span className="pdfx-mark__ops">
              <button title="Sous-signet" onClick={() => p.onBookmarkAdd(node.id)}>
                <Plus size={12} />
              </button>
              <button title="Définir la destination sur la vue courante" onClick={() => p.onBookmarkRetarget(node.id)}>
                <Crosshair size={12} />
              </button>
              <button
                title="Renommer"
                onClick={() => {
                  setDraft(node.title);
                  setEditing(node.id);
                }}
              >
                <Pencil size={12} />
              </button>
              <button title="Supprimer" onClick={() => p.onBookmarkDelete(node.id)}>
                <Trash2 size={12} />
              </button>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

const STATUS_META: Record<ReviewStatus, { label: string; icon: React.ReactNode; tone: string }> = {
  none: { label: "Aucun", icon: <CircleDot size={12} />, tone: "neutral" },
  accepted: { label: "Accepté", icon: <Check size={12} />, tone: "success" },
  rejected: { label: "Rejeté", icon: <X size={12} />, tone: "danger" },
  cancelled: { label: "Annulé", icon: <Ban size={12} />, tone: "warning" },
  completed: { label: "Terminé", icon: <Check size={12} />, tone: "info" },
};

function Comments(p: SidebarProps) {
  const [showFilter, setShowFilter] = useState(false);
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [replyText, setReplyText] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [editText, setEditText] = useState("");

  const pageOrder = useMemo(() => new Map(p.pages.map((page, i) => [page.id, i + 1])), [p.pages]);
  const authors = useMemo(() => [...new Set(p.annots.map((a) => a.author))].sort(), [p.annots]);

  const list = useMemo(
    () => filterComments(p.annots, p.filter, pageOrder, p.sort),
    [p.annots, p.filter, p.sort, pageOrder],
  );
  const kinds = useMemo(() => [...new Set(commentable(p.annots).map((a) => a.kind))], [p.annots]);
  /** Carets with a struck-out text: Acrobat's « Remplacer le texte ». */
  const replacing = useMemo(() => new Set(p.annots.filter((a) => a.group).map((a) => a.group!)), [p.annots]);
  const [editingReply, setEditingReply] = useState<string | null>(null);
  const [replyEdit, setReplyEdit] = useState("");

  return (
    <div className="pdfx-panel">
      <div className="pdfx-panel__head">
        <span className="pdfx-panel__title">Commentaires</span>
        <span className="pdfx-panel__count">{list.length}</span>
        <button
          className={`pdfx-icon ${showFilter ? "is-on" : ""}`}
          title="Filtrer"
          onClick={() => setShowFilter((v) => !v)}
        >
          <Filter size={14} />
        </button>
        <select
          className="pdfx-mini-select"
          value={p.sort}
          onChange={(e) => p.onSortChange(e.target.value as CommentSort)}
          title="Trier"
        >
          <option value="page">Page</option>
          <option value="author">Auteur</option>
          <option value="date">Date</option>
          <option value="kind">Type</option>
          <option value="status">Statut</option>
        </select>
      </div>

      {showFilter && (
        <div className="pdfx-filter">
          <input
            className="pdfx-input"
            placeholder="Rechercher dans les commentaires…"
            value={p.filter.query}
            onChange={(e) => p.onFilterChange({ ...p.filter, query: e.target.value })}
          />
          <div className="pdfx-filter__row">
            <span>Auteur</span>
            <select
              value={p.filter.authors?.[0] ?? ""}
              onChange={(e) => p.onFilterChange({ ...p.filter, authors: e.target.value ? [e.target.value] : null })}
            >
              <option value="">Tous</option>
              {authors.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </div>
          <div className="pdfx-filter__row">
            <span>Type</span>
            <select
              value={p.filter.kinds?.[0] ?? ""}
              onChange={(e) =>
                p.onFilterChange({ ...p.filter, kinds: e.target.value ? [e.target.value as Annot["kind"]] : null })
              }
            >
              <option value="">Tous</option>
              {kinds.map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]}
                </option>
              ))}
            </select>
          </div>
          <div className="pdfx-filter__row">
            <span>Page</span>
            <input
              className="pdfx-input pdfx-input--mini"
              type="number"
              min={1}
              max={p.pages.length}
              placeholder="Toutes"
              value={p.filter.pages?.[0] ?? ""}
              onChange={(e) => {
                const n = Number(e.target.value);
                p.onFilterChange({ ...p.filter, pages: e.target.value && n >= 1 ? [n] : null });
              }}
            />
          </div>
          <div className="pdfx-filter__row">
            <span>Coche</span>
            <select
              value={p.filter.checked ?? ""}
              onChange={(e) =>
                p.onFilterChange({
                  ...p.filter,
                  checked: (e.target.value || null) as CommentFilter["checked"],
                })
              }
            >
              <option value="">Tous</option>
              <option value="checked">Cochés</option>
              <option value="unchecked">Non cochés</option>
            </select>
          </div>
          <div className="pdfx-filter__row">
            <span>Statut</span>
            <select
              value={p.filter.statuses?.[0] ?? ""}
              onChange={(e) =>
                p.onFilterChange({ ...p.filter, statuses: e.target.value ? [e.target.value as ReviewStatus] : null })
              }
            >
              <option value="">Tous</option>
              {(Object.keys(STATUS_META) as ReviewStatus[]).map((s) => (
                <option key={s} value={s}>
                  {STATUS_META[s].label}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      <div className="pdfx-panel__body">
        {!list.length && (
          <p className="pdfx-empty">
            Aucun commentaire.
            <br />
            Surlignez du texte ou posez une note pour commencer une relecture.
          </p>
        )}
        {list.map((a) => {
          const meta = STATUS_META[a.status ?? "none"];
          return (
            <article key={a.id} className="pdfx-comment" onClick={() => p.onSelectAnnot(a.id)}>
              <header className="pdfx-comment__head">
                <input
                  type="checkbox"
                  className="pdfx-comment__check"
                  checked={!!a.checked}
                  title="Coche (marque personnelle, comme dans Acrobat)"
                  aria-label={`Cocher le commentaire de ${a.author}`}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => p.onAnnotCheck([a.id], e.target.checked)}
                />
                <span className="pdfx-comment__swatch" style={{ background: a.color }} />
                <span className="pdfx-comment__author">{a.author}</span>
                <span className="pdfx-comment__meta">
                  {replacing.has(a.id) ? "Remplacement de texte" : KIND_LABEL[a.kind]} · p.{" "}
                  {pageOrder.get(a.pageId) ?? "?"}
                </span>
                <time className="pdfx-comment__date">{shortDate(a.createdAt)}</time>
              </header>

              {editing === a.id ? (
                <textarea
                  className="pdfx-comment__edit"
                  autoFocus
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                  onBlur={() => {
                    p.onAnnotEditContents(a.id, editText);
                    setEditing(null);
                  }}
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <p
                  className="pdfx-comment__body"
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    setEditText(a.contents ?? "");
                    setEditing(a.id);
                  }}
                >
                  {a.contents || a.text || <em>Sans commentaire — double-cliquez pour en ajouter</em>}
                </p>
              )}

              {(a.replies ?? [])
                .filter((r) => r.text)
                .map((r) => (
                  <div key={r.id} className="pdfx-reply" onClick={(e) => e.stopPropagation()}>
                    <span className="pdfx-reply__author">{r.author}</span>
                    <time>{shortDate(r.createdAt)}</time>
                    {!r.status && (
                      <button
                        type="button"
                        className="pdfx-reply__del"
                        aria-label="Supprimer la réponse"
                        title="Supprimer la réponse"
                        onClick={() => p.onReplyDelete(a.id, r.id)}
                      >
                        ×
                      </button>
                    )}
                    {editingReply === r.id ? (
                      <textarea
                        className="pdfx-comment__edit"
                        autoFocus
                        value={replyEdit}
                        onChange={(e) => setReplyEdit(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Escape") setEditingReply(null);
                        }}
                        onBlur={() => {
                          if (replyEdit.trim() && replyEdit !== r.text) p.onReplyEdit(a.id, r.id, replyEdit.trim());
                          setEditingReply(null);
                        }}
                      />
                    ) : (
                      <p
                        title={r.status ? undefined : "Double-cliquez pour modifier"}
                        onDoubleClick={() => {
                          if (r.status) return;
                          setReplyEdit(r.text);
                          setEditingReply(r.id);
                        }}
                      >
                        {r.text}
                      </p>
                    )}
                  </div>
                ))}

              {replyTo === a.id ? (
                <div className="pdfx-comment__replybox" onClick={(e) => e.stopPropagation()}>
                  <textarea
                    autoFocus
                    value={replyText}
                    placeholder="Répondre…"
                    onChange={(e) => setReplyText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                        if (replyText.trim()) p.onAnnotReply(a.id, replyText.trim());
                        setReplyText("");
                        setReplyTo(null);
                      }
                      if (e.key === "Escape") {
                        setReplyTo(null);
                        setReplyText("");
                      }
                    }}
                  />
                  <button
                    className="pdfx-mini pdfx-mini--primary"
                    onClick={() => {
                      if (replyText.trim()) p.onAnnotReply(a.id, replyText.trim());
                      setReplyText("");
                      setReplyTo(null);
                    }}
                  >
                    Envoyer
                  </button>
                </div>
              ) : (
                <footer className="pdfx-comment__foot" onClick={(e) => e.stopPropagation()}>
                  <button
                    className="pdfx-mini"
                    onClick={() => {
                      setReplyTo(a.id);
                      setReplyText("");
                    }}
                  >
                    Répondre
                  </button>
                  <span className={`pdfx-cstatus pdfx-cstatus--${meta.tone}`}>
                    {meta.icon}
                    {meta.label}
                  </span>
                  <select
                    className="pdfx-mini-select"
                    value={a.status ?? "none"}
                    onChange={(e) => p.onAnnotStatus([a.id], e.target.value as ReviewStatus)}
                  >
                    {(Object.keys(STATUS_META) as ReviewStatus[]).map((s) => (
                      <option key={s} value={s}>
                        {STATUS_META[s].label}
                      </option>
                    ))}
                  </select>
                  <button className="pdfx-mini pdfx-mini--danger" onClick={() => p.onAnnotDelete([a.id])}>
                    <Trash2 size={12} />
                  </button>
                </footer>
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Search results
// ---------------------------------------------------------------------------

function SearchResults(p: SidebarProps) {
  // Hits come in document order: grouped by page as they come.
  const groups = useMemo(() => {
    const at = new Map<number, number>();
    p.pages.forEach((pg, i) => pg.from != null && !at.has(pg.from) && at.set(pg.from, i));
    const out: { key: number; label: string; items: { hit: SearchHit; index: number }[] }[] = [];
    p.searchHits.forEach((hit, index) => {
      const last = out[out.length - 1];
      if (last && last.key === hit.page) last.items.push({ hit, index });
      else {
        const i = at.get(hit.page) ?? hit.page;
        out.push({ key: hit.page, label: p.pages[i]?.label || String(i + 1), items: [{ hit, index }] });
      }
    });
    return out;
  }, [p.searchHits, p.pages]);
  const comments = useMemo(
    () =>
      p.searchQuery.trim()
        ? commentable(p.annots).filter(
            (a) =>
              textMatches(a.contents || a.text || "", p.searchQuery, p.searchOptions) ||
              (a.replies ?? []).some((r) => textMatches(r.text, p.searchQuery, p.searchOptions)),
          )
        : [],
    [p.annots, p.searchQuery, p.searchOptions],
  );
  const marks = useMemo(() => {
    if (!p.searchQuery.trim()) return [];
    const out: Mark[] = [];
    const walk = (list: readonly Mark[]) =>
      list.forEach((b) => {
        if (textMatches(b.title, p.searchQuery, p.searchOptions)) out.push(b);
        walk(b.children);
      });
    walk(p.bookmarks);
    return out;
  }, [p.bookmarks, p.searchQuery, p.searchOptions]);
  const pageLabel = (pageId: string) => {
    const i = p.pages.findIndex((pg) => pg.id === pageId);
    return i < 0 ? "" : p.pages[i].label || String(i + 1);
  };

  return (
    <div className="pdfx-panel">
      <div className="pdfx-panel__head">
        <span className="pdfx-panel__title">Recherche</span>
        {p.searchBusy ? (
          <span className="pdfx-panel__count">…</span>
        ) : (
          <span className="pdfx-panel__count">{p.searchHits.length}</span>
        )}
      </div>
      <div className="pdfx-panel__body">
        {!p.searchQuery && <p className="pdfx-empty">Saisissez un terme dans la barre de recherche.</p>}
        {p.searchQuery && !p.searchHits.length && !comments.length && !marks.length && !p.searchBusy && (
          <p className="pdfx-empty">Aucun résultat pour « {p.searchQuery} ».</p>
        )}
        {groups.map(({ key, label, items }) => (
          <div key={key} className="pdfx-hits-group">
            <div className="pdfx-hits-group__head">
              Page {label} <span>{items.length}</span>
            </div>
            {items.map(({ hit, index }) => (
              <button
                key={index}
                className={`pdfx-hitrow ${index === p.searchIndex ? "is-active" : ""}`}
                onClick={() => p.onSearchSelect(index)}
              >
                {hit.context.slice(0, hit.ctxStart)}
                <mark>{hit.context.slice(hit.ctxStart, hit.ctxEnd)}</mark>
                {hit.context.slice(hit.ctxEnd)}
              </button>
            ))}
          </div>
        ))}
        {comments.length > 0 && (
          <div className="pdfx-hits-group">
            <div className="pdfx-hits-group__head">
              Commentaires <span>{comments.length}</span>
            </div>
            {comments.map((a) => (
              <button key={a.id} className="pdfx-hitrow" onClick={() => p.onSelectAnnot(a.id)}>
                <b>p. {pageLabel(a.pageId)}</b> {a.author ? `${a.author} — ` : ""}
                {(a.contents || a.text || a.replies?.find((r) => r.text)?.text || "").slice(0, 120)}
              </button>
            ))}
          </div>
        )}
        {marks.length > 0 && (
          <div className="pdfx-hits-group">
            <div className="pdfx-hits-group__head">
              Signets <span>{marks.length}</span>
            </div>
            {marks.map((b) => (
              <button key={b.id} className="pdfx-hitrow" onClick={() => p.onBookmarkGoTo(b)}>
                {b.title}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Attachments / layers / fields
// ---------------------------------------------------------------------------

function Attachments(p: SidebarProps) {
  return (
    <div className="pdfx-panel">
      <div className="pdfx-panel__head">
        <span className="pdfx-panel__title">Pièces jointes</span>
        <span className="pdfx-panel__count">{p.attachments.length}</span>
      </div>
      <div className="pdfx-panel__body">
        {!p.attachments.length && <p className="pdfx-empty">Ce document ne contient aucune pièce jointe.</p>}
        {p.attachments.map((a) => (
          <button key={a.name} className="pdfx-row" onClick={() => p.onAttachmentOpen(a)}>
            <Paperclip size={14} />
            <span className="pdfx-row__label">{a.name}</span>
            <span className="pdfx-row__meta">{(a.bytes.length / 1024).toFixed(0)} Ko</span>
            <Download size={13} />
          </button>
        ))}
      </div>
    </div>
  );
}

function LayersPane(p: SidebarProps) {
  return (
    <div className="pdfx-panel">
      <div className="pdfx-panel__head">
        <span className="pdfx-panel__title">Calques</span>
        <span className="pdfx-panel__count">{p.layers.filter((l) => !l.heading).length}</span>
        {p.layers.length > 0 && (
          <button
            className="pdfx-icon"
            title="Enregistrer la visibilité actuelle comme état par défaut du fichier"
            onClick={p.onLayersSaveDefault}
          >
            <Save size={14} />
          </button>
        )}
      </div>
      <div className="pdfx-panel__body">
        {!p.layers.length && <p className="pdfx-empty">Ce document ne contient pas de calques.</p>}
        {p.layers.map((l) =>
          l.heading ? (
            <div key={l.id} className="pdfx-row pdfx-row--heading" style={{ paddingLeft: 8 + l.depth * 14 }}>
              <span className="pdfx-row__label">{l.name}</span>
            </div>
          ) : (
            <label
              key={l.id}
              className="pdfx-row pdfx-row--check"
              style={{ paddingLeft: 8 + l.depth * 14 }}
              title={
                l.locked ? "Calque verrouillé par le document" : l.radio ? "Calque exclusif de son groupe" : undefined
              }
            >
              <input
                type={l.radio ? "radio" : "checkbox"}
                checked={l.visible}
                disabled={l.locked}
                onChange={() => p.onLayerToggle(l.id)}
                onClick={() => l.radio && l.visible && p.onLayerToggle(l.id)}
              />
              <Layers size={14} />
              <span className="pdfx-row__label">{l.name}</span>
              {l.locked && <Lock size={12} aria-label="Verrouillé" />}
            </label>
          ),
        )}
      </div>
    </div>
  );
}

function FieldsPane(p: SidebarProps) {
  return (
    <div className="pdfx-panel">
      <div className="pdfx-panel__head">
        <span className="pdfx-panel__title">Champs</span>
        <span className="pdfx-panel__count">{p.fields.length}</span>
      </div>
      <div className="pdfx-panel__body">
        {!p.fields.length && (
          <p className="pdfx-empty">
            Aucun champ créé.
            <br />
            Choisissez un outil de champ pour en dessiner un.
          </p>
        )}
        {p.fields.map((f) => (
          <div key={f.id} className="pdfx-row">
            <FormInput size={14} />
            <button className="pdfx-row__label" onClick={() => p.onFieldSelect(f.id)}>
              {f.name}
            </button>
            <span className="pdfx-row__meta">{f.kind}</span>
            <button className="pdfx-icon" title="Supprimer" onClick={() => p.onFieldDelete(f.id)}>
              <Trash2 size={12} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Icons exported for the rail buttons in the workspace. */
export const PANEL_ICONS: { id: SidePanel; icon: React.ReactNode; label: string }[] = [
  { id: "thumbnails", icon: <FileText size={17} />, label: "Vignettes" },
  { id: "bookmarks", icon: <Bookmark size={17} />, label: "Signets" },
  { id: "comments", icon: <MessageSquare size={17} />, label: "Commentaires" },
  { id: "search", icon: <Search size={17} />, label: "Recherche" },
  { id: "attachments", icon: <Paperclip size={17} />, label: "Pièces jointes" },
  { id: "layers", icon: <Layers size={17} />, label: "Calques" },
  { id: "fields", icon: <FormInput size={17} />, label: "Champs" },
];

export { ArrowUpDown };
