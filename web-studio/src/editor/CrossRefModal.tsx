import { useMemo, useState } from "react";
import type { Editor } from "@tiptap/react";
import { Modal, Button, Field, EmptyState } from "../ui/components";
import { CornerDownRight } from "lucide-react";
import {
  REF_DISPLAY_LABELS, REF_KIND_LABELS, collectTargets, referenceLabel,
  type RefDisplay, type RefKind, type RefTarget,
} from "./crossref";
import { pageOfPos } from "./wordExtensions";

const KIND_ORDER: RefKind[] = ["heading", "bookmark", "figure", "table", "footnote"];
const DISPLAYS: RefDisplay[] = ["text", "number", "page", "aboveBelow", "full"];

/**
 * Insert a renvoi (Word's "Renvoi" dialog): pick what to point at, pick what the
 * reference should show. The preview is computed with the same function the
 * document itself renders with, so what you see here is what lands in the text.
 */
export default function CrossRefModal({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const targets = useMemo(() => collectTargets(editor.state.doc), [editor]);
  const byKind = useMemo(() => {
    const map = new Map<RefKind, RefTarget[]>();
    for (const t of targets) {
      const list = map.get(t.kind);
      if (list) list.push(t);
      else map.set(t.kind, [t]);
    }
    return map;
  }, [targets]);

  const firstKind = KIND_ORDER.find((k) => (byKind.get(k)?.length ?? 0) > 0) ?? "heading";
  const [kind, setKind] = useState<RefKind>(firstKind);
  const [key, setKey] = useState<string>(byKind.get(firstKind)?.[0]?.key ?? "");
  const [display, setDisplay] = useState<RefDisplay>("text");

  const list = byKind.get(kind) ?? [];
  const selected = list.find((t) => t.key === key) ?? list[0];

  const insert = () => {
    if (!selected) return;
    editor.chain().focus().insertCrossReference({ pos: selected.pos, kind: selected.kind, display }).run();
    onClose();
  };

  if (!targets.length) {
    return (
      <Modal title="Insérer un renvoi" onClose={onClose} footer={<Button onClick={onClose}>Fermer</Button>}>
        <EmptyState
          icon={<CornerDownRight size={22} />}
          title="Rien à référencer pour l'instant"
          hint="Un renvoi pointe vers un titre, un signet, une figure, un tableau ou une note de bas de page. Ajoutez-en un, puis revenez ici."
        />
      </Modal>
    );
  }

  return (
    <Modal
      title="Insérer un renvoi"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Annuler</Button>
          <Button onClick={insert} disabled={!selected}>Insérer</Button>
        </>
      }
    >
      <div className="settings">
        <section className="settings__section">
          <Field label="Catégorie">
            <select
              className="settings__select"
              value={kind}
              onChange={(e) => {
                const next = e.target.value as RefKind;
                setKind(next);
                setKey(byKind.get(next)?.[0]?.key ?? "");
              }}
            >
              {KIND_ORDER.filter((k) => (byKind.get(k)?.length ?? 0) > 0).map((k) => (
                <option key={k} value={k}>
                  {REF_KIND_LABELS[k]} ({byKind.get(k)!.length})
                </option>
              ))}
            </select>
          </Field>

          <Field label="Cible">
            <select
              className="settings__select"
              value={selected?.key ?? ""}
              onChange={(e) => setKey(e.target.value)}
              size={Math.min(8, Math.max(3, list.length))}
            >
              {list.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.number ? `${t.number} — ${t.label}` : t.label}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Insérer" hint="Le renvoi se met à jour tout seul quand la cible change.">
            <select className="settings__select" value={display} onChange={(e) => setDisplay(e.target.value as RefDisplay)}>
              {DISPLAYS.map((d) => (
                <option key={d} value={d}>{REF_DISPLAY_LABELS[d]}</option>
              ))}
            </select>
          </Field>
        </section>

        <section className="settings__section">
          <h3 className="settings__title">Aperçu</h3>
          <p className="xref-preview">
            {selected
              ? referenceLabel(selected, display, {
                  // Same page source the inserted renvoi will use, so the preview
                  // is not a different answer from the result.
                  targetPage: pageOfPos(selected.pos),
                  refPos: editor.state.selection.from,
                })
              : "—"}
          </p>
          {display === "page" && <p className="muted">Le numéro de page est celui calculé par la pagination d'Elium.</p>}
        </section>
      </div>
    </Modal>
  );
}
