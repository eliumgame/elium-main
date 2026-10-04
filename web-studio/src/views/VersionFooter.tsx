/**
 * Pied de l'accueil : version installée + statut de mise à jour, et gestionnaire
 * de versions (revenir à une version antérieure / annuler la dernière mise à
 * jour). S'appuie sur les endpoints locaux du lanceur desktop
 * (/__version__, /__releases__, /__rollback__, /__update__) : dans le navigateur
 * ou en dev ils répondent 404, et le composant se replie sur le simple bandeau.
 */
import { useEffect, useRef, useState } from "react";
import { reportError } from "../ui/crash-log";

interface VersionInfo {
  installed: string | null;
  base?: string | null;
  latest: string | null;
  upToDate: boolean;
  /** Cause de l'échec de la dernière vérification (offline | rate-limited | invalid-signature | unknown-key | unavailable). */
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
  reason?: string | null;
  message?: string;
  channel?: "stable" | "beta";
}
interface PortInfo {
  current: number;
  configured: number | null;
  fallbackUsed: boolean;
  ports: { port: number; free: boolean }[];
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

/**
 * Après un redémarrage exe, l'ancien process meurt puis le nouveau reprend le
 * même port (généralement en moins d'une seconde) — mais React ne re-fetch
 * jamais /__version__ tout seul, donc sans ce sondage la page affichée reste
 * figée sur l'ancienne version alors que le nouvel exe tourne déjà (bug vu en
 * usage réel : le panneau affichait « installée : v4.4.14 » alors que la
 * mise à jour vers 4.5.0 avait déjà réussi). On sonde jusqu'à ce que le
 * nouveau serveur réponde, puis on recharge.
 */
function waitForServerThenReload(): void {
  let attempts = 0;
  const tryOnce = () => {
    attempts += 1;
    fetch("/__version__", { cache: "no-store" })
      .then((r) => (r.ok ? window.location.reload() : scheduleRetry()))
      .catch(scheduleRetry);
  };
  const scheduleRetry = () => {
    if (attempts < 40) setTimeout(tryOnce, 500);
    else window.location.reload();
  };
  setTimeout(tryOnce, 400);
}

const CHECK_FAILED_LABEL: Record<string, string> = {
  offline: "hors ligne, mise à jour non vérifiée",
  "rate-limited": "vérification suspendue (trop de requêtes)",
  "invalid-signature": "signature de mise à jour refusée",
  "unknown-key": "mise à jour signée par une clé inconnue",
  unavailable: "mise à jour non vérifiée",
};

export default function VersionFooter() {
  const [info, setInfo] = useState<VersionInfo | null>(null);
  const [open, setOpen] = useState(false);
  const [checking, setChecking] = useState(false);

  const load = () =>
    fetch("/__version__")
      .then((r) => (r.ok ? r.json() : null))
      .then((j: VersionInfo | null) => {
        if (j && j.installed) setInfo(j);
      })
      .catch((e) => reportError("version.info", e));

  useEffect(() => {
    void load();
  }, []);

  /** Vérification manuelle : ne jamais afficher « à jour » tant qu'elle n'a pas réellement abouti. */
  const checkNow = async () => {
    setChecking(true);
    await fetch("/__update__/check", { method: "POST", headers: { "X-Elium-Token": eliumToken() } }).catch(() => {});
    await load();
    setChecking(false);
  };

  return (
    <footer className="home__footer">
      <span>{TAGLINE}</span>
      {info?.installed && (
        <span className="home__version">
          {" · "}Elium v{info.installed}
          {info.channel === "beta" ? " (bêta)" : ""}{" "}
          {info.checkFailed ? (
            <span className="home__version-new" title={info.checkMessage || undefined}>
              · {CHECK_FAILED_LABEL[info.checkFailed] ?? CHECK_FAILED_LABEL.unavailable}
            </span>
          ) : info.upToDate ? (
            <span className="home__version-ok">· à jour</span>
          ) : (
            <span className="home__version-new">· mise à jour disponible{info.latest ? ` (v${info.latest})` : ""}</span>
          )}
          {" · "}
          <button type="button" className="home__version-manage" disabled={checking} onClick={() => void checkNow()}>
            {checking ? "Vérification…" : "Vérifier maintenant"}
          </button>
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
  const pollErrorLogged = useRef(false);

  useEffect(() => {
    fetch("/__releases__")
      .then((r) => (r.ok ? r.json() : { releases: [] }))
      .then((j: { releases?: Release[] }) => setReleases(j.releases ?? []))
      .catch((e) => {
        reportError("version.releases", e);
        setReleases([]);
      });
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
        .catch((e) => {
          // Une coupure passagère pendant le redémarrage est normale : on journalise une seule fois.
          if (!pollErrorLogged.current) {
            pollErrorLogged.current = true;
            reportError("version.poll", e);
          }
        });
    }, 1000);
    return () => clearInterval(id);
  }, [busy]);

  const rollback = async (version: string) => {
    setErr(null);
    setBusy(true);
    setStatus({ state: "downloading", version, progress: 0 });
    try {
      const r = await fetch(`/__rollback__?version=${encodeURIComponent(version)}`, {
        method: "POST",
        headers: { "X-Elium-Token": eliumToken() },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    } catch (e) {
      reportError("version.rollback", e);
      setBusy(false);
      setStatus(null);
      setErr("Impossible de lancer le retour à cette version. Réessayez ou redémarrez Elium.");
    }
  };
  const undo = async () => {
    setErr(null);
    setBusy(true);
    try {
      const r = await fetch("/__rollback__/undo", {
        method: "POST",
        headers: { "X-Elium-Token": eliumToken() },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    } catch (e) {
      reportError("version.undo", e);
      setBusy(false);
      setErr("Impossible d'annuler la dernière mise à jour. Réessayez ou redémarrez Elium.");
    }
  };
  const reload = () => window.location.reload();
  const restart = async () => {
    await fetch("/__update__/restart", {
      method: "POST",
      headers: { "X-Elium-Token": eliumToken() },
    }).catch(() => {
      // Attendu : le serveur se ferme pendant la réponse. waitForServerThenReload() prend le relais.
    });
    waitForServerThenReload();
  };

  const ready = status?.state === "web-ready" || status?.state === "exe-ready";
  const downloading = busy && status?.state === "downloading";
  // `installed` (props) vient du /__version__ chargé une seule fois par VersionFooter
  // au montage de la page : si une mise à jour exe a réussi entre-temps sans
  // rechargement de page, il peut être périmé. La liste des versions vient d'un
  // fetch frais à chaque ouverture du panneau — on la préfère quand elle est là,
  // pour ne jamais afficher un texte contredisant le badge « installée » ci-dessous.
  const displayedInstalled = releases?.find((r) => r.installed)?.version ?? installed;

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
          Version installée : <strong>v{displayedInstalled ?? "?"}</strong>. Vous pouvez revenir à une version publiée
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
                    {r.prerelease && <span className="badge vm__badge">préversion</span>}
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
            <UpdateSettings />
            <PortSettings />
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Canal de mise à jour (stable / bêta) et mise à jour depuis un fichier hors ligne
 * (`Elium-update-X.Y.Z.eliumupdate`). Le fichier est vérifié par le lanceur EXACTEMENT comme une
 * mise à jour en ligne (signature Ed25519 du manifeste + sha256 de chaque artefact) : on peut donc
 * l'obtenir par clé USB ou messagerie sans élargir la confiance.
 */
function UpdateSettings() {
  const [channel, setChannel] = useState<"stable" | "beta">("stable");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    fetch("/__update__")
      .then((r) => (r.ok ? r.json() : null))
      .then((s: UpdStatus | null) => {
        if (s?.channel) setChannel(s.channel);
      })
      .catch(() => {});
  }, []);

  const changeChannel = async (next: "stable" | "beta") => {
    setChannel(next);
    await fetch(`/__update__/channel?name=${next}`, {
      method: "POST",
      headers: { "X-Elium-Token": eliumToken() },
    }).catch(() => {});
    setMsg(
      next === "beta"
        ? "Canal bêta : les préversions seront proposées en plus des versions stables."
        : "Canal stable : seules les versions stables sont proposées.",
    );
  };

  const pickFile = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch("/__update__/bundle", {
        method: "POST",
        headers: { "X-Elium-Token": eliumToken() },
        body: file,
      });
      if (!r.ok) throw new Error(String(r.status));
      // Le lanceur vérifie/installe en tâche de fond : on suit son statut.
      for (let i = 0; i < 600; i++) {
        await new Promise((res) => setTimeout(res, 1000));
        const s: UpdStatus | null = await fetch("/__update__")
          .then((x) => (x.ok ? x.json() : null))
          .catch(() => null);
        if (!s) continue;
        if (s.state === "web-ready") {
          setMsg(`Version v${s.version} installée : rechargez l'application pour l'utiliser.`);
          break;
        }
        if (s.state === "exe-ready") {
          setMsg(`Version v${s.version} installée : redémarrez Elium pour terminer.`);
          break;
        }
        if (s.state === "error") {
          setMsg(s.message || "Ce fichier n'a pas pu être appliqué.");
          break;
        }
      }
    } catch {
      setMsg("Impossible d'envoyer ce fichier au lanceur local.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="vm__adv">
      <summary className="vm__adv-summary">Mises à jour : canal et fichier hors ligne</summary>
      <div className="vm__adv-body">
        <p className="vm__lede vm__adv-lede">
          <label>
            Canal de mise à jour{" "}
            <select value={channel} onChange={(e) => void changeChannel(e.target.value as "stable" | "beta")}>
              <option value="stable">Stable (recommandé)</option>
              <option value="beta">Bêta (préversions)</option>
            </select>
          </label>
        </p>
        <p className="vm__lede vm__adv-lede">
          Pas de connexion ? Choisissez un paquet <code>.eliumupdate</code> reçu par ailleurs : sa signature est
          vérifiée exactement comme celle d'une mise à jour en ligne.
        </p>
        <label className="eb eb--outline eb--sm">
          {busy ? "Vérification du paquet…" : "Mettre à jour depuis un fichier…"}
          <input
            type="file"
            accept=".eliumupdate"
            hidden
            disabled={busy}
            onChange={(e) => {
              void pickFile(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
        </label>
        {msg && <p className="vm__adv-notice">{msg}</p>}
      </div>
    </details>
  );
}

/**
 * Réglage avancé, replié par défaut : le serveur local d'Elium écoute sur un
 * port choisi automatiquement (3000-3100) — cette section permet de voir quels
 * ports sont libres et d'en épingler un précis (utile derrière un pare-feu
 * d'entreprise qui n'autorise qu'un port fixe, ou en cas de conflit récurrent
 * avec un autre outil local). Le changement ne prend effet qu'au prochain
 * démarrage (le serveur déjà lié ne peut pas migrer de port à chaud).
 */
function PortSettings() {
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState<PortInfo | null>(null);
  const [saving, setSaving] = useState<number | "auto" | null>(null);
  const [savedPort, setSavedPort] = useState<number | null | undefined>(undefined);
  const [portErr, setPortErr] = useState<string | null>(null);

  const load = () => {
    fetch("/__ports__")
      .then((r) => (r.ok ? r.json() : null))
      .then((j: PortInfo | null) => setInfo(j))
      .catch(() => setInfo(null));
  };

  useEffect(() => {
    if (open && !info) load();
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const choose = async (port: number | null) => {
    setPortErr(null);
    setSaving(port ?? "auto");
    try {
      const r = await fetch("/__ports__/set", {
        method: "POST",
        headers: { "X-Elium-Token": eliumToken(), "Content-Type": "application/json" },
        body: JSON.stringify({ port }),
      });
      const j = await r.json();
      if (j?.ok) {
        setSavedPort(j.port ?? null);
        load();
      } else {
        setPortErr("Ce port est déjà utilisé par un autre programme — choisissez-en un autre.");
      }
    } catch {
      setPortErr("Impossible d'enregistrer ce réglage pour le moment.");
    } finally {
      setSaving(null);
    }
  };

  const restartNow = async () => {
    await fetch("/__update__/restart", {
      method: "POST",
      headers: { "X-Elium-Token": eliumToken() },
    }).catch(() => {
      // Attendu : le serveur se ferme pendant la réponse (le redémarrage est confirmé par le rechargement).
    });
  };

  return (
    <details className="vm__adv" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary className="vm__adv-summary">Serveur local (avancé)</summary>
      <div className="vm__adv-body">
        {!info ? (
          <p className="vm__empty">Recherche des ports disponibles…</p>
        ) : (
          <>
            <p className="vm__lede vm__adv-lede">
              Elium sert son interface sur <strong>127.0.0.1:{info.current}</strong> (jamais accessible depuis le
              réseau). {info.fallbackUsed && "Le port que vous aviez choisi était occupé au démarrage : "}
              {info.configured == null
                ? "Choisi automatiquement à chaque lancement."
                : info.fallbackUsed
                  ? `un autre a été utilisé cette fois-ci (préférence ${info.configured} conservée).`
                  : `Épinglé sur ${info.configured}.`}
            </p>
            <div className="vm__ports">
              {info.ports.map(({ port, free }) => {
                const isChosen = info.configured === port;
                return (
                  <button
                    key={port}
                    type="button"
                    className={"vm__port" + (isChosen ? " is-chosen" : "") + (free ? "" : " is-busy")}
                    disabled={!free || saving !== null || isChosen}
                    title={free ? `Utiliser le port ${port}` : `${port} déjà utilisé par un autre programme`}
                    onClick={() => void choose(port)}
                  >
                    {port}
                    {isChosen && <span className="vm__port-tag">actuel</span>}
                  </button>
                );
              })}
            </div>
            <div className="vm__adv-actions">
              <button
                type="button"
                className="eb eb--ghost eb--sm"
                disabled={info.configured == null || saving !== null}
                onClick={() => void choose(null)}
              >
                Revenir à l'automatique
              </button>
            </div>
            {portErr && <p className="vm__err">{portErr}</p>}
            {savedPort !== undefined && (
              <p className="vm__adv-notice">
                Préférence enregistrée{savedPort ? ` (${savedPort})` : " (automatique)"} — effective au prochain
                démarrage.{" "}
                <button type="button" className="eb eb--primary eb--sm" onClick={() => void restartNow()}>
                  Redémarrer maintenant
                </button>
              </p>
            )}
          </>
        )}
      </div>
    </details>
  );
}
