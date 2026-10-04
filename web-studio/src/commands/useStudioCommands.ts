/**
 * Commandes du module Documents, déclarées dans le registre tant que l'éditeur
 * est affiché (la palette globale les liste, avec leur raccourci).
 */
import { useMemo, useRef } from "react";
import type { Editor } from "@tiptap/react";
import type { Studio } from "../studio/types";
import { useDialogs } from "../ui/dialogs";
import { useI18n } from "../i18n";
import { formatBinding, isMac } from "../settings/shortcuts";
import { useRegisterCommands, type AppCommand } from "./registry";

export function useStudioCommands(studio: Studio, editor: Editor | null, onOpenPageSettings: () => void): void {
  const { t } = useI18n();
  const { prompt } = useDialogs();
  const editable = studio.editable;
  const numbered = studio.file.document.page.numberedHeadings ?? false;
  const ref = useRef(studio);
  ref.current = studio;
  const mac = isMac();
  const key = (b: string) => formatBinding(b, mac);

  const commands = useMemo<AppCommand[]>(() => {
    const list: AppCommand[] = [];
    const add = (c: Omit<AppCommand, "group"> & { group?: AppCommand["group"] }) =>
      list.push({ group: "module", ...c });
    const chain = () => editor!.chain().focus();

    if (editable) {
      add({
        id: "doc.save",
        label: t("studio.cmd.save"),
        group: "file",
        shortcutId: "save",
        keywords: "enregistrer sauvegarder save",
        run: () => void ref.current.save(),
      });
      add({
        id: "doc.saveAs",
        label: t("studio.cmd.save_as"),
        group: "file",
        shortcutId: "saveAs",
        keywords: "enregistrer sous emplacement save as",
        run: () => void ref.current.saveAs(),
      });
    }
    add({
      id: "doc.exp-pdf",
      label: t("studio.cmd.export_pdf"),
      group: "file",
      keywords: "export imprimer print",
      run: () => void ref.current.exportAs("pdf"),
    });
    add({
      id: "doc.exp-docx",
      label: t("studio.cmd.export_docx"),
      group: "file",
      keywords: "export word",
      run: () => void ref.current.exportAs("docx"),
    });
    add({
      id: "doc.exp-html",
      label: t("studio.cmd.export_html"),
      group: "file",
      run: () => void ref.current.exportAs("html"),
    });
    add({
      id: "doc.exp-md",
      label: t("studio.cmd.export_md"),
      group: "file",
      keywords: "markdown",
      run: () => void ref.current.exportAs("md"),
    });
    add({
      id: "doc.exp-report",
      label: t("studio.cmd.export_report"),
      group: "file",
      keywords: "preuve signature json",
      run: () => void ref.current.exportAs("report"),
    });
    if (editable) {
      add({
        id: "doc.sign",
        label: t("studio.cmd.sign"),
        keywords: "signature signer",
        run: () => ref.current.openSignatureCreator(),
      });
      add({
        id: "doc.page",
        label: t("studio.cmd.page"),
        keywords: "marges en-tête pied format",
        run: onOpenPageSettings,
      });
    }
    add({
      id: "doc.mode",
      label: editable ? t("studio.cmd.to_read") : t("studio.cmd.to_edit"),
      keywords: "lecture édition aperçu",
      run: () => (editable ? void ref.current.toViewer() : ref.current.toEditor()),
    });

    if (editor && editable) {
      add({ id: "doc.undo", label: t("studio.cmd.undo"), hint: key("Mod+Z"), run: () => void chain().undo().run() });
      add({ id: "doc.redo", label: t("studio.cmd.redo"), hint: key("Mod+Y"), run: () => void chain().redo().run() });
      add({
        id: "doc.bold",
        label: t("studio.cmd.bold"),
        hint: key("Mod+B"),
        run: () => void chain().toggleBold().run(),
      });
      add({
        id: "doc.italic",
        label: t("studio.cmd.italic"),
        hint: key("Mod+I"),
        run: () => void chain().toggleItalic().run(),
      });
      add({
        id: "doc.underline",
        label: t("studio.cmd.underline"),
        hint: key("Mod+U"),
        run: () => void chain().toggleUnderline().run(),
      });
      add({ id: "doc.strike", label: t("studio.cmd.strike"), run: () => void chain().toggleStrike().run() });
      add({
        id: "doc.h1",
        label: t("studio.cmd.h1"),
        keywords: "titre heading",
        run: () => void chain().toggleHeading({ level: 1 }).run(),
      });
      add({
        id: "doc.h2",
        label: t("studio.cmd.h2"),
        keywords: "titre heading",
        run: () => void chain().toggleHeading({ level: 2 }).run(),
      });
      add({
        id: "doc.h3",
        label: t("studio.cmd.h3"),
        keywords: "titre heading",
        run: () => void chain().toggleHeading({ level: 3 }).run(),
      });
      add({ id: "doc.paragraph", label: t("studio.cmd.paragraph"), run: () => void chain().setParagraph().run() });
      add({
        id: "doc.bullets",
        label: t("studio.cmd.bullets"),
        keywords: "liste puces",
        run: () => void chain().toggleBulletList().run(),
      });
      add({
        id: "doc.numbered",
        label: t("studio.cmd.numbered"),
        keywords: "liste numérotée",
        run: () => void chain().toggleOrderedList().run(),
      });
      add({
        id: "doc.quote",
        label: t("studio.cmd.quote"),
        keywords: "citation",
        run: () => void chain().toggleBlockquote().run(),
      });
      add({
        id: "doc.rule",
        label: t("studio.cmd.rule"),
        keywords: "ligne séparateur",
        run: () => void chain().setHorizontalRule().run(),
      });
      add({
        id: "doc.toc",
        label: t("studio.cmd.toc"),
        keywords: "sommaire",
        run: () => void chain().insertTableOfContents().run(),
      });
      add({
        id: "doc.footnote",
        label: t("studio.cmd.footnote"),
        keywords: "note",
        run: () =>
          void (async () => {
            const v = await prompt({
              title: t("studio.cmd.footnote_title"),
              label: t("studio.cmd.footnote_label"),
              multiline: true,
            });
            if (v !== null) editor.chain().focus().insertFootnote(v).run();
          })(),
      });
      add({
        id: "doc.bookmark",
        label: t("studio.cmd.bookmark"),
        run: () =>
          void (async () => {
            const v = await prompt({ title: t("studio.cmd.bookmark"), label: t("studio.cmd.bookmark_label") });
            if (v) editor.chain().focus().insertBookmark(v).run();
          })(),
      });
      add({
        id: "doc.numbering",
        label: numbered ? t("studio.cmd.numbering_off") : t("studio.cmd.numbering_on"),
        run: () => ref.current.updatePage({ numberedHeadings: !numbered }),
      });
      add({
        id: "doc.track",
        label: t("studio.cmd.track"),
        keywords: "révision suivi modifications",
        run: () => void chain().toggleSuggesting().run(),
      });
    }
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    ref.current.save,
    ref.current.saveAs,
    ref.current.exportAs,
    ref.current.openSignatureCreator,
    ref.current.toViewer,
    ref.current.toEditor,
    ref.current.updatePage,
    editable,
    numbered,
    editor,
    onOpenPageSettings,
    prompt,
    t,
    mac,
  ]);

  useRegisterCommands("studio", commands);
}
