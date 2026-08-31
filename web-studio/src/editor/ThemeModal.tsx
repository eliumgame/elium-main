/**
 * "Thème" — one click applies a named colour/font preset to headings and
 * accent styles (see themes.ts). No live preview needed: applying a theme is
 * instant and undoable like any other formatting change (Ctrl+Z works on it,
 * since it is a normal `onStylesChange` write).
 */
import type { EliumDocStyle } from "../format/types";
import { Modal, Button } from "../ui/components";
import { DOC_THEMES, applyDocTheme, type DocTheme } from "./themes";

export default function ThemeModal({
  activeTheme,
  currentStyles,
  onApply,
  onClose,
}: {
  activeTheme?: string;
  currentStyles?: EliumDocStyle[];
  onApply: (themeId: string, styles: EliumDocStyle[]) => void;
  onClose: () => void;
}) {
  const apply = (theme: DocTheme) => {
    onApply(theme.id, applyDocTheme(currentStyles, theme));
    onClose();
  };

  return (
    <Modal title="Thème du document" onClose={onClose} footer={<Button onClick={onClose}>Fermer</Button>}>
      <div className="settings">
        <section className="settings__section">
          <p className="muted">
            Recolore les titres et les styles d'accentuation en un clic. Une couleur ou une police modifiée à la main
            ensuite reste modifiable normalement dans le gestionnaire de styles.
          </p>
          <div className="theme-grid">
            {DOC_THEMES.map((t) => (
              <button
                key={t.id}
                type="button"
                className={`theme-swatch${t.id === activeTheme ? " is-active" : ""}`}
                onClick={() => apply(t)}
                title={t.name}
              >
                <span className="theme-swatch__dot" style={{ background: t.accent }} />
                <span className="theme-swatch__label">
                  {t.name}
                  {t.id === activeTheme && " ✓"}
                </span>
              </button>
            ))}
          </div>
        </section>
      </div>
    </Modal>
  );
}
