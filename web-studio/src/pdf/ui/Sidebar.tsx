import { useEffect, useMemo, useRef, useState } from "react";
import {
  Bookmark,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  FileText,
  Filter,
  Layers,
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
import { renderToCanvas } from "../core/render";
import type { Annot, Bookmark as Mark, CreatedField, Page, ReviewStatus } from "../model/types";
import { flattenBookmarks, type CommentFilter, type CommentSort } from "../model/doc";
import type { SearchHit } from "../core/search";
import { KIND_LABEL, shortDate, type SidePanel } from "./state";

/** The multi-panel navigation rail. Each panel mirrors an Acrobat pane. */

export interface SidebarProps {
  panel: SidePanel;
  engine: PdfEngine;
  pages: Page[];
  current: number;
  selectedPages: string[];
  annots: Annot[];
  bookmarks: Mark[];
  fields: CreatedField[];
  attachments: Attachment[];
  layers: LayerInfo[];
  hiddenLayers: Set<string>;
  searchHits: SearchHit[];
  searchIndex: number;
  searchQuery: string;
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
  onFilterChange: (f: CommentFilter) => void;
  onSortChange: (s: CommentSort) => void;
  onBookmarkGoTo: (b: Mark) => void;
  onBookmarkAdd: (parentId: string | null) => void;
  onBookmarkRename: (id: string, title: string) => void;
  onBookmarkDelete: (id: string) => void;
  onBookmarkToggle: (id: string) => void;
  onSearchSelect: (index: number) => void;
  onLayerToggle: (id: string) => void;
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

function Thumb({ engine, from, width }: { engine: PdfEngine; from: number | null; width: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || from == null) return;
    let done = false;
    const io = new IntersectionObserver(
      async ([entry]) => {
        if (!entry.isIntersecting || done) return;
        done = true;
        io.disconnect();
        try {
          const page = await engine.page(from);
          const canvas = await renderToCanvas(page, { scale: 4, maxWidth: width * 2 });
          setSrc(canvas.toDataURL("image/png"));
        } catch {
          /* a page that will not render simply stays blank */
        }
      },
      { rootMargin: "400px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [engine, from, width]);

  return (
    <div ref={ref} className="pdfx-thumb__img">
      {src ? <img src={src} alt="" draggable={false} /> : <div className="pdfx-thumb__blank" />}
    </div>
  );
}

function Thumbnails(p: SidebarProps) {
  const [dragOver, setDragOver] = useState<number | null>(null);
  const dragging = useRef<string[]>([]);

  const toggle = (id: string, e: React.MouseEvent, index: number) => {
    if (e.shiftKey && p.selectedPages.length) {
      const last = p.pages.findIndex((q) => q.id === p.selectedPages[p.selectedPages.length - 1]);
      const [from, to] = last < index ? [last, index] : [index, last];
      p.onSelectPages(p.pages.slice(from, to + 1).map((q) => q.id));
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      p.onSelectPages(
        p.selectedPages.includes(id) ? p.selectedPages.filter((q) => q !== id) : [...p.selectedPages, id],
      );
      return;
    }
    p.onSelectPages([id]);
    p.onGoTo(index + 1);
  };

  return (
    <div className="pdfx-panel">
      <div className="pdfx-panel__head">
        <span className="pdfx-panel__title">Vignettes</span>
        <span className="pdfx-panel__count">{p.pages.length}</span>
      </div>
      <div className="pdfx-panel__body pdfx-thumbs">
        {p.pages.map((page, i) => {
          const selected = p.selectedPages.includes(page.id);
          return (
            <div
              key={page.id}
              className={`pdfx-thumb ${p.current === i + 1 ? "is-current" : ""} ${selected ? "is-selected" : ""} ${dragOver === i ? "is-droptarget" : ""} ${page.skipped ? "is-skipped" : ""}`}
              draggable
              onDragStart={() => {
                dragging.current = selected ? p.selectedPages : [page.id];
              }}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(i);
              }}
              onDragLeave={() => setDragOver((v) => (v === i ? null : v))}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(null);
                if (dragging.current.length) p.onReorderPages(dragging.current, i);
                dragging.current = [];
              }}
              onClick={(e) => toggle(page.id, e, i)}
            >
              <Thumb engine={p.engine} from={page.from} width={132} />
              <div className="pdfx-thumb__bar">
                <span className="pdfx-thumb__num">{page.label || i + 1}</span>
                <span className="pdfx-thumb__ops">
                  <button
                    type="button"
                    title="Pivoter 90°"
                    onClick={(e) => {
                      e.stopPropagation();
                      p.onPageAction("rotate", [page.id]);
                    }}
                  >
                    <RotateCw size={12} />
                  </button>
                  <button
                    type="button"
                    title="Dupliquer"
                    onClick={(e) => {
                      e.stopPropagation();
                      p.onPageAction("duplicate", [page.id]);
                    }}
                  >
                    <Copy size={12} />
                  </button>
                  <button
                    type="button"
                    title="Supprimer"
                    onClick={(e) => {
                      e.stopPropagation();
                      p.onPageAction("delete", [page.id]);
                    }}
                  >
                    <Trash2 size={12} />
                  </button>
                </span>
              </div>
            </div>
          );
        })}
      </div>
      <div className="pdfx-panel__foot">
        <button className="pdfx-mini" onClick={() => p.onPageAction("insert", p.selectedPages)}>
          <Plus size={13} /> Page blanche
        </button>
      </div>
    </div>
  );
}

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
                title={`Page ${node.page}`}
              >
                {node.title}
              </button>
            )}
            <span className="pdfx-mark__page">{node.page}</span>
            <span className="pdfx-mark__ops">
              <button title="Sous-signet" onClick={() => p.onBookmarkAdd(node.id)}>
                <Plus size={12} />
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

  const list = useMemo(() => {
    const q = p.filter.query.trim().toLowerCase();
    const out = p.annots.filter((a) => {
      if (a.kind === "link") return false;
      if (p.filter.authors && !p.filter.authors.includes(a.author)) return false;
      if (p.filter.statuses && !p.filter.statuses.includes(a.status ?? "none")) return false;
      if (q) {
        const hay = `${a.contents ?? ""} ${a.text ?? ""} ${a.author} ${(a.replies ?? []).map((r) => r.text).join(" ")}`;
        if (!hay.toLowerCase().includes(q)) return false;
      }
      return true;
    });
    const page = (a: Annot) => pageOrder.get(a.pageId) ?? 1e9;
    out.sort((a, b) => {
      switch (p.sort) {
        case "author":
          return a.author.localeCompare(b.author) || page(a) - page(b);
        case "date":
          return b.createdAt.localeCompare(a.createdAt);
        case "kind":
          return a.kind.localeCompare(b.kind) || page(a) - page(b);
        case "status":
          return (a.status ?? "none").localeCompare(b.status ?? "none") || page(a) - page(b);
        default:
          return page(a) - page(b) || a.rect.y - b.rect.y || a.rect.x - b.rect.x;
      }
    });
    return out;
  }, [p.annots, p.filter, p.sort, pageOrder]);

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
                <span className="pdfx-comment__swatch" style={{ background: a.color }} />
                <span className="pdfx-comment__author">{a.author}</span>
                <span className="pdfx-comment__meta">
                  {KIND_LABEL[a.kind]} · p. {pageOrder.get(a.pageId) ?? "?"}
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
                  <div key={r.id} className="pdfx-reply">
                    <span className="pdfx-reply__author">{r.author}</span>
                    <time>{shortDate(r.createdAt)}</time>
                    <p>{r.text}</p>
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
  const byPage = useMemo(() => {
    const map = new Map<number, { hit: SearchHit; index: number }[]>();
    p.searchHits.forEach((hit, index) => {
      const list = map.get(hit.page) ?? [];
      list.push({ hit, index });
      map.set(hit.page, list);
    });
    return [...map.entries()].sort((a, b) => a[0] - b[0]);
  }, [p.searchHits]);

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
        {p.searchQuery && !p.searchHits.length && !p.searchBusy && (
          <p className="pdfx-empty">Aucun résultat pour « {p.searchQuery} ».</p>
        )}
        {byPage.map(([page, items]) => (
          <div key={page} className="pdfx-hits-group">
            <div className="pdfx-hits-group__head">
              Page {page + 1} <span>{items.length}</span>
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
        <span className="pdfx-panel__count">{p.layers.length}</span>
      </div>
      <div className="pdfx-panel__body">
        {!p.layers.length && <p className="pdfx-empty">Ce document ne contient pas de calques.</p>}
        {p.layers.map((l) => (
          <label key={l.id} className="pdfx-row pdfx-row--check">
            <input type="checkbox" checked={!p.hiddenLayers.has(l.id)} onChange={() => p.onLayerToggle(l.id)} />
            <Layers size={14} />
            <span className="pdfx-row__label">{l.name}</span>
          </label>
        ))}
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
