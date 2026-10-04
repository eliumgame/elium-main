/**
 * Recherche dans tout l'espace de travail : texte + filtres (type, dossier,
 * étiquette, date), résultats surlignés, et accès au remplacement global dans
 * les documents.
 */
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import {
  FileSpreadsheet,
  FileText,
  FileType,
  Loader2,
  Presentation,
  Replace,
  Search as SearchIcon,
  X,
} from "lucide-react";
import { useI18n, type MessageKey } from "../../i18n";
import { collectTags, folderPath } from "../model";
import { splitHighlight } from "../search/index";
import type { SearchApi } from "../useSearch";
import { ITEM_KINDS, type ItemKind, type WorkFolder, type WorkItem } from "../types";
import ReplacePanel from "./ReplacePanel";
import type { ReplaceDeps } from "../replace";

const ICON: Record<ItemKind, React.ReactNode> = {
  doc: <FileText size={18} />,
  sheet: <FileSpreadsheet size={18} />,
  slides: <Presentation size={18} />,
  pdf: <FileType size={18} />,
};
const KIND_KEY: Record<ItemKind, MessageKey> = {
  doc: "kind.doc",
  sheet: "kind.sheet",
  slides: "kind.slides",
  pdf: "kind.pdf",
};

function Highlighted({ text, ranges }: { text: string; ranges: [number, number][] }) {
  return (
    <>
      {splitHighlight(text, ranges).map((s, i) =>
        s.mark ? (
          <mark key={i} className="ws-mark">
            {s.text}
          </mark>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </>
  );
}

export default function SearchView({
  items,
  folders,
  search,
  initialQuery,
  replaceDeps,
  onOpen,
  onChanged,
}: {
  items: WorkItem[];
  folders: WorkFolder[];
  search: SearchApi;
  initialQuery: string;
  replaceDeps: ReplaceDeps;
  onOpen: (item: WorkItem) => void;
  /** Des documents ont été réécrits (remplacement/annulation) : rafraîchir le catalogue. */
  onChanged: () => void;
}) {
  const { t, tn, fmt } = useI18n();
  const [query, setQuery] = useState(initialQuery);
  const [kinds, setKinds] = useState<ItemKind[]>([]);
  const [folderId, setFolderId] = useState<string | "">("");
  const [tag, setTag] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [replaceOpen, setReplaceOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const deferred = useDeferredValue(query);

  useEffect(() => {
    setQuery(initialQuery);
  }, [initialQuery]);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const results = useMemo(
    () =>
      search.search(deferred, {
        kinds,
        folderId: folderId === "" ? undefined : folderId,
        includeSubfolders: folderId !== "",
        tag: tag || undefined,
        modifiedFrom: from || undefined,
        modifiedTo: to || undefined,
      }),
    [search, deferred, kinds, folderId, tag, from, to],
  );

  const tags = collectTags(items);
  const liveFolders = folders.filter((f) => !f.trashedAt);
  const pathOf = (f: WorkItem) =>
    folderPath(folders, f.folderId)
      .map((x) => x.name)
      .join(" / ");
  const hasFilters = kinds.length > 0 || folderId !== "" || tag !== "" || from !== "" || to !== "";

  return (
    <section className="ws-lib ws-search" aria-label={t("shell.nav.search")}>
      <header className="ws-lib__head">
        <h2 className="ws-lib__title">{t("search.title")}</h2>
        <div className="ws-lib__tools">
          <button
            type="button"
            className={`eb eb--sm ${replaceOpen ? "eb--primary" : "eb--outline"}`}
            aria-pressed={replaceOpen}
            onClick={() => setReplaceOpen((v) => !v)}
          >
            <Replace size={14} /> {t("search.replace_toggle")}
          </button>
        </div>
      </header>

      <div className="ws-search__bar">
        <SearchIcon size={18} aria-hidden />
        <input
          ref={inputRef}
          type="search"
          className="ws-search__input"
          value={query}
          placeholder={t("search.placeholder")}
          aria-label={t("search.placeholder")}
          onChange={(e) => setQuery(e.target.value)}
        />
        {query && (
          <button
            type="button"
            className="icon-btn"
            aria-label={t("search.clear")}
            title={t("search.clear")}
            onClick={() => setQuery("")}
          >
            <X size={16} />
          </button>
        )}
      </div>

      <div className="ws-search__filters">
        <div className="ws-kinds" role="group" aria-label={t("workspace.filter.kind")}>
          {ITEM_KINDS.map((k) => {
            const on = kinds.includes(k);
            return (
              <button
                key={k}
                type="button"
                className={`ws-kinds__chip ${on ? "is-active" : ""}`}
                aria-pressed={on}
                onClick={() => setKinds(on ? kinds.filter((x) => x !== k) : [...kinds, k])}
              >
                {ICON[k]} {t(KIND_KEY[k])}
              </button>
            );
          })}
        </div>
        <label className="ws-field">
          <span>{t("search.filter.folder")}</span>
          <select value={folderId} onChange={(e) => setFolderId(e.target.value)}>
            <option value="">{t("search.filter.all_folders")}</option>
            {liveFolders.map((f) => (
              <option key={f.id} value={f.id}>
                {folderPath(folders, f.id)
                  .map((x) => x.name)
                  .join(" / ")}
              </option>
            ))}
          </select>
        </label>
        <label className="ws-field">
          <span>{t("search.filter.tag")}</span>
          <select value={tag} onChange={(e) => setTag(e.target.value)}>
            <option value="">{t("search.filter.all_tags")}</option>
            {tags.map((x) => (
              <option key={x.tag} value={x.tag}>
                {x.tag} ({x.count})
              </option>
            ))}
          </select>
        </label>
        <label className="ws-field">
          <span>{t("search.filter.from")}</span>
          <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="ws-field">
          <span>{t("search.filter.to")}</span>
          <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
        </label>
        {hasFilters && (
          <button
            type="button"
            className="ws-kinds__clear"
            onClick={() => {
              setKinds([]);
              setFolderId("");
              setTag("");
              setFrom("");
              setTo("");
            }}
          >
            <X size={12} /> {t("workspace.filter.clear")}
          </button>
        )}
      </div>

      {search.progress.running && (
        <p className="ws-search__progress" role="status">
          <Loader2 size={14} className="icon-spin" />{" "}
          {t("search.indexing", { done: search.progress.done, total: search.progress.total })}
        </p>
      )}

      <p className="muted ws-search__count" aria-live="polite">
        {deferred.trim() ? tn("search.results", results.length) : tn("search.browse", results.length)}
      </p>

      <ul className="ws-results">
        {results.slice(0, 200).map(({ item, hit }) => (
          <li key={item.id}>
            <button type="button" className="ws-result" onClick={() => onOpen(item)}>
              <span className="ws-result__icon">{ICON[item.kind]}</span>
              <span className="ws-result__body">
                <span className="ws-result__title">
                  <Highlighted text={item.title} ranges={hit.titleRanges} />
                </span>
                {hit.snippet && (
                  <span className="ws-result__snippet">
                    <Highlighted text={hit.snippet.text} ranges={hit.snippet.ranges} />
                  </span>
                )}
                <span className="ws-result__meta">
                  {t(KIND_KEY[item.kind])} · {pathOf(item) || t("shell.nav.library")} · {fmt.date(item.modifiedAt)}
                  {hit.matches > 0 && ` · ${tn("search.matches", hit.matches)}`}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {results.length > 200 && <p className="muted">{t("search.truncated")}</p>}

      {replaceOpen && <ReplacePanel items={items} deps={replaceDeps} initialFind={query} onChanged={onChanged} />}
    </section>
  );
}
