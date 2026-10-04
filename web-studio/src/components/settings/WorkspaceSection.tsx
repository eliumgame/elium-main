/**
 * Espace de travail (Réglages) : sauvegarde et restauration d'un fichier
 * .elium-workspace, rappel de sauvegarde, corbeille et index de recherche.
 */
import { useRef, useState } from "react";
import { Archive, DatabaseBackup, Loader2, RefreshCw, Trash2, Upload } from "lucide-react";
import { Alert, Button, Modal } from "../../ui/components";
import { useDialogs } from "../../ui/dialogs";
import { reportError } from "../../ui/crash-log";
import { downloadBlob } from "../../export/exporters";
import { fmt, tn as tnGlobal, useI18n } from "../../i18n";
import { setPrefs, usePrefs } from "../../settings/prefs";
import type { VaultSecret } from "../../crypto/local-vault";
import { createContentIO, duplicateEliumBytes } from "../../workspace/content";
import {
  backupFileName,
  planBackupRestore,
  type BackupManifest,
  type BackupSnapshot,
  type ConflictChoice,
} from "../../workspace/backup";
import {
  BackupPasswordRequired,
  BackupPasswordWrong,
  VaultLockedError,
  collectSnapshot,
  openBackup,
  packBackup,
  restoreSnapshot,
  type BackupDeps,
  type RestoreReport,
} from "../../workspace/backup-io";
import { fsAccessSupported, writeToHandle } from "../../workspace/fs-access";
import type { WorkspaceApi } from "../../workspace/useWorkspace";
import type { IndexProgress } from "../../workspace/search/indexer";
import { SectionCard } from "./parts";

export interface WorkspaceSettingsBridge {
  ws: WorkspaceApi;
  getSecret: () => VaultSecret | undefined;
  vaultActive: boolean;
  appVersion?: string;
  notify: (message: string) => void;
  /** Des réglages ont été restaurés : proposer de recharger. */
  onSettingsRestored: () => void;
  rebuildIndex: () => void;
  indexProgress: IndexProgress;
  indexedCount: number;
}

function makeDeps(b: WorkspaceSettingsBridge): BackupDeps {
  return {
    catalog: b.ws.catalog,
    contents: createContentIO(b.getSecret),
    getSecret: b.getSecret,
    storage: {
      get: (k) => {
        try {
          return localStorage.getItem(k);
        } catch {
          return null;
        }
      },
      set: (k, v) => localStorage.setItem(k, v),
    },
    appVersion: b.appVersion,
    rewriteDoc: duplicateEliumBytes,
  };
}

const BACKUP_TYPE = {
  description: "Sauvegarde d'espace de travail Elium",
  accept: { "application/x-elium-workspace": [".elium-workspace"] },
};

