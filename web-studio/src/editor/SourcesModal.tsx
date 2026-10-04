import "./citations.css";
/** Gestionnaire de sources : bibliothèque, citation, bibliographie, changement de style. */
import { useMemo, useState } from "react";
import type { Editor } from "@tiptap/react";
import { Modal, Button, Field } from "../ui/components";
import { reportError } from "../ui/crash-log";
import {
  SOURCE_TYPE_LABELS,
  STYLE_LABELS,
  bibliographyStale,
  collectSources,
  formatCitation,
  makeSourceKey,
  partsToText,
  formatReference,
  sortSources,
  validateSource,
  type BibSource,
  type CitationStyle,
  type SourceType,
} from "./citations";
import { loadLibrary, mergeSources, removeSource, saveLibrary, upsertSource } from "./sourceLibrary";

const EMPTY: BibSource = { key: "", type: "book", authors: "", title: "", year: "" };
const STYLE_KEY = "elium.citation.style";

function initialStyle(): CitationStyle {
  try {
    const v = localStorage.getItem(STYLE_KEY);
    if (v === "apa" || v === "mla" || v === "iso690") return v;
  } catch {
    /* stockage indisponible : style par défaut */
  }
  return "apa";
}

export default function SourcesModal({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const [style, setStyle] = useState<CitationStyle>(initialStyle);
  const [library, setLibrary] = useState<BibSource[]>(() => loadLibrary());
  const [rev, setRev] = useState(0);
  const [draft, setDraft] = useState<BibSource | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [page, setPage] = useState("");
  const [selKey, setSelKey] = useState<string | null>(null);
  const [notice, setNotice] = useState("");

  const docJson = editor.getJSON() as never;
  // `rev` force le recalcul après une mise à jour du document.
  const docSources = useMemo(() => collectSources(docJson), [docJson, rev]); // eslint-disable-line react-hooks/exhaustive-deps
  const all = useMemo(() => sortSources(mergeSources(docSources, library)), [docSources, library]);
  const stale = bibliographyStale(docJson, style);
  const selected = all.find((s) => s.key === selKey) ?? null;

  const changeStyle = (s: CitationStyle) => {
    setStyle(s);
    try {
      localStorage.setItem(STYLE_KEY, s);
    } catch {
      /* préférence non mémorisée */
    }
  };

  const saveDraft = () => {
    if (!draft) return;
    const errs = validateSource(draft);
    setErrors(errs);
    if (errs.length) return;
    const src = { ...draft, key: draft.key || makeSourceKey(draft) };
    const next = upsertSource(library, src);
    setLibrary(next);
    if (!saveLibrary(next)) {
      reportError("sources", new Error("Bibliothèque de sources non enregistrée"));
      setNotice("La source est utilisable dans ce document, mais n'a pas pu être mémorisée dans votre bibliothèque (stockage du navigateur indisponible).");
    } else setNotice("");
    setSelKey(src.key);
    setDraft(null);
  };
  const removeFromLibrary = (key: string) => {
    const next = removeSource(library, key);
    setLibrary(next);
    saveLibrary(next);
    if (selKey === key) setSelKey(null);
  };
  const cite = () => {
    if (!selected) return;
    editor.chain().focus().insertCitation(selected, page.trim(), style).run();
    setPage("");
    setRev((r) => r + 1);
  };
  const refresh = () => {
    editor.chain().focus().refreshCitations(style).run();
    setRev((r) => r + 1);
  };
  const insertBib = () => {
    editor.chain().focus().insertBibliography(style).run();
    setRev((r) => r + 1);
  };
  const set = <K extends keyof BibSource>(k: K, v: BibSource[K]) => setDraft((d) => (d ? { ...d, [k]: v } : d));
  const t = draft?.type;

  return (
    <Modal title="Sources et bibliographie" onClose={onClose} wide footer={<Button onClick={onClose}>Fermer</Button>}>
      <div className="settings">
        <section className="settings__section">
          <Field label="Style de citation">
            <select className="settings__input" value={style} onChange={(e) => changeStyle(e.target.value as CitationStyle)}>
              {(Object.keys(STYLE_LABELS) as CitationStyle[]).map((k) => (
                <option key={k} value={k}>
                  {STYLE_LABELS[k]}
                </option>
              ))}
            </select>
          </Field>
          {notice && (
            <p role="alert" className="settings__error">
              {notice}
            </p>
          )}
          {stale && (
            <p role="status" className="settings__hint">
              Des citations ou la bibliographie ne suivent pas ce style ou les sources actuelles.{" "}
              <Button variant="ghost" onClick={refresh}>
                Mettre à jour
              </Button>
            </p>
          )}
        </section>

        {!draft && (
          <section className="settings__section">
            <Field label={`Sources (${all.length})`}>
              <ul className="sources__list" aria-label="Sources disponibles">
                {all.map((s) => (
                  <li key={s.key}>
                    <label className="sources__item">
                      <input type="radio" name="source" checked={selKey === s.key} onChange={() => setSelKey(s.key)} />
                      <span>
                        <strong>{formatCitation(s, style)}</strong> {partsToText(formatReference(s, style))}
                        {docSources.some((d) => d.key === s.key) ? " · citée" : ""}
                      </span>
                    </label>
                    {library.some((l) => l.key === s.key) && (
                      <>
                        <Button variant="ghost" onClick={() => setDraft(s)}>
                          Modifier
                        </Button>
                        <Button variant="ghost" onClick={() => removeFromLibrary(s.key)}>
                          Supprimer
                        </Button>
                      </>
                    )}
                  </li>
                ))}
                {!all.length && <li className="settings__hint">Aucune source : ajoutez-en une ci-dessous.</li>}
              </ul>
            </Field>
            <div className="sources__actions">
              <Button variant="ghost" onClick={() => setDraft({ ...EMPTY })}>
                + Nouvelle source
              </Button>
              <input
                className="settings__input sources__page"
                placeholder="Page (facultatif)"
                aria-label="Page citée"
                value={page}
                onChange={(e) => setPage(e.target.value)}
              />
              <Button onClick={cite} disabled={!selected}>
                Insérer la citation
              </Button>
              <Button variant="ghost" onClick={insertBib}>
                Insérer la bibliographie
              </Button>
              <Button variant="ghost" onClick={refresh}>
                Mettre à jour tout
              </Button>
            </div>
          </section>
        )}

        {draft && (
          <section className="settings__section sources__form" aria-label="Édition d'une source">
            <Field label="Type">
              <select className="settings__input" value={draft.type} onChange={(e) => set("type", e.target.value as SourceType)}>
                {(Object.keys(SOURCE_TYPE_LABELS) as SourceType[]).map((k) => (
                  <option key={k} value={k}>
                    {SOURCE_TYPE_LABELS[k]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Auteurs (« Nom, Prénom » séparés par « ; »)">
              <input className="settings__input" value={draft.authors} onChange={(e) => set("authors", e.target.value)} />
            </Field>
            <Field label="Titre">
              <input className="settings__input" value={draft.title} onChange={(e) => set("title", e.target.value)} />
            </Field>
            <Field label="Année">
              <input className="settings__input" value={draft.year ?? ""} onChange={(e) => set("year", e.target.value)} />
            </Field>
            {(t === "article" || t === "chapter" || t === "web") && (
              <Field label={t === "article" ? "Revue" : t === "web" ? "Site web" : "Ouvrage"}>
                <input className="settings__input" value={draft.container ?? ""} onChange={(e) => set("container", e.target.value)} />
              </Field>
            )}
            {t !== "article" && t !== "web" && (
              <>
                <Field label="Éditeur">
                  <input className="settings__input" value={draft.publisher ?? ""} onChange={(e) => set("publisher", e.target.value)} />
                </Field>
                <Field label="Lieu d'édition">
                  <input className="settings__input" value={draft.place ?? ""} onChange={(e) => set("place", e.target.value)} />
                </Field>
                <Field label="Édition">
                  <input className="settings__input" value={draft.edition ?? ""} onChange={(e) => set("edition", e.target.value)} />
                </Field>
              </>
            )}
            {t === "article" && (
              <>
                <Field label="Volume">
                  <input className="settings__input" value={draft.volume ?? ""} onChange={(e) => set("volume", e.target.value)} />
                </Field>
                <Field label="Numéro">
                  <input className="settings__input" value={draft.issue ?? ""} onChange={(e) => set("issue", e.target.value)} />
                </Field>
              </>
            )}
            {(t === "article" || t === "chapter") && (
              <Field label="Pages (ex. 45-67)">
                <input className="settings__input" value={draft.pages ?? ""} onChange={(e) => set("pages", e.target.value)} />
              </Field>
            )}
            <Field label="Adresse (URL)">
              <input className="settings__input" value={draft.url ?? ""} onChange={(e) => set("url", e.target.value)} />
            </Field>
            <Field label="DOI">
              <input className="settings__input" value={draft.doi ?? ""} onChange={(e) => set("doi", e.target.value)} />
            </Field>
            {t === "web" && (
              <Field label="Date de consultation">
                <input className="settings__input" type="date" value={draft.accessed ?? ""} onChange={(e) => set("accessed", e.target.value)} />
              </Field>
            )}
            {errors.length > 0 && (
              <ul role="alert" className="settings__error">
                {errors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            )}
            <div className="sources__actions">
              <Button onClick={saveDraft}>Enregistrer la source</Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setDraft(null);
                  setErrors([]);
                }}
              >
                Annuler
              </Button>
            </div>
          </section>
        )}
      </div>
    </Modal>
  );
}
