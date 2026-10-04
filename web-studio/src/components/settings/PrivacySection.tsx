/**
 * Confidentialité et données : tout reste sur l'appareil ; effacement des
 * données locales ; journal d'incidents local (voir / copier / vider).
 */
import { useState } from "react";
import { Copy, ShieldCheck, Trash2 } from "lucide-react";
import { Alert, Button } from "../../ui/components";
import { useDialogs } from "../../ui/dialogs";
import { clearCrashLog, formatCrashLog, getCrashLog } from "../../ui/crash-log";
import { fmt, useI18n } from "../../i18n";
import { SectionCard } from "./parts";

export function ClearDataSection({ onClearStorage }: { onClearStorage: () => void }) {
  const { t } = useI18n();
  const { confirm } = useDialogs();
  return (
    <SectionCard id="priv_clear" titleKey="settings.sec.priv_clear" icon={<ShieldCheck size={15} />}>
      <Alert tone="warning" title={t("settings.priv_storage_title")}>
        {t("settings.priv_storage_body")}
      </Alert>
      <div className="settings__row" style={{ marginTop: 8 }}>
        <Button
          variant="danger"
          size="sm"
          onClick={async () => {
            if (
              await confirm({
                title: t("settings.priv_clear_title"),
                message: t("settings.priv_clear_body"),
                danger: true,
                confirmLabel: t("settings.priv_clear_confirm"),
              })
            ) {
              onClearStorage();
            }
          }}
        >
          <Trash2 size={15} /> {t("settings.priv_clear_button")}
        </Button>
      </div>
    </SectionCard>
  );
}

export function CrashLogSection({ onCopied }: { onCopied: (message: string) => void }) {
  const { t, tn } = useI18n();
  const { confirm, alert } = useDialogs();
  const [entries, setEntries] = useState(() => getCrashLog());
  const [open, setOpen] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(formatCrashLog());
      onCopied(t("settings.log_copied"));
    } catch {
      await alert({ title: t("settings.log_copy_failed"), message: formatCrashLog().slice(0, 4000) });
    }
  };

  return (
    <SectionCard id="priv_log" titleKey="settings.sec.priv_log">
      <p className="muted">{t("settings.log_body")}</p>
      <p>{tn("settings.log_count", entries.length)}</p>
      <div className="settings__row">
        <Button
          variant="outline"
          size="sm"
          disabled={entries.length === 0}
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          {open ? t("settings.log_hide") : t("settings.log_show")}
        </Button>
        <Button variant="outline" size="sm" onClick={() => void copy()}>
          <Copy size={14} /> {t("settings.log_copy")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={entries.length === 0}
          onClick={async () => {
            if (
              await confirm({
                title: t("settings.log_clear_title"),
                message: t("settings.log_clear_body"),
                confirmLabel: t("settings.log_clear"),
              })
            ) {
              clearCrashLog();
              setEntries([]);
              setOpen(false);
            }
          }}
        >
          <Trash2 size={14} /> {t("settings.log_clear")}
        </Button>
      </div>
      {open && (
        <ol className="crashlog">
          {[...entries].reverse().map((e, i) => (
            <li key={`${e.at}-${i}`}>
              <div>
                <strong>{e.source}</strong> · <time dateTime={e.at}>{fmt.dateTime(e.at)}</time>
              </div>
              <div>{e.message}</div>
              {e.stack && (
                <details>
                  <summary>{t("settings.log_stack")}</summary>
                  <pre>{e.stack}</pre>
                </details>
              )}
            </li>
          ))}
        </ol>
      )}
    </SectionCard>
  );
}