export function BackupSection({ bridge }: { bridge: WorkspaceSettingsBridge }) {
  const { t } = useI18n();
  const { confirm, alert } = useDialogs();
  const prefs = usePrefs();
  const [includeSecrets, setIncludeSecrets] = useState(false);
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [busy, setBusy] = useState(false);

  const mismatch = password !== "" && password !== password2;

  const exportNow = async () => {
    if (mismatch) return;
    if (!password && bridge.vaultActive) {
      const ok = await confirm({
        title: t("backup.clear_title"),
        message: t("backup.clear_body"),
        confirmLabel: t("backup.clear_confirm"),
        danger: true,
      });
      if (!ok) return;
    }
    if (includeSecrets && !password) {
      const ok = await confirm({
        title: t("backup.secrets_title"),
        message: t("backup.secrets_body"),
        confirmLabel: t("backup.secrets_confirm"),
        danger: true,
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      const snap = await collectSnapshot(makeDeps(bridge), { includeSecrets });
      const bytes = await packBackup(snap, { includeSecrets, password: password || undefined });
      const name = backupFileName(new Date());
      let saved = false;
      if (fsAccessSupported()) {
        const w = window as unknown as {
          showSaveFilePicker?: (o: unknown) => Promise<import("../../workspace/fs-access").FsFileHandle>;
        };
        try {
          const handle = await w.showSaveFilePicker!({ suggestedName: name, types: [BACKUP_TYPE] });
          await writeToHandle(handle, bytes, "application/x-elium-workspace");
          saved = true;
        } catch (e) {
          if (!(e instanceof DOMException && e.name === "AbortError")) throw e;
          return; // annulé : rien n'est enregistré, le rappel n'est pas remis à zéro
        }
      }
      if (!saved) downloadBlob(name, "application/x-elium-workspace", bytes);
      setPrefs({ lastBackupAt: new Date().toISOString(), backupSnoozedUntil: "" });
      bridge.notify(t("backup.exported", { name }));
    } catch (e) {
      reportError("workspace-backup", e);
      await alert({
        title: t("backup.export_error"),
        message: e instanceof VaultLockedError ? e.message : e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <SectionCard id="ws_backup" titleKey="settings.sec.ws_backup" icon={<Archive size={15} />}>
      <p className="muted">{t("backup.intro")}</p>
      <ul className="muted backup__list">
        <li>{t("backup.includes_1")}</li>
        <li>{t("backup.includes_2")}</li>
        <li>{t("backup.excludes")}</li>
      </ul>
      <label className="ws-check">
        <input type="checkbox" checked={includeSecrets} onChange={(e) => setIncludeSecrets(e.target.checked)} />{" "}
        {t("backup.include_secrets")}
      </label>
      <p className="field__hint">{t("backup.include_secrets_hint")}</p>
      <label className="field">
        <span className="field__label">{t("backup.password")}</span>
        <input
          className="settings__input"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <span className="field__hint">{t("backup.password_hint")}</span>
      </label>
      {password !== "" && (
        <label className="field">
          <span className="field__label">{t("backup.password_confirm")}</span>
          <input
            className="settings__input"
            type="password"
            autoComplete="new-password"
            value={password2}
            onChange={(e) => setPassword2(e.target.value)}
            aria-invalid={mismatch}
          />
          {mismatch && <span className="field__hint port__invalid">{t("backup.password_mismatch")}</span>}
        </label>
      )}
      <div className="settings__row">
        <Button size="sm" disabled={busy || mismatch || !bridge.ws.ready} onClick={() => void exportNow()}>
          {busy ? <Loader2 size={14} className="icon-spin" /> : <DatabaseBackup size={14} />} {t("backup.export_now")}
        </Button>
      </div>
      <p className="muted">
        {prefs.lastBackupAt ? t("backup.last", { date: fmt.dateTime(prefs.lastBackupAt) }) : t("backup.never")}
      </p>
      <label className="field">
        <span className="field__label">{t("backup.reminder")}</span>
        <select
          className="settings__select"
          value={prefs.backupReminderDays}
          onChange={(e) => setPrefs({ backupReminderDays: Number(e.target.value) })}
        >
          <option value={0}>{t("backup.reminder_off")}</option>
          {[7, 14, 30].map((d) => (
            <option key={d} value={d}>
              {tnGlobal("backup.reminder_every", d)}
            </option>
          ))}
        </select>
      </label>
    </SectionCard>
  );
}

export function RestoreSection({ bridge }: { bridge: WorkspaceSettingsBridge }) {
  const { t } = useI18n();
  const { prompt, alert } = useDialogs();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{ manifest: BackupManifest; snapshot: BackupSnapshot } | null>(null);

  const onFile = async (file: File) => {
    setBusy(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let password: string | undefined;
      for (;;) {
        try {
          setPending(await openBackup(bytes, password));
          return;
        } catch (e) {
          if (e instanceof BackupPasswordRequired || e instanceof BackupPasswordWrong) {
            const p = await prompt({
              title: t("backup.restore_password_title"),
              label: t("backup.password"),
              password: true,
              hint: e instanceof BackupPasswordWrong ? e.message : undefined,
            });
            if (p === null) return;
            password = p;
          } else throw e;
        }
      }
    } catch (e) {
      reportError("workspace-restore-open", e);
      await alert({ title: t("backup.restore_error"), message: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  return (
    <SectionCard id="ws_restore" titleKey="settings.sec.ws_restore" icon={<Upload size={15} />}>
      <p className="muted">{t("backup.restore_intro")}</p>
      <div className="settings__row">
        <Button
          variant="outline"
          size="sm"
          disabled={busy || !bridge.ws.ready}
          onClick={() => inputRef.current?.click()}
        >
          {busy ? <Loader2 size={14} className="icon-spin" /> : <Upload size={14} />} {t("backup.restore_choose")}
        </Button>
        <input
          ref={inputRef}
          type="file"
          accept=".elium-workspace"
          hidden
          onChange={(e) => e.target.files?.[0] && void onFile(e.target.files[0])}
        />
      </div>
      {pending && <RestoreDialog bridge={bridge} backup={pending} onClose={() => setPending(null)} />}
    </SectionCard>
  );
}

function RestoreDialog({
  bridge,
  backup,
  onClose,
}: {
  bridge: WorkspaceSettingsBridge;
  backup: { manifest: BackupManifest; snapshot: BackupSnapshot };
  onClose: () => void;
}) {
  const { t, tn } = useI18n();
  const { alert } = useDialogs();
  const [choice, setChoice] = useState<ConflictChoice>("keep_both");
  const [applySettings, setApplySettings] = useState(true);
  const [applySecrets, setApplySecrets] = useState(false);
  const [busy, setBusy] = useState(false);
  const { snapshot, manifest } = backup;
  const local = bridge.ws;
  const plan = planBackupRestore(local.items, local.folders, snapshot, choice);
  const hasSettings = Object.keys(snapshot.settings).length > 0;
  const hasSecrets = Object.keys(snapshot.secrets).length > 0;

  const run = async () => {
    setBusy(true);
    try {
      const report: RestoreReport = await restoreSnapshot(makeDeps(bridge), snapshot, plan, {
        applySettings: applySettings && hasSettings,
        applySecrets: applySecrets && hasSecrets,
      });
      await local.refresh();
      const lines = [
        tn("backup.report_added", report.added),
        tn("backup.report_replaced", report.replaced),
        tn("backup.report_copied", report.copied),
        tn("backup.report_skipped", report.skipped),
        ...report.errors.map((e) => `⚠ ${e.title} — ${e.message}`),
      ];
      onClose();
      await alert({
        title: report.errors.length ? t("backup.restore_done_errors") : t("backup.restore_done"),
        message: lines.join("\n"),
      });
      if (report.settingsApplied || report.secretsApplied) bridge.onSettingsRestored();
    } catch (e) {
      reportError("workspace-restore", e);
      await alert({ title: t("backup.restore_error"), message: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={t("backup.restore_title")}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button disabled={busy} onClick={() => void run()}>
            {busy ? <Loader2 size={14} className="icon-spin" /> : null} {t("backup.restore_apply")}
          </Button>
        </>
      }
    >
      <p>
        {manifest.createdAt
          ? t("backup.restore_from", { date: fmt.dateTime(manifest.createdAt) })
          : t("backup.restore_from_unknown")}
        {manifest.appVersion ? ` · Elium v${manifest.appVersion}` : ""}
      </p>
      <p>
        {tn("backup.restore_items", manifest.counts.items, { folders: manifest.counts.folders })}
        {manifest.counts.trashed > 0 && ` · ${tn("backup.restore_trashed", manifest.counts.trashed)}`}
      </p>
      <p className="muted">
        {tn("backup.restore_new", plan.counts.add)} · {tn("backup.restore_conflicts", plan.counts.conflicts)}
      </p>
      {plan.counts.conflicts > 0 && (
        <fieldset className="backup__choices">
          <legend>{t("backup.conflict_legend")}</legend>
          {(
            [
              ["keep_both", "backup.conflict_keep_both"],
              ["replace", "backup.conflict_replace"],
              ["skip", "backup.conflict_skip"],
            ] as const
          ).map(([v, key]) => (
            <label key={v} className="ws-check">
              <input type="radio" name="conflict" checked={choice === v} onChange={() => setChoice(v)} /> {t(key)}
            </label>
          ))}
        </fieldset>
      )}
      {hasSettings && (
        <label className="ws-check">
          <input type="checkbox" checked={applySettings} onChange={(e) => setApplySettings(e.target.checked)} />{" "}
          {t("backup.apply_settings")}
        </label>
      )}
      {hasSecrets && (
        <>
          <label className="ws-check">
            <input type="checkbox" checked={applySecrets} onChange={(e) => setApplySecrets(e.target.checked)} />{" "}
            {t("backup.apply_secrets")}
          </label>
          {applySecrets && <Alert tone="warning">{t("backup.apply_secrets_warn")}</Alert>}
        </>
      )}
    </Modal>
  );
}

export function TrashSettingsSection({ bridge }: { bridge: WorkspaceSettingsBridge }) {
  const { t, tn } = useI18n();
  const { confirm } = useDialogs();
  const count = bridge.ws.items.filter((i) => i.trashedAt).length + bridge.ws.folders.filter((f) => f.trashedAt).length;
  return (
    <SectionCard id="ws_trash" titleKey="settings.sec.ws_trash" icon={<Trash2 size={15} />}>
      <p className="muted">{tn("workspace.trash.retention", 30)}</p>
      <p>{tn("settings.trash_count", count)}</p>
      <div className="settings__row">
        <Button
          variant="danger"
          size="sm"
          disabled={count === 0}
          onClick={async () => {
            if (
              await confirm({
                title: t("workspace.trash.confirm_empty_title"),
                message: t("workspace.trash.confirm_empty_body"),
                danger: true,
                confirmLabel: t("workspace.trash.empty_action"),
              })
            ) {
              await bridge.ws.run("trash-empty", (s) => s.emptyTrash());
              bridge.notify(t("workspace.trash.emptied"));
            }
          }}
        >
          <Trash2 size={14} /> {t("workspace.trash.empty_action")}
        </Button>
      </div>
    </SectionCard>
  );
}

export function IndexSection({ bridge }: { bridge: WorkspaceSettingsBridge }) {
  const { t, tn } = useI18n();
  const p = bridge.indexProgress;
  return (
    <SectionCard id="ws_index" titleKey="settings.sec.ws_index" icon={<RefreshCw size={15} />}>
      <p className="muted">{t("settings.index_body")}</p>
      <p role="status">
        {p.running
          ? t("search.indexing", { done: p.done, total: p.total })
          : tn("settings.index_count", bridge.indexedCount)}
      </p>
      <div className="settings__row">
        <Button variant="outline" size="sm" disabled={p.running} onClick={bridge.rebuildIndex}>
          <RefreshCw size={14} /> {t("settings.index_rebuild")}
        </Button>
      </div>
    </SectionCard>
  );
}
