/**
 * Pied de l'accueil : version installée + statut de mise à jour (y compris l'échec
 * de vérification : on n'affiche jamais « à jour » tant qu'elle n'a pas abouti),
 * vérification manuelle et accès au gestionnaire de versions (le même panneau que
 * Réglages → Mises à jour). Dans le navigateur ou en dev les endpoints du lanceur
 * répondent 404 et le composant se replie sur le simple bandeau.
 */
import { useEffect, useState } from "react";
import { useI18n, type MessageKey } from "../i18n";
import { reportError } from "../ui/crash-log";
import { eliumToken } from "../settings/launcher";
import UpdatesPanel from "../components/UpdatesPanel";
import { launcherJson } from "../desktop/launcher-bridge";

interface VersionInfo {
  installed: string | null;
  latest: string | null;
  upToDate: boolean;
  /** Cause de l'échec de la dernière vérification (offline | rate-limited | invalid-signature | unknown-key | unavailable). */
  checkFailed?: string | null;
  checkMessage?: string;
  channel?: "stable" | "beta" | null;
}

export const CHECK_FAILED_KEYS: Record<string, MessageKey> = {
  offline: "updates.check_failed.offline",
  "rate-limited": "updates.check_failed.rate_limited",
  "invalid-signature": "updates.check_failed.invalid_signature",
  "unknown-key": "updates.check_failed.unknown_key",
  unavailable: "updates.check_failed.unavailable",
};

export default function VersionFooter() {
  const { t } = useI18n();
  const [info, setInfo] = useState<VersionInfo | null>(null);
  const [open, setOpen] = useState(false);
  const [checking, setChecking] = useState(false);

  const load = () =>
    launcherJson<VersionInfo>("/__version__")
      .then((j) => {
        if (j && j.installed) setInfo(j);
      })
      .catch((e) => reportError("version.info", e));

  useEffect(() => {
    void load();
  }, []);

  /** Vérification manuelle. */
  const checkNow = async () => {
    setChecking(true);
    await fetch("/__update__/check", { method: "POST", headers: { "X-Elium-Token": eliumToken() } }).catch(
      () => undefined,
    );
    await load();
    setChecking(false);
  };

  return (
    <footer className="home__footer">
      <span>{t("footer.tagline")}</span>
      {info?.installed && (
        <span className="home__version">
          {" · "}Elium v{info.installed}
          {info.channel === "beta" ? ` (${t("updates.beta")})` : ""}{" "}
          {info.checkFailed ? (
            <span className="home__version-new" title={info.checkMessage || undefined}>
              · {t(CHECK_FAILED_KEYS[info.checkFailed] ?? "updates.check_failed.unavailable")}
            </span>
          ) : info.upToDate ? (
            <span className="home__version-ok">· {t("updates.up_to_date")}</span>
          ) : (
            <span className="home__version-new">
              · {t("updates.available")}
              {info.latest ? ` (v${info.latest})` : ""}
            </span>
          )}
          {" · "}
          <button type="button" className="home__version-manage" disabled={checking} onClick={() => void checkNow()}>
            {checking ? t("updates.checking") : t("updates.check_now")}
          </button>
          {" · "}
          <button type="button" className="home__version-manage" onClick={() => setOpen(true)}>
            {t("footer.manage_versions")}
          </button>
        </span>
      )}
      {open && (
        <div
          className="vm__overlay"
          role="dialog"
          aria-modal="true"
          aria-label={t("footer.versions_title")}
          onClick={() => setOpen(false)}
        >
          <div className="vm__panel" onClick={(e) => e.stopPropagation()}>
            <div className="vm__head">
              <h2 className="vm__title">{t("footer.versions_title")}</h2>
              <button type="button" className="vm__close" aria-label={t("common.close")} onClick={() => setOpen(false)}>
                ×
              </button>
            </div>
            <UpdatesPanel />
          </div>
        </div>
      )}
    </footer>
  );
}
