/**
 * Pied de l'accueil : version installée + statut de mise à jour, et gestionnaire
 * de versions (revenir à une version antérieure / annuler la dernière mise à
 * jour). S'appuie sur les endpoints locaux du lanceur desktop
 * (/__version__, /__releases__, /__rollback__, /__update__) : dans le navigateur
 * ou en dev ils répondent 404, et le composant se replie sur le simple bandeau.
 */
import { useEffect, useState } from "react";

interface VersionInfo {
  installed: string | null;
  base?: string | null;
  latest: string | null;
  upToDate: boolean;
}
interface Release {
  version: string;
  date: string;
  name: string;
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

const TAGLINE =
  "Traitement 100 % local · aucune donnée envoyée en ligne sans action explicite · conforme RGPD par conception";

/**
 * Jeton anti-CSRF du lanceur desktop (installer/elium_launcher.py) : injecté par
 * le serveur local dans une balise <meta name="elium-token"> du document servi
 * (jamais un script inline, la CSP stricte l'interdit), relu ici à chaque appel.
 * Absent en dehors du lanceur (navigateur/dev) : les routes ciblées répondent
 * alors 404 de toute façon, cf. le commentaire d'en-tête du fichier.
 */
function eliumToken(): string {
  const meta = document.querySelector('meta[name="elium-token"]');
  return meta?.getAttribute("content") ?? "";
}

export default function VersionFooter() {
  const [info, setInfo] = useState<VersionInfo | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch("/__version__")
      .then((r) => (r.ok ? r.json() : null))
      .then((j: VersionInfo | null) => {
        if (alive && j && j.installed) setInfo(j);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  return (
    <footer className="home__footer">
      <span>{TAGLINE}</span>
      {info?.installed && (
        <span className="home__version">
          {" · "}Elium v{info.installed}{" "}
          {info.upToDate ? (
            <span className="home__version-ok">· à jour</span>
          ) : (
            <span className="home__version-new">· mise à jour disponible{info.latest ? ` (v${info.latest})` : ""}</span>
          )}
          {" · "}
          <button type="button" className="home__version-manage" onClick={() => setOpen(true)}>
            Gérer les versions
          </button>
        </span>
      )}
      {open && <VersionManager onClose={() => setOpen(false)} installed={info?.installed ?? null} />}
    </footer>
  );
}

function VersionManager({ onClose, installed }: { onClose: () => void; installed: string | null }) {
  const [releases, setReleases] = useState<Release[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<UpdStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch("/__releases__")
      .then((r) => (r.ok ? r.json() : { releases: [] }))
      .then((j: { releases?: Release[] }) => setReleases(j.releases ?? []))
      .catch(() => setReleases([]));
  }, []);

  // Suit la progression d'un rollback/undo en cours.
  useEffect(() => {
    if (!busy) return;
    const id = setInterval(() => {
      fetch("/__update__")
        .then((r) => (r.ok ? r.json() : null))
        .then((s: UpdStatus | null) => {
          if (!s) return;
          setStatus(s);
          if (s.state === "web-ready" || s.state === "exe-ready") {
            clearInterval(id);
          } else if (s.state === "error") {
            clearInterval(id);
            setBusy(false);
            setErr(s.notes || "L'opération a échoué.");
          }
        })
        .catch(() => {});
    }, 1000);
    return () => clearInterval(id);
  }, [busy]);

  const rollback = async (version: string) => {
    setErr(null);
    setBusy(true);
    setStatus({ state: "downloading", version, progress: 0 });
    await fetch(`/__rollback__?version=${encodeURIComponent(version)}`, {
      method: "POST",
      headers: { "X-Elium-Token": eliumToken() },
    }).catch(() => {});
  };
  const undo = async () => {
    setErr(null);
    setBusy(true);
    await fetch("/__rollback__/undo", {
      method: "POST",
      headers: { "X-Elium-Token": eliumToken() },
    }).catch(() => {});
  };
  const reload = () => window.location.reload();
  const restart = async () => {
    await fetch("/__update__/restart", {
      method: "POST",
      headers: { "X-Elium-Token": eliumToken() },
    }).catch(() => {});
  };

  const ready = status?.state === "web-ready" || status?.state === "exe-ready";
  const downloading = busy && status?.state === "downloading";

  return (
    <div className="vm__overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="vm__panel" onClick={(e) => e.stopPropagation()}>
        <div className="vm__head">
          <h2 className="vm__title">Versions d'Elium</h2>
          <button type="button" className="vm__close" aria-label="Fermer" onClick={onClose}>
            ×
          </button>
        </div>
        <p className="vm__lede">
          Version installée : <strong>v{installed ?? "?"}</strong>. Vous pouvez revenir à une version publiée
          antérieure, ou annuler la dernière mise à jour pour revenir à la version d'origine.
        </p>

        {err && <p className="vm__err">{err}</p>}

        {ready ? (
          <div className="vm__ready">
            <p>
              Version <strong>v{status?.version}</strong> prête.
            </p>
            {status?.state === "exe-ready" ? (
              <button className="eb eb--primary eb--sm" onClick={() => void restart()}>
                Redémarrer Elium
              </button>
            ) : (
              <button className="eb eb--primary eb--sm" onClick={reload}>
                Recharger
              </button>
            )}
          </div>
        ) : downloading ? (
          <p className="vm__progress">
            Application de la version v{status?.version}… {status?.progress ?? 0} %
          </p>
        ) : (
          <>
            <div className="vm__actions">
              <button className="eb eb--outline eb--sm" onClick={() => void undo()} disabled={busy}>
                Annuler la dernière mise à jour (revenir à l'origine)
              </button>
            </div>
            <ul className="vm__list">
              {releases === null && <li className="vm__empty">Chargement…</li>}
              {releases?.length === 0 && <li className="vm__empty">Aucune version publiée trouvée.</li>}
              {releases?.map((r) => (
                <li key={r.version} className="vm__item">
                  <span className="vm__ver">
                    v{r.version}
                    {r.installed && <span className="badge badge--success vm__badge">installée</span>}
                  </span>
                  <span className="vm__date">{r.date}</span>
                  {r.installed ? (
                    <span className="vm__note">actuelle</span>
                  ) : r.canRollback ? (
                    <button className="eb eb--ghost eb--sm" onClick={() => void rollback(r.version)} disabled={busy}>
                      Utiliser cette version
                    </button>
                  ) : (
                    <span
                      className="vm__note"
                      title="Antérieure à la version installée d'origine : réinstallez le programme d'installation (MSI)."
                    >
                      via réinstallation
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
