/** Imprimer / PDF : documents 1-2-3-4-6-9 par page, pages de notes, diapositives masquées, en-tête/pied. */
import { useMemo, useState } from "react";
import { Modal, Button } from "../ui/components";
import { useDialogs } from "../ui/dialogs";
import { reportError } from "../ui/crash-log";
import { downloadBlob } from "../export/exporters";
import { DEFAULT_HANDOUT, planHandouts, type HandoutMode, type HandoutOptions } from "./handouts-layout";
import type { Deck } from "./model";

const MODES: { value: HandoutMode; label: string }[] = [
  { value: 1, label: "1 diapositive par page" },
  { value: 2, label: "2 par page" },
  { value: 3, label: "3 par page (avec lignes de notes)" },
  { value: 4, label: "4 par page" },
  { value: 6, label: "6 par page" },
  { value: 9, label: "9 par page" },
  { value: "notes", label: "Pages de notes (diapositive + notes du présentateur)" },
];

export default function HandoutsDialog({ deck, title, onClose }: { deck: Deck; title: string; onClose: () => void }) {
  const dialogs = useDialogs();
  const [o, setO] = useState<HandoutOptions>({ ...DEFAULT_HANDOUT, footer: "{titre} — page {page}/{pages}" });
  const [busy, setBusy] = useState("");
  const plan = useMemo(() => planHandouts(deck.slides, o), [deck.slides, o]);
  const set = (p: Partial<HandoutOptions>) => setO((x) => ({ ...x, ...p }));

  const run = async () => {
    setBusy("Mise en page…");
    try {
      const { handoutsToPdf } = await import("./handouts");
      const { bytes } = await handoutsToPdf(deck, title, o, (d, t) => setBusy(`Mise en page… ${d}/${t}`));
      downloadBlob(
        `${title || "presentation"}-${o.mode === "notes" ? "notes" : `documents-${o.mode}`}.pdf`,
        "application/pdf",
        bytes,
      );
      onClose();
    } catch (e) {
      reportError("slides-handouts", e);
      await dialogs.alert({
        title: "Impression impossible",
        message: e instanceof Error ? e.message : "Le PDF n'a pas pu être généré.",
      });
    } finally {
      setBusy("");
    }
  };

  return (
    <Modal
      title="Imprimer / exporter en PDF"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Annuler
          </Button>
          <Button onClick={run} disabled={!!busy || plan.pages.length === 0}>
            {busy || "Exporter en PDF"}
          </Button>
        </>
      }
    >
      <div className="settings">
        <section className="settings__section">
          <p role="status">
            {plan.keep.length} diapositive{plan.keep.length > 1 ? "s" : ""} → {plan.pages.length} page
            {plan.pages.length > 1 ? "s" : ""}
          </p>
          <label className="settings__row">
            Mise en page
            <select
              className="settings__input"
              value={String(o.mode)}
              onChange={(e) =>
                set({ mode: e.target.value === "notes" ? "notes" : (Number(e.target.value) as HandoutMode) })
              }
            >
              {MODES.map((m) => (
                <option key={String(m.value)} value={String(m.value)}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          {o.mode !== "notes" && (
            <label className="settings__row">
              Orientation
              <select
                className="settings__input"
                value={o.orientation ?? "portrait"}
                onChange={(e) => set({ orientation: e.target.value as "portrait" | "landscape" })}
              >
                <option value="portrait">Portrait</option>
                <option value="landscape">Paysage</option>
              </select>
            </label>
          )}
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={o.includeHidden}
              onChange={(e) => set({ includeHidden: e.target.checked })}
            />
            <span>Inclure les diapositives masquées</span>
          </label>
          <label className="checkbox-row">
            <input type="checkbox" checked={o.frame} onChange={(e) => set({ frame: e.target.checked })} />
            <span>Cadre autour des diapositives</span>
          </label>
          <label className="settings__row">
            En-tête ({"{titre}"}, {"{date}"})
            <input
              className="settings__input"
              value={o.header ?? ""}
              onChange={(e) => set({ header: e.target.value })}
            />
          </label>
          <label className="settings__row">
            Pied de page ({"{page}"}, {"{pages}"})
            <input
              className="settings__input"
              value={o.footer ?? ""}
              onChange={(e) => set({ footer: e.target.value })}
            />
          </label>
        </section>
      </div>
    </Modal>
  );
}
