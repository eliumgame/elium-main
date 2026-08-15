import { useMemo, useState } from "react";
import type { Editor } from "@tiptap/react";
import { Plus, Trash2 } from "lucide-react";
import { Modal, Button, Field, Alert } from "../ui/components";
import { useDialogs } from "../ui/dialogs";
import { FONT_FAMILIES, FONT_SIZES } from "./typography";
import {
  mergeStyles,
  newStyleId,
  resolveStyle,
  styleCss,
  type DocStyle,
  type StyleChar,
  type StylePara,
} from "./styles";
import type { EliumDocStyle } from "../format/types";

/**
 * The Styles manager (Word's "Gérer les styles"): browse the effective style
 * set, modify a style — including a built-in — create one from the current
 * selection, rename it, and delete the document's own.
 *
 * Modifying a style re-flows every paragraph using it, which is the reason to use
 * styles at all, so the changes are saved into the DOCUMENT (they travel in the
 * `.elium`) rather than into a per-session preference.
 */
export default function StylesManager({
  editor,
  custom,
  onChange,
  onClose,
}: {
  editor: Editor;
  /** The document's own styles. */
  custom: EliumDocStyle[];
  onChange: (styles: EliumDocStyle[]) => void;
  onClose: () => void;
}) {
  const { prompt, confirm } = useDialogs();
  const all = useMemo(() => mergeStyles(custom as DocStyle[]), [custom]);
  const [selectedId, setSelectedId] = useState<string>(all[0]?.id ?? "Normal");
  const selected = all.find((s) => s.id === selectedId) ?? all[0] ?? null;
  const resolved = resolveStyle(all, selected?.id);

  /** Write a style back into the document's own list. */
  const upsert = (style: DocStyle) => {
    const next = (custom as DocStyle[]).filter((s) => s.id !== style.id);
    next.push(style);
    onChange(next as EliumDocStyle[]);
  };

  const patch = (part: { char?: Partial<StyleChar>; para?: Partial<StylePara>; name?: string }) => {
    if (!selected) return;
    upsert({
      ...selected,
      ...(part.name ? { name: part.name } : {}),
      char: { ...selected.char, ...part.char },
      para: { ...selected.para, ...part.para },
    });
  };

  /** Create a style from the formatting currently under the cursor. */
  const createFromSelection = async () => {
    const name = await prompt({ title: "Nouveau style", label: "Nom du style", placeholder: "ex. Intertitre" });
    if (!name?.trim()) return;
    const ts = editor.getAttributes("textStyle");
    const isHeading = editor.isActive("heading");
    const block = isHeading ? editor.getAttributes("heading") : editor.getAttributes("paragraph");
    const size = parseFloat(String(ts.fontSize ?? ""));
    const style: DocStyle = {
      id: newStyleId(name, all),
      name: name.trim(),
      kind: "paragraph",
      basedOn: "Normal",
      block: isHeading ? { type: "heading", level: Number(block.level) || 1 } : { type: "paragraph" },
      char: {
        ...(ts.fontFamily ? { fontFamily: String(ts.fontFamily) } : {}),
        ...(Number.isFinite(size) ? { fontSize: size } : {}),
        ...(editor.isActive("bold") ? { bold: true } : {}),
        ...(editor.isActive("italic") ? { italic: true } : {}),
        ...(editor.isActive("underline") ? { underline: true } : {}),
        ...(ts.color ? { color: String(ts.color) } : {}),
        ...(ts.smallCaps ? { smallCaps: true } : {}),
      },
      para: {
        ...(block.textAlign ? { align: block.textAlign as StylePara["align"] } : {}),
        ...(block.spaceBefore != null ? { spaceBefore: Number(block.spaceBefore) } : {}),
        ...(block.spaceAfter != null ? { spaceAfter: Number(block.spaceAfter) } : {}),
        ...(block.lineHeight ? { lineHeight: String(block.lineHeight) } : {}),
      },
      quick: true,
    };
    upsert(style);
    setSelectedId(style.id);
  };

  const remove = async () => {
    if (!selected) return;
    const isOwn = (custom as DocStyle[]).some((s) => s.id === selected.id);
    if (!isOwn) return;
    const ok = await confirm({
      title: "Supprimer le style",
      message: selected.builtIn
        ? `Rétablir « ${selected.name} » dans sa définition d'origine ?`
        : `Supprimer le style « ${selected.name} » ? Les paragraphes qui l'utilisent gardent leur mise en forme.`,
      danger: !selected.builtIn,
      confirmLabel: selected.builtIn ? "Rétablir" : "Supprimer",
    });
    if (!ok) return;
    onChange((custom as DocStyle[]).filter((s) => s.id !== selected.id) as EliumDocStyle[]);
    setSelectedId("Normal");
  };

  const rename = async () => {
    if (!selected) return;
    const name = await prompt({ title: "Renommer le style", label: "Nom", defaultValue: selected.name });
    if (!name?.trim()) return;
    patch({ name: name.trim() });
  };

  const overridden = (custom as DocStyle[]).some((s) => s.id === selected?.id);
  const char = resolved?.char ?? {};
  const para = resolved?.para ?? {};

  return (
    <Modal
      title="Styles"
      onClose={onClose}
      wide
      footer={
        <>
          <Button variant="outline" onClick={createFromSelection}>
            <Plus size={15} /> Créer depuis la sélection
          </Button>
          <Button variant="ghost" onClick={rename} disabled={!selected}>
            Renommer
          </Button>
          <Button variant="outline" onClick={remove} disabled={!overridden}>
            <Trash2 size={15} /> {selected?.builtIn ? "Rétablir" : "Supprimer"}
          </Button>
          <Button onClick={onClose}>Fermer</Button>
        </>
      }
    >
      <div className="stylemgr">
        <ul className="stylemgr__list">
          {all.map((s) => {
            const r = resolveStyle(all, s.id);
            return (
              <li key={s.id}>
                <button
                  type="button"
                  className={`stylemgr__item ${s.id === selectedId ? "is-active" : ""}`}
                  onClick={() => setSelectedId(s.id)}
                >
                  <span className="stylemgr__sample">
                    {/* `all: unset` so the sample shows the STYLE, not the
                        surrounding UI font — this is Word's live preview. */}
                    <span style={{ all: "unset", ...cssToObject(styleCss(r)) }}>{s.name}</span>
                  </span>
                  <span className="stylemgr__kind">
                    {s.kind === "character" ? "caractère" : "paragraphe"}
                    {(custom as DocStyle[]).some((c) => c.id === s.id) ? " · modifié" : ""}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>

        <div className="stylemgr__editor">
          {!selected ? (
            <p className="muted">Choisissez un style.</p>
          ) : (
            <>
              <h3 className="settings__title">{selected.name}</h3>
              {selected.builtIn && !overridden && (
                <Alert tone="info">Style intégré — le modifier crée une version propre à ce document.</Alert>
              )}

              <section className="settings__section">
                <h3 className="settings__title">Caractère</h3>
                <div className="settings__row">
                  <select
                    className="settings__select"
                    style={{ maxWidth: 190 }}
                    aria-label="Police du style"
                    value={char.fontFamily ?? ""}
                    onChange={(e) => patch({ char: { fontFamily: e.target.value || undefined } })}
                  >
                    {FONT_FAMILIES.map((f) => (
                      <option key={f.label} value={f.value}>
                        {f.label}
                      </option>
                    ))}
                  </select>
                  <select
                    className="settings__select"
                    style={{ maxWidth: 90 }}
                    aria-label="Taille du style"
                    value={char.fontSize ? `${char.fontSize}px` : ""}
                    onChange={(e) => patch({ char: { fontSize: parseFloat(e.target.value) || undefined } })}
                  >
                    <option value="">Taille</option>
                    {FONT_SIZES.map((s) => (
                      <option key={s} value={s}>
                        {s.replace("px", "")}
                      </option>
                    ))}
                  </select>
                  <Field label="Couleur">
                    <input
                      type="color"
                      value={char.color ?? "#1f2937"}
                      onChange={(e) => patch({ char: { color: e.target.value } })}
                      aria-label="Couleur du style"
                    />
                  </Field>
                </div>
                <div className="fontdlg__toggles">
                  {(
                    [
                      ["bold", "Gras"],
                      ["italic", "Italique"],
                      ["underline", "Souligné"],
                      ["strike", "Barré"],
                      ["smallCaps", "Petites majuscules"],
                      ["allCaps", "MAJUSCULES"],
                    ] as const
                  ).map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      className={`fontdlg__toggle ${char[key] ? "is-active" : ""}`}
                      onClick={() => patch({ char: { [key]: char[key] ? undefined : true } })}
                      aria-pressed={char[key] === true}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </section>

              {selected.kind === "paragraph" && (
                <section className="settings__section">
                  <h3 className="settings__title">Paragraphe</h3>
                  <div className="settings__row">
                    <select
                      className="settings__select"
                      aria-label="Alignement du style"
                      value={para.align ?? "left"}
                      onChange={(e) => patch({ para: { align: e.target.value as StylePara["align"] } })}
                    >
                      <option value="left">Gauche</option>
                      <option value="center">Centré</option>
                      <option value="right">Droite</option>
                      <option value="justify">Justifié</option>
                    </select>
                  </div>
                  <div className="settings__margin-grid">
                    <Field label="Avant (px)">
                      <input
                        type="number"
                        className="settings__input settings__margin-input"
                        min={0}
                        max={120}
                        value={para.spaceBefore ?? 0}
                        onChange={(e) => patch({ para: { spaceBefore: Number(e.target.value) } })}
                      />
                    </Field>
                    <Field label="Après (px)">
                      <input
                        type="number"
                        className="settings__input settings__margin-input"
                        min={0}
                        max={120}
                        value={para.spaceAfter ?? 0}
                        onChange={(e) => patch({ para: { spaceAfter: Number(e.target.value) } })}
                      />
                    </Field>
                    <Field label="1ʳᵉ ligne (px)">
                      <input
                        type="number"
                        className="settings__input settings__margin-input"
                        min={-120}
                        max={120}
                        value={para.firstLineIndent ?? 0}
                        onChange={(e) => patch({ para: { firstLineIndent: Number(e.target.value) || undefined } })}
                      />
                    </Field>
                  </div>
                  <label className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={para.keepNext === true}
                      onChange={(e) => patch({ para: { keepNext: e.target.checked || undefined } })}
                    />
                    <span>Paragraphes solidaires</span>
                  </label>
                  <label className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={para.keepLines === true}
                      onChange={(e) => patch({ para: { keepLines: e.target.checked || undefined } })}
                    />
                    <span>Lignes solidaires</span>
                  </label>
                </section>
              )}

              <section className="settings__section">
                <h3 className="settings__title">Aperçu</h3>
                <div className="stylemgr__preview">
                  <span style={{ all: "unset", ...cssToObject(styleCss(resolved)) }}>
                    Portez ce vieux whisky au juge blond qui fume
                  </span>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    editor.chain().focus().applyNamedStyle(selected.id).run();
                    onClose();
                  }}
                >
                  Appliquer à la sélection
                </Button>
              </section>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

/** Turn a CSS declaration string into a React style object. */
function cssToObject(css: string): React.CSSProperties {
  const out: Record<string, string> = {};
  for (const decl of css.split(";")) {
    const idx = decl.indexOf(":");
    if (idx < 0) continue;
    const prop = decl.slice(0, idx).trim();
    const value = decl.slice(idx + 1).trim();
    if (!prop || !value) continue;
    out[prop.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] = value;
  }
  return out as React.CSSProperties;
}
