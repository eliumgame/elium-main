/**
 * Accueil du site hébergé : version PRÉCISE d'Elium servie par ce serveur, ce que contient la mise à
 * jour, et installation de l'application Windows (MSI). N'apparaît que hors application de bureau
 * (qui affiche déjà sa version via le lanceur : voir VersionFooter).
 */
import { useEffect, useState } from "react";
import { Download, MonitorDown, Sparkles } from "lucide-react";
import { launcherJson } from "../desktop/launcher-bridge";
import {
  BUNDLED_VERSION,
  compareVersions,
  fetchWebRelease,
  formatSize,
  pickInstallers,
  type WebReleaseInfo,
} from "../desktop/web-release";
import "./WebVersionCard.css";

const fmtDate = (iso?: string) =>
  iso ? new Date(iso).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" }) : "";

export default function WebVersionCard() {
  const [info, setInfo] = useState<WebReleaseInfo | null>(null);
  const [desktop, setDesktop] = useState<boolean | null>(null);

  useEffect(() => {
    let off = false;
    // Dans l'application de bureau, le lanceur répond sur /__version__ : le pied de page suffit.
    void launcherJson<{ installed?: string }>("/__version__")
      .then((j) => !off && setDesktop(!!j?.installed))
      .catch(() => !off && setDesktop(false));
    void fetchWebRelease().then((r) => !off && setInfo(r));
    return () => {
      off = true;
    };
  }, []);

  if (desktop !== false) return null;
  const version = info?.version || BUNDLED_VERSION;
  if (!version) return null;
  const installers = pickInstallers(info?.latest);
  const latest = info?.latest;
  const published = latest ? latest.tag.replace(/^v/i, "") : "";
  const ahead = latest ? compareVersions(version, published) > 0 : false;

  return (
    <section className="home__section web-version" aria-labelledby="web-version-title">
      <div className="web-version__head">
        <Sparkles size={20} aria-hidden="true" />
        <h2 id="web-version-title" className="home__section-title">
          Elium v{version}
        </h2>
        {info?.buildId && (
          <span className="web-version__build" title="Empreinte du bundle servi">
            build {info.buildId}
          </span>
        )}
      </div>
      <p className="web-version__meta">
        Version servie par ce serveur{info?.builtAt ? `, compilée le ${fmtDate(info.builtAt)}` : ""}.
        {latest && (
          <>
            {" "}
            Dernière version Windows publiée : <b>v{published}</b> ({fmtDate(latest.publishedAt)})
            {ahead
              ? " — le site est en avance sur l'application Windows : ses nouveautés arriveront avec la prochaine publication."
              : "."}
          </>
        )}
      </p>

      {info && info.notes.length > 0 && (
        <details className="web-version__notes" open>
          <summary>{info.heading || `Nouveautés de la version ${version}`}</summary>
          <ul>
            {info.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </details>
      )}

      <div className="web-version__install">
        <h3>
          <MonitorDown size={16} aria-hidden="true" /> Installer l'application Windows
        </h3>
        {installers.length > 0 ? (
          <ul className="web-version__list">
            {installers.map((i) => (
              <li key={i.kind}>
                <a className="web-version__btn" href={i.url} download rel="noopener noreferrer">
                  <Download size={15} aria-hidden="true" /> {i.label}
                </a>
                <span className="web-version__hint">
                  {i.hint} · {formatSize(i.size)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="web-version__hint">
            Les installeurs sont sur{" "}
            <a href="https://github.com/eliumgame/elium-main/releases/latest" rel="noopener noreferrer">
              la page des publications
            </a>
            .
          </p>
        )}
        <p className="web-version__hint">
          Les installeurs sont signés par la chaîne de publication d'Elium ; l'application installée se met ensuite à
          jour toute seule. Windows peut afficher un avertissement SmartScreen : le programme n'a pas de certificat de
          signature de code payant.
        </p>
      </div>
    </section>
  );
}
