/**
 * Raccourcis clavier : liste, modification par capture de la combinaison
 * (conflits et combinaisons réservées refusés avec explication), réinitialisation.
 */
import { useEffect, useState } from "react";
import { RotateCcw, Keyboard } from "lucide-react";
import { Button, Alert } from "../../ui/components";
import { useI18n } from "../../i18n";
import {
  SHORTCUTS,
  bindingFromEvent,
  canonical,
  conflictFor,
  formatBinding,
  getOverrides,
  isAcceptableBinding,
  isMac,
  isReserved,
  resetAllBindings,
  resetBinding,
  setBinding,
  setShortcutCapture,
  useBindings,
  type ShortcutId,
} from "../../settings/shortcuts";
import { SectionCard } from "./parts";

export default function ShortcutsSection() {
  const { t } = useI18n();
  const bindings = useBindings();
  const [capturing, setCapturing] = useState<ShortcutId | null>(null);
  const [message, setMessage] = useState<{ tone: "danger" | "warning"; text: string } | null>(null);
  const mac = isMac();
  const customised = Object.keys(getOverrides()).length > 0;

  useEffect(() => {
    if (!capturing) return;
    setShortcutCapture(true);
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setCapturing(null);
        setMessage(null);
        return;
      }
      const b = bindingFromEvent(e);
      if (!b) return; // une touche modificatrice seule : on attend la suite
      if (!isAcceptableBinding(b)) {
        setMessage({ tone: "warning", text: t("shortcut.err_modifier") });
        return;
      }
      if (isReserved(b)) {
        setMessage({ tone: "warning", text: t("shortcut.err_reserved", { combo: formatBinding(canonical(b), mac) }) });
        return;
      }
      const conflict = conflictFor(bindings, canonical(b), capturing);
      if (conflict) {
        const def = SHORTCUTS.find((d) => d.id === conflict)!;
        setMessage({
          tone: "danger",
          text: t("shortcut.err_conflict", { combo: formatBinding(canonical(b), mac), action: t(def.labelKey) }),
        });
        return;
      }
      setBinding(capturing, canonical(b));
      setCapturing(null);
      setMessage(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      setShortcutCapture(false);
    };
  }, [capturing, bindings, mac, t]);

  return (
    <SectionCard id="shortcuts_list" titleKey="settings.sec.shortcuts_list" icon={<Keyboard size={15} />}>
      <p className="muted">{t("shortcut.intro")}</p>
      {message && (
        <Alert tone={message.tone} title={t("shortcut.err_title")}>
          {message.text}
        </Alert>
      )}
      <table className="ws-table shortcuts">
        <thead>
          <tr>
            <th>{t("shortcut.col_action")}</th>
            <th>{t("shortcut.col_keys")}</th>
            <th aria-label={t("workspace.actions")} />
          </tr>
        </thead>
        <tbody>
          {SHORTCUTS.map((d) => {
            const cur = bindings[d.id];
            const isCapturing = capturing === d.id;
            const changed = getOverrides()[d.id] !== undefined;
            return (
              <tr key={d.id}>
                <td>{t(d.labelKey)}</td>
                <td>
                  {isCapturing ? (
                    <span className="shortcuts__capture" role="status">
                      {t("shortcut.press_keys")}
                    </span>
                  ) : cur ? (
                    <kbd className="cmdk__kbd">{formatBinding(cur, mac)}</kbd>
                  ) : (
                    <span className="muted">{t("shortcut.none")}</span>
                  )}
                  {changed && !isCapturing && <span className="ws-chip">{t("shortcut.custom")}</span>}
                </td>
                <td className="ws-table__acts">
                  <Button
                    variant="outline"
                    size="sm"
                    aria-label={`${t("shortcut.change")} — ${t(d.labelKey)}`}
                    onClick={() => {
                      setMessage(null);
                      setCapturing(isCapturing ? null : d.id);
                    }}
                  >
                    {isCapturing ? t("common.cancel") : t("shortcut.change")}
                  </Button>
                  {cur && !isCapturing && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setBinding(d.id, "")}
                      title={t("shortcut.disable")}
                    >
                      {t("shortcut.disable")}
                    </Button>
                  )}
                  {changed && !isCapturing && (
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`${t("common.reset")} — ${t(d.labelKey)}`}
                      title={t("common.reset")}
                      onClick={() => resetBinding(d.id)}
                    >
                      <RotateCcw size={13} />
                    </Button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="settings__row">
        <Button variant="outline" size="sm" disabled={!customised} onClick={() => resetAllBindings()}>
          <RotateCcw size={14} /> {t("shortcut.reset_all")}
        </Button>
      </div>
      <p className="muted">{t("shortcut.editor_note")}</p>
    </SectionCard>
  );
}
