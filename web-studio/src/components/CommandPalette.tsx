import { useEffect, useMemo, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { Search } from "lucide-react";
import type { Studio } from "../studio/types";
import { useDialogs } from "../ui/dialogs";

interface Command {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

/**
 * Workspace command palette (Ctrl/Cmd+K). A single searchable entry point to
 * every document action — driven by the Studio contract and the live editor.
 */
export default function CommandPalette({
  studio,
  editor,
  onOpenPageSettings,
  onClose,
}: {
  studio: Studio;
  editor: Editor | null;
  onOpenPageSettings: () => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const { prompt } = useDialogs();

  const commands = useMemo<Command[]>(() => {
    const editable = studio.editable;
    const close = (fn: () => void) => () => {
      onClose();
      fn();
    };
    const list: Command[] = [];
    if (editable) list.push({ id: "save", label: "Enregistrer le document", run: close(() => void studio.save()) });
    list.push({ id: "exp-pdf", label: "Exporter en PDF", run: close(() => void studio.exportAs("pdf")) });
    list.push({ id: "exp-docx", label: "Exporter en Word (.docx)", run: close(() => void studio.exportAs("docx")) });
    list.push({ id: "exp-html", label: "Exporter en HTML", run: close(() => void studio.exportAs("html")) });
    list.push({ id: "exp-md", label: "Exporter en Markdown", run: close(() => void studio.exportAs("md")) });
    list.push({ id: "exp-report", label: "Exporter le rapport de preuve (JSON)", run: close(() => void studio.exportAs("report")) });
    if (editable) list.push({ id: "sign", label: "Ajouter une signature", run: close(() => studio.openSignatureCreator()) });
    if (editable) list.push({ id: "page", label: "Mise en page (en-tête, pied, format)", run: close(onOpenPageSettings) });
    list.push({
      id: "mode",
      label: editable ? "Passer en mode lecture" : "Passer en mode édition",
      run: close(() => {
        if (editable) void studio.toViewer();
        else studio.toEditor();
      }),
    });
    list.push({ id: "settings", label: "Paramètres", run: close(() => studio.openSettings()) });
    list.push({ id: "home", label: "Retour à l'accueil", run: close(() => studio.goHome()) });

    if (editor && editable) {
      list.push({ id: "toc", label: "Insérer une table des matières", run: close(() => editor.chain().focus().insertTableOfContents().run()) });
      list.push({
        id: "fn",
        label: "Insérer une note de bas de page",
        run: close(async () => {
          const t = await prompt({ title: "Note de bas de page", label: "Texte de la note", multiline: true });
          if (t !== null) editor.chain().focus().insertFootnote(t).run();
        }),
      });
      list.push({
        id: "bm",
        label: "Insérer un signet",
        run: close(async () => {
          const l = await prompt({ title: "Insérer un signet", label: "Nom du signet" });
          if (l) editor.chain().focus().insertBookmark(l).run();
        }),
      });
      list.push({
        id: "num",
        label: `${studio.file.document.page.numberedHeadings ? "Désactiver" : "Activer"} la numérotation des titres`,
        run: close(() => studio.updatePage({ numberedHeadings: !(studio.file.document.page.numberedHeadings ?? false) })),
      });
      list.push({ id: "track", label: "Suivi des modifications (activer / désactiver)", run: close(() => editor.chain().focus().toggleSuggesting().run()) });
    }
    return list;
  }, [studio, editor, onOpenPageSettings, onClose, prompt]);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return commands;
    return commands.filter((c) => c.label.toLowerCase().includes(s));
  }, [q, commands]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  useEffect(() => {
    setIdx(0);
  }, [q]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setIdx((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      filtered[idx]?.run();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div className="cmdk-overlay" onClick={onClose}>
      <div className="cmdk" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
        <div className="cmdk__search">
          <Search size={16} />
          <input
            ref={inputRef}
            className="cmdk__input"
            placeholder="Rechercher une action…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <ul className="cmdk__list" ref={listRef}>
          {filtered.length === 0 && <li className="cmdk__empty">Aucune action</li>}
          {filtered.map((c, i) => (
            <li
              key={c.id}
              className={`cmdk__item ${i === idx ? "is-active" : ""}`}
              onMouseEnter={() => setIdx(i)}
              onClick={() => c.run()}
            >
              <span>{c.label}</span>
              {c.hint && <kbd className="cmdk__kbd">{c.hint}</kbd>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
