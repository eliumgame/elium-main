/**
 * Mises à jour et version : état (installée / dernière publiée), historique des
 * versions avec retour arrière, annulation de la dernière mise à jour, et port
 * du serveur local. S'appuie sur les routes du lanceur de bureau (/__version__,
 * /__releases__, /__rollback__, /__update__) ; hors lanceur elles répondent 404 et
 * le panneau explique que les mises à jour sont gérées par le navigateur.
 * Utilisé dans les Réglages et dans le gestionnaire de versions du pied de page.
 */
import { useEffect, useState } from "react";
import { Alert, Badge, Button } from "../ui/components";
import { useI18n } from "../i18n";
import { eliumToken, reloadWhenServerBack } from "../settings/launcher";
import { reportError } from "../ui/crash-log";
import { CHECK_FAILED_KEYS } from "../views/VersionFooter";
import PortSettings from "./PortSettings";
import { launcherJson } from "../desktop/launcher-bridge";

interface VersionInfo {
  installed: string | null;
  base?: string | null;
  latest: string | null;
  upToDate: boolean;
  checkFailed?: string | null;
  checkMessage?: string;
  channel?: "stable" | "beta" | null;
}
interface Release {
  version: string;
  date: string;
  name: string;
  prerelease?: boolean;
  installed: boolean;
  canRollback: boolean;
}
interface UpdStatus {
  state: string;
  version?: string | null;
  kind?: string | null;
  progress?: number;
  notes?: string;
}

const post = (url: string) => fetch(url, { method: "POST", headers: { "X-Elium-Token": eliumToken() } });

export default function UpdatesPanel({ withPort = true }: { withPort?: boolean } = {}) {
  const { t } = useI18n();
  const [info, setInfo] = useState<VersionInfo | null | undefined>(undefined);
  const [releases, setReleases] = useState<Release[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<UpdStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    launcherJson<VersionInfo>("/__version__", { cache: "no-store" })
      .then((j) => alive && setInfo(j && j.installed ? j : null))
      .catch(() => alive && setInfo(null));
    launcherJson<{ releases?: Release[] }>("/__releases__")
      .then((j) => alive && setReleases(j?.releases ?? []))
      .catch(() => alive && setReleases([]));
    return () => {
      alive = false;
    };
  }, []);

  // Suit la progression d'un retour arrière / d'une annulation en cours.
  useEffect(() => {
    if (!busy) return;
    const id = setInterval(() => {
      launcherJson<UpdStatus>("/__update__")
        .then((s) => {
          if (!s) return;
          setStatus(s);
          if (s.state === "web-ready" || s.state === "exe-ready") clearInterval(id);
          else if (s.state === "error") {
            clearInterval(id);
            setBusy(false);
            setErr(s.notes || t("updates.failed"));
          }
        })
        .catch(() => undefined);
    }, 1000);
    return () => clearInterval(id);
  }, [busy, t]);

  if (info === undefined) return <p className="muted">{t("common.loading")}</p>;
  if (info === null) {
    return (
      <Alert tone="info" title={t("updates.managed_title")}>
        {t("updates.managed_body")}
      </Alert>
    );
  }

  const run = async (url: string, failKey: "updates.rollback_failed" | "updates.undo_failed") => {
    try {
      const r = await post(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    } catch (e) {
      reportError("version.operation", e);
      setBusy(false);
      setStatus(null);
      setErr(t(failKey));
    }
  };
  const rollback = async (version: string) => {
    setErr(null);
    setBusy(true);
    setStatus({ state: "downloading", version, progress: 0 });
    await run(`/__rollback__?version=${encodeURIComponent(version)}`, "updates.rollback_failed");
  };
  const undo = async () => {
    setErr(null);
    setBusy(true);
    await run("/__rollback__/undo", "updates.undo_failed");
  };
  const restart = async () => {
    await post("/__update__/restart").catch(() => undefined);
    reloadWhenServerBack();
  };

  const ready = status?.state === "web-ready" || status?.state === "exe-ready";
  const downloading = busy && status?.state === "downloading";
  // La liste vient d'un fetch frais : on la préfère à /__version__ (chargé une fois) pour ne jamais contredire le badge « installée ».
  const installed = releases?.find((r) => r.installed)?.version ?? info.installed;

  return (
    <div className="updates">
      <dl className="updates__facts">
        <div>
          <dt>{t("updates.installed")}</dt>
          <dd>v{installed ?? "?"}</dd>
        </div>
        <div>
          <dt>{t("updates.latest")}</dt>
          <dd>{info.latest ? `v${info.latest}` : "—"}</dd>
        </div>
        <div>
          <dt>{t("updates.status")}</dt>
          <dd>
            {info.checkFailed ? (
              <Badge accent="warning">
                {t(CHECK_FAILED_KEYS[info.checkFailed] ?? "updates.check_failed.unavailable")}
              </Badge>
            ) : info.upToDate ? (
              <Badge accent="success">{t("updates.up_to_date")}</Badge>
            ) : (
              <Badge accent="warning">{t("updates.available")}</Badge>
            )}
          </dd>
        </div>
        <div>
          <dt>{t("updates.channel")}</dt>
          <dd>{info.channel === "beta" ? t("updates.channel_beta") : t("updates.channel_stable")}</dd>
        </div>
      </dl>
      <p className="muted">{t("updates.signed_note")}</p>

      {err && (
        <Alert tone="danger" title={t("updates.error_title")}>
          {err}
        </Alert>
      )}

      {ready ? (
        <Alert tone="success" title={t("updates.ready", { version: status?.version ?? "" })}>
          {status?.state === "exe-ready" ? (
            <Button size="sm" onClick={() => void restart()}>
              {t("updates.restart")}
            </Button>
          ) : (
            <Button size="sm" onClick={() => window.location.reload()}>
              {t("updates.reload")}
            </Button>
          )}
        </Alert>
      ) : downloading ? (
        <p role="status">
          {t("updates.applying", { version: status?.version ?? "", progress: status?.progress ?? 0 })}
        </p>
      ) : (
        <>
          <h4 className="settings__subtitle">{t("updates.history")}</h4>
          <p className="muted">{t("updates.history_hint")}</p>
          <div className="settings__row">
            <Button variant="outline" size="sm" onClick={() => void undo()} disabled={busy}>
              {t("updates.undo_last")}
            </Button>
          </div>
          <ul className="vm__list">
            {releases === null && <li className="vm__empty">{t("common.loading")}</li>}
            {releases?.length === 0 && <li className="vm__empty">{t("updates.none")}</li>}
            {releases?.map((r) => (
              <li key={r.version} className="vm__item">
                <span className="vm__ver">
                  v{r.version}
                  {r.installed && (
                    <span className="badge badge--success vm__badge">{t("updates.installed_badge")}</span>
                  )}
                  {r.prerelease && <span className="badge vm__badge">{t("updates.prerelease")}</span>}
                </span>
                <span className="vm__date">{r.date}</span>
                {r.installed ? (
                  <span className="vm__note">{t("updates.current")}</span>
                ) : r.canRollback ? (
                  <Button variant="ghost" size="sm" onClick={() => void rollback(r.version)} disabled={busy}>
                    {t("updates.use_version")}
                  </Button>
                ) : (
                  <span className="vm__note" title={t("updates.reinstall_hint")}>
                    {t("updates.reinstall")}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      {withPort && (
        <>
          <h4 className="settings__subtitle">{t("port.title")}</h4>
          <PortSettings />
        </>
      )}
    </div>
  );
}
