/**
 * Boîtes de dialogue de l'espace de travail : choix d'un dossier de destination
 * et édition des étiquettes.
 */
import { useState } from "react";
import { Folder, FolderOpen, Library, X } from "lucide-react";
import { Button, Modal } from "../../ui/components";
import { useI18n } from "../../i18n";
import { childFolders, descendantFolderIds, normalizeTag } from "../model";
import type { WorkFolder } from "../types";

/** Arbre de dossiers à choisir (racine incluse). Les dossiers `excluded` (et leurs descendants) sont grisés. */
export function FolderPickerDialog({
  folders,
  excluded,
  currentId,
  onPick,
  onCancel,
}: {
  folders: WorkFolder[];
  /** Dossiers qu'on déplace : impossible de les ranger dans eux-mêmes. */
  excluded: string[];
  currentId: string | null;
  onPick: (folderId: string | null) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const [choice, setChoice] = useState<string | null>(currentId);
  const blocked = new Set<string>(excluded);
  for (const id of excluded) for (const d of descendantFolderIds(folders, id)) blocked.add(d);

  const render = (parentId: string | null, depth: number): React.ReactNode =>
    childFolders(folders, parentId).map((f) => (
      <li key={f.id} role="none">
        <button
          type="button"
          role="treeitem"
          aria-selected={choice === f.id}
          disabled={blocked.has(f.id)}
          className={`ws-pick__row ${choice === f.id ? "is-active" : ""}`}
          style={{ paddingLeft: 10 + depth * 18 }}
          onClick={() => setChoice(f.id)}
          onDoubleClick={() => !blocked.has(f.id) && onPick(f.id)}
        >
          {choice === f.id ? <FolderOpen size={16} /> : <Folder size={16} />} {f.name}
        </button>
        {render(f.id, depth + 1)}
      </li>
    ));

  return (
    <Modal
      title={t("workspace.move_to")}
      onClose={onCancel}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
          <Button onClick={() => onPick(choice)}>{t("workspace.move_here")}</Button>
        </>
      }
    >
      <ul role="tree" className="ws-pick" aria-label={t("workspace.folders")}>
        <li role="none">
          <button
            type="button"
            role="treeitem"
            aria-selected={choice === null}
            className={`ws-pick__row ${choice === null ? "is-active" : ""}`}
            onClick={() => setChoice(null)}
          >
            <Library size={16} /> {t("shell.nav.library")}
          </button>
        </li>
        {render(null, 1)}
      </ul>
    </Modal>
  );
}

/** Édition des étiquettes d'un ou plusieurs éléments : on ajoute et on retire ; chaque modification s'applique à tous. */
export function TagsDialog({
  initial,
  suggestions,
  count,
  onSave,
  onCancel,
}: {
  /** Étiquettes déjà communes à la sélection. */
  initial: string[];
  suggestions: string[];
  count: number;
  onSave: (add: string[], remove: string[]) => void;
  onCancel: () => void;
}) {
  const { t, tn } = useI18n();
  const [tags, setTags] = useState<string[]>(initial);
  const [draft, setDraft] = useState("");

  const commit = (raw: string) => {
    const tag = normalizeTag(raw);
    if (tag && !tags.includes(tag)) setTags([...tags, tag]);
    setDraft("");
  };

  return (
    <Modal
      title={tn("workspace.tags_title", count)}
      onClose={onCancel}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
          <Button
            onClick={() => {
              const pending = normalizeTag(draft);
              const final = pending && !tags.includes(pending) ? [...tags, pending] : tags;
              onSave(
                final.filter((x) => !initial.includes(x)),
                initial.filter((x) => !final.includes(x)),
              );
            }}
          >
            {t("common.save")}
          </Button>
        </>
      }
    >
      <div className="ws-tagedit">
        <ul className="ws-tagedit__list" aria-label={t("workspace.tags")}>
          {tags.map((tag) => (
            <li key={tag} className="ws-chip ws-chip--editable">
              {tag}
              <button
                type="button"
                aria-label={`${t("common.remove")} ${tag}`}
                onClick={() => setTags(tags.filter((x) => x !== tag))}
              >
                <X size={11} />
              </button>
            </li>
          ))}
        </ul>
        <input
          className="input"
          value={draft}
          placeholder={t("workspace.tags_placeholder")}
          aria-label={t("workspace.tags_add")}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              commit(draft);
            }
          }}
          list="ws-tag-suggestions"
        />
        <datalist id="ws-tag-suggestions">
          {suggestions
            .filter((s) => !tags.includes(s))
            .map((s) => (
              <option key={s} value={s} />
            ))}
        </datalist>
        <p className="muted">{t("workspace.tags_hint")}</p>
      </div>
    </Modal>
  );
}
