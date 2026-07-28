import { useState } from "react";
import type { Editor } from "@tiptap/react";
import { Modal, Button, Field } from "../ui/components";
import { FONT_FAMILIES, FONT_SIZES } from "./typography";
import { customFontNames, fontCss } from "../ui/fonts";
import {
  CASE_LABELS, UNDERLINE_LABELS, parsePx, type CaseMode, type UnderlineStyle,
} from "./charFormat";

const UNDERLINES: UnderlineStyle[] = ["none", "single", "double", "dotted", "dashed", "wavy"];
const CASES: CaseMode[] = ["sentence", "lower", "upper", "title", "toggle"];

/**
 * The Police dialog (Word's Font dialog): every character attribute in one place,
 * with a live preview of the selection's current formatting.
 *
 * Each control applies immediately to the selection — no OK/Cancel round trip,
 * which matches how the ribbon behaves everywhere else in the app.
 */
export default function FontDialog({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  // Re-read attributes after each command so the controls and preview stay live.
  const [tick, setTick] = useState(0);
  const bump = () => setTick((t) => t + 1);
  const ts = editor.getAttributes("textStyle");
  const has = (mark: string) => editor.isActive(mark);
  const chain = () => editor.chain().focus();
  const run = (fn: () => void) => {
    fn();
    bump();
  };

  const family = String(ts.fontFamily ?? "");
  const sizePx = parsePx(ts.fontSize);
  const spacing = parsePx(ts.letterSpacing) ?? 0;
  const position = parsePx(ts.textPosition) ?? 0;
  const underlineStyle: UnderlineStyle = has("underline")
    ? ((String(ts.underlineStyle ?? "single") || "single") as UnderlineStyle)
    : "none";

  const previewStyle: React.CSSProperties = {
    fontFamily: family || undefined,
    fontSize: sizePx ? `${Math.min(40, sizePx)}px` : undefined,
    fontWeight: has("bold") ? 700 : undefined,
    fontStyle: has("italic") ? "italic" : undefined,
    color: (ts.color as string) || undefined,
    letterSpacing: spacing ? `${spacing}px` : undefined,
    fontVariantCaps: ts.smallCaps ? "small-caps" : undefined,
    textTransform: ts.allCaps ? "uppercase" : undefined,
    textDecorationLine:
      [has("underline") ? "underline" : "", has("strike") || ts.doubleStrike ? "line-through" : ""]
        .filter(Boolean)
        .join(" ") || undefined,
    textDecorationStyle: ts.doubleStrike
      ? "double"
      : underlineStyle !== "none" && underlineStyle !== "single"
        ? (underlineStyle as "dotted" | "dashed" | "wavy" | "double")
        : undefined,
  };

  const toggle = (label: string, active: boolean, onClick: () => void, title?: string) => (
    <button
      type="button"
      className={`fontdlg__toggle ${active ? "is-active" : ""}`}
      onClick={() => run(onClick)}
      aria-pressed={active}
      title={title ?? label}
    >
      {label}
    </button>
  );

  return (
    <Modal
      title="Police"
      onClose={onClose}
      wide
      footer={
        <>
          <Button
            variant="outline"
            onClick={() => run(() => chain().clearCharFormatting().run())}
            disabled={editor.state.selection.empty}
            title="Retirer toute la mise en forme de caractère de la sélection"
          >
            Effacer la mise en forme
          </Button>
          <Button onClick={onClose}>Fermer</Button>
        </>
      }
    >
      <div className="settings" data-tick={tick}>
        <section className="settings__section">
          <h3 className="settings__title">Police et taille</h3>
          <div className="settings__row">
            <select
              className="settings__select"
              style={{ maxWidth: 220 }}
              aria-label="Police"
              value={family}
              onChange={(e) =>
                run(() => (e.target.value ? chain().setFontFamily(e.target.value).run() : chain().unsetFontFamily().run()))
              }
            >
              {FONT_FAMILIES.map((f) => (
                <option key={f.label} value={f.value}>{f.label}</option>
              ))}
              {customFontNames().map((n) => (
                <option key={n} value={fontCss(n)}>{n}</option>
              ))}
            </select>
            <select
              className="settings__select"
              style={{ maxWidth: 100 }}
              aria-label="Taille"
              value={sizePx ? `${sizePx}px` : ""}
              onChange={(e) =>
                run(() => (e.target.value ? chain().setFontSize(e.target.value).run() : chain().unsetFontSize().run()))
              }
            >
              <option value="">Taille</option>
              {FONT_SIZES.map((s) => (
                <option key={s} value={s}>{s.replace("px", "")}</option>
              ))}
            </select>
            <Button variant="outline" size="sm" onClick={() => run(() => chain().shrinkFontSize().run())} title="Réduire la taille (Ctrl+Maj+<)">A−</Button>
            <Button variant="outline" size="sm" onClick={() => run(() => chain().growFontSize().run())} title="Agrandir la taille (Ctrl+Maj+>)">A+</Button>
          </div>
        </section>

        <section className="settings__section">
          <h3 className="settings__title">Style</h3>
          <div className="fontdlg__toggles">
            {toggle("Gras", has("bold"), () => chain().toggleBold().run())}
            {toggle("Italique", has("italic"), () => chain().toggleItalic().run())}
            {toggle("Barré", has("strike"), () => chain().toggleStrike().run())}
            {toggle("Barré double", ts.doubleStrike === true, () => chain().toggleDoubleStrike().run())}
            {toggle("x²", has("superscript"), () => chain().toggleSuperscript().run(), "Exposant (Ctrl+Maj+=)")}
            {toggle("x₂", has("subscript"), () => chain().toggleSubscript().run(), "Indice (Ctrl+=)")}
            {toggle("Petites majuscules", ts.smallCaps === true, () => chain().toggleSmallCaps().run(), "Petites majuscules (Ctrl+Maj+K)")}
            {toggle("MAJUSCULES", ts.allCaps === true, () => chain().toggleAllCaps().run())}
          </div>
        </section>

        <section className="settings__section">
          <h3 className="settings__title">Soulignement et couleur</h3>
          <div className="settings__row">
            <Field label="Soulignement">
              <select
                className="settings__select"
                value={underlineStyle}
                onChange={(e) => run(() => chain().setUnderlineStyle(e.target.value as UnderlineStyle).run())}
              >
                {UNDERLINES.map((u) => (
                  <option key={u} value={u}>{UNDERLINE_LABELS[u]}</option>
                ))}
              </select>
            </Field>
            <Field label="Couleur du texte">
              <input
                type="color"
                value={(ts.color as string) || "#1f2937"}
                onChange={(e) => run(() => chain().setColor(e.target.value).run())}
                aria-label="Couleur du texte"
              />
            </Field>
            <Field label="Surlignage">
              <input
                type="color"
                value={(editor.getAttributes("highlight").color as string) || "#fff34d"}
                onChange={(e) => run(() => chain().setHighlight({ color: e.target.value }).run())}
                aria-label="Couleur de surlignage"
              />
            </Field>
          </div>
        </section>

        <section className="settings__section">
          <h3 className="settings__title">Espacement et position</h3>
          <div className="settings__row">
            <Field label="Espacement (px)" hint="Négatif = condensé, positif = étendu.">
              <input
                type="number"
                className="settings__input settings__margin-input"
                min={-5}
                max={20}
                step={0.5}
                value={spacing}
                onChange={(e) => run(() => chain().setLetterSpacing(Number(e.target.value)).run())}
              />
            </Field>
            <Field label="Position (px)" hint="Positif = surélevé, négatif = abaissé.">
              <input
                type="number"
                className="settings__input settings__margin-input"
                min={-20}
                max={20}
                value={position}
                onChange={(e) => run(() => chain().setTextPosition(Number(e.target.value)).run())}
              />
            </Field>
          </div>
        </section>

        <section className="settings__section">
          <h3 className="settings__title">Modifier la casse</h3>
          <div className="fontdlg__toggles">
            {CASES.map((mode) => (
              <button
                key={mode}
                type="button"
                className="fontdlg__toggle"
                disabled={editor.state.selection.empty}
                onClick={() => run(() => chain().changeCase(mode).run())}
                title={`Modifier la casse : ${CASE_LABELS[mode]}`}
              >
                {CASE_LABELS[mode]}
              </button>
            ))}
          </div>
          {editor.state.selection.empty && (
            <p className="muted">Sélectionnez du texte pour en modifier la casse.</p>
          )}
        </section>

        <section className="settings__section">
          <h3 className="settings__title">Aperçu</h3>
          <div className="fontdlg__preview" style={previewStyle}>
            Portez ce vieux whisky au juge blond qui fume — 0123
          </div>
        </section>
      </div>
        <p className="settings__hint modal-live">
          Les changements s'appliquent immédiatement à la sélection ; « Fermer » ne les annule pas.
        </p>
    </Modal>
  );
}
