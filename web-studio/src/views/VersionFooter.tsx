/**
 * Pied de l'accueil : version installée + statut de mise à jour, et accès au
 * gestionnaire de versions (le même panneau que Réglages → Mises à jour).
 * S'appuie sur les endpoints locaux du lanceur desktop ; dans le navigateur ou
 * en dev ils répondent 404 et le composant se replie sur le simple bandeau.
 */
import { useEffect, useState } from "react";
import { useI18n } from "../i18n";
import UpdatesPanel from "../components/UpdatesPanel";

interface VersionInfo {
  installed: string | null;
  latest: string | null;
  upToDate: boolean;
}

export default function VersionFooter() {
  const { t } = useI18n();
  const [info, setInfo] = useState<VersionInfo | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch("/__version__")
      .then((r) => (r.ok ? r.json() : null))
      .then((j: VersionInfo | null) => {
        if (alive && j && j.installed) setInfo(j);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  return (
    <footer className="home__footer">
      <span>{t("footer.tagline")}</span>
      {info?.installed && (
        <span className="home__version">
          {" · "}Elium v{info.installed}{" "}
          {info.upToDate ? (
            <span className="home__version-ok">· {t("updates.up_to_date")}</span>
          ) : (
            <span className="home__version-new">
              · {t("updates.available")}
              {info.latest ? ` (v${info.latest})` : ""}
            </span>
          )}
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
