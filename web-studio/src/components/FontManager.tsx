import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Trash2, Upload, MonitorSmartphone, Type, Globe, Download, Loader2 } from "lucide-react";
import { Modal, Button, Alert, Badge } from "../ui/components";
import { useDialogs } from "../ui/dialogs";
import { BUILTIN_FONTS, fontCss } from "../ui/fonts";
import { FONT_ACCEPT } from "../format/embedded-fonts";
import { useFontsVersion } from "../ui/useFonts";
import {
  canQuerySystemFonts,
  importFontFiles,
  importFonts,
  listUserFonts,
  querySystemFonts,
  removeUserFont,
  type ImportOutcome,
  type SystemFontRef,
  type UserFont,
} from "../ui/font-library";
import { reportError } from "../ui/crash-log";
import { downloadFamily, loadCatalog, OfflineError, type OnlineFont } from "../ui/font-online";

const SAMPLE = "Portez ce vieux whisky au juge blond qui fume — 0123456789";

const fmtSize = (n: number) =>
  n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)} Mo` : `${Math.max(1, Math.round(n / 1024))} Ko`;

function OutcomeAlert({ outcome }: { outcome: ImportOutcome }) {
  const { added, duplicates, rejected } = outcome;
  if (!added.length && !duplicates.length && !rejected.length) return null;
  const tone = rejected.length && !added.length ? "danger" : rejected.length ? "warning" : "success";
  return (
    <Alert tone={tone} title={added.length ? `${added.length} police(s) ajoutée(s)` : "Aucune police ajoutée"}>
      {added.length > 0 && <div>Disponibles dans tous les sélecteurs de police : {added.join(", ")}.</div>}
      {duplicates.length > 0 && <div>Déjà présentes : {duplicates.join(", ")}.</div>}
      {rejected.map((r) => (
        <div key={r.file}>
          <strong>{r.file}</strong> — {r.reason}.
        </div>
      ))}
    </Alert>
  );
}

/**
 * Gestionnaire de polices : import de fichiers (TTF/OTF/WOFF/WOFF2, plusieurs à
 * la fois, glisser-déposer), polices installées sur l'ordinateur (si le
 * navigateur le permet), suppression, aperçu. Les polices importées sont
 * conservées et apparaissent dans les sélecteurs de tous les modules.
 */
export default function FontManager({ onClose }: { onClose: () => void }) {
  const dialogs = useDialogs();
  const fontsVersion = useFontsVersion();
  const [fonts, setFonts] = useState<UserFont[]>([]);
  const [outcome, setOutcome] = useState<ImportOutcome | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [system, setSystem] = useState<SystemFontRef[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [showBundled, setShowBundled] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [online, setOnline] = useState<{ fonts: OnlineFont[]; stale: boolean } | null>(null);
  const [onlineQuery, setOnlineQuery] = useState("");
  const [onlineCategory, setOnlineCategory] = useState("");
  const [downloading, setDownloading] = useState<string | null>(null);

  const refresh = useCallback(() => {
    listUserFonts()
      .then(setFonts)
      .catch((e) => reportError("fonts-list", e));
  }, []);
  useEffect(() => {
    void fontsVersion; // relit la liste à chaque ajout/retrait
    refresh();
  }, [refresh, fontsVersion]);

  const run = async (job: () => Promise<ImportOutcome>) => {
    setBusy(true);
    try {
      setOutcome(await job());
    } catch (e) {
      reportError("fonts-import", e);
      await dialogs.alert({ title: "Import impossible", message: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const onFiles = (files: FileList | File[]) => run(() => importFontFiles(files));

  const openSystem = async () => {
    setBusy(true);
    try {
      setSystem(await querySystemFonts());
    } catch (e) {
      // Autorisation refusée ou API indisponible : on l'explique, sans bruit de pile.
      await dialogs.alert({
        title: "Polices de l'ordinateur indisponibles",
        message:
          "Le navigateur n'a pas donné accès aux polices installées (autorisation refusée ?). Vous pouvez toujours ajouter les fichiers de police directement.",
      });
      reportError("fonts-system", e);
    } finally {
      setBusy(false);
    }
  };

  const importPicked = async () => {
    if (!system) return;
    const chosen = system.filter((f) => picked.has(f.fullName));
    await run(async () => {
      const inputs = [];
      for (const f of chosen)
        inputs.push({ filename: `${f.fullName}.ttf`, bytes: await f.load(), source: "système" as const });
      return importFonts(inputs);
    });
    setSystem(null);
    setPicked(new Set());
  };

  const remove = async (f: UserFont) => {
    const ok = await dialogs.confirm({
      title: "Supprimer la police",
      message: `Supprimer « ${f.name} » ? Les documents qui l'utilisent gardent la police incorporée dans leur fichier, mais elle ne sera plus proposée ici.`,
      danger: true,
      confirmLabel: "Supprimer",
    });
    if (!ok) return;
    try {
      await removeUserFont(f.name);
    } catch (e) {
      reportError("fonts-remove", e);
      await dialogs.alert({ title: "Suppression impossible", message: e instanceof Error ? e.message : String(e) });
    }
  };

  const openOnline = async () => {
    const ok = await dialogs.confirm({
      title: "Parcourir les polices en ligne",
      message:
        "Cette fonction se connecte à Internet (api.fontsource.org et cdn.jsdelivr.net) pour lister et télécharger des polices libres (Google Fonts). Seul le nom de la police demandée est transmis ; vos documents ne quittent jamais l'appareil. Continuer ?",
      confirmLabel: "Se connecter",
    });
    if (!ok) return;
    setBusy(true);
    try {
      setOnline(await loadCatalog());
    } catch (e) {
      await dialogs.alert({
        title: "Catalogue indisponible",
        message:
          e instanceof OfflineError
            ? e.message
            : `Impossible de charger le catalogue : ${e instanceof Error ? e.message : e}`,
      });
      if (!(e instanceof OfflineError)) reportError("fonts-catalog", e);
    } finally {
      setBusy(false);
    }
  };

  const download = async (f: OnlineFont) => {
    setDownloading(f.id);
    try {
      setOutcome(await importFonts(await downloadFamily(f)));
    } catch (e) {
      await dialogs.alert({
        title: "Téléchargement impossible",
        message: e instanceof Error ? e.message : String(e),
      });
      if (!(e instanceof OfflineError)) reportError("fonts-download", e);
    } finally {
      setDownloading(null);
    }
  };

  const bundledNames = useMemo(() => new Set(BUILTIN_FONTS.map((f) => f.name.toLowerCase())), []);
  const installedNames = useMemo(() => new Set(fonts.map((f) => f.name.toLowerCase())), [fonts]);
  const categories = useMemo(() => [...new Set((online?.fonts ?? []).map((f) => f.category))].sort(), [online]);
  const onlineShown = useMemo(() => {
    const q = onlineQuery.trim().toLowerCase();
    return (online?.fonts ?? [])
      .filter((f) => (!q || f.family.toLowerCase().includes(q)) && (!onlineCategory || f.category === onlineCategory))
      .slice(0, 80);
  }, [online, onlineQuery, onlineCategory]);

  const bundled = useMemo(
    () => BUILTIN_FONTS.filter((f) => f.name.toLowerCase().includes(filter.toLowerCase())),
    [filter],
  );
  const systemShown = useMemo(
    () => (system ?? []).filter((f) => f.fullName.toLowerCase().includes(filter.toLowerCase())).slice(0, 300),
    [system, filter],
  );

  return (
    <Modal title="Polices" onClose={onClose} wide footer={<Button onClick={onClose}>Fermer</Button>}>
      <div className="settings">
        <section className="settings__section">
          <h3 className="settings__title">
            <Upload size={15} /> Ajouter des polices
          </h3>
          <div
            className={`fontdrop${dragging ? " fontdrop--over" : ""}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              if (e.dataTransfer.files.length) void onFiles(e.dataTransfer.files);
            }}
          >
            <p className="muted fontdrop__text">
              Glissez ici des fichiers <code>.ttf</code>, <code>.otf</code>, <code>.woff</code> ou <code>.woff2</code>,
              ou choisissez-les. Chaque police reste disponible après redémarrage et apparaît dans les sélecteurs de
              police des Documents, du Tableur, des Présentations et du PDF.
            </p>
            <div className="fontdrop__actions">
              <Button size="sm" disabled={busy} onClick={() => fileRef.current?.click()}>
                <Upload size={15} /> Choisir des fichiers…
              </Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={openOnline}>
                <Globe size={15} /> Télécharger en ligne…
              </Button>
              {canQuerySystemFonts() && (
                <Button size="sm" variant="outline" disabled={busy} onClick={openSystem}>
                  <MonitorSmartphone size={15} /> Polices installées sur l'ordinateur…
                </Button>
              )}
            </div>
            <input
              ref={fileRef}
              type="file"
              accept={FONT_ACCEPT}
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files?.length) void onFiles(e.target.files);
                e.target.value = "";
              }}
            />
          </div>
          <Alert tone="info" title="Licences">
            Une police est incorporée dans un document <em>uniquement</em> quand ce document l'utilise. Vérifiez que la
            licence de la police autorise cette incorporation avant de partager le fichier.
          </Alert>
          {outcome && <OutcomeAlert outcome={outcome} />}
        </section>

        {online && (
          <section className="settings__section">
            <h3 className="settings__title">
              <Globe size={15} /> Polices en ligne ({online.fonts.length})
            </h3>
            {online.stale && (
              <Alert tone="warning" title="Hors connexion">
                Catalogue enregistré lors d'une précédente connexion : les téléchargements nécessitent Internet.
              </Alert>
            )}
            <div className="settings__row">
              <input
                className="input"
                placeholder="Rechercher une police…"
                value={onlineQuery}
                onChange={(e) => setOnlineQuery(e.target.value)}
                aria-label="Rechercher une police en ligne"
              />
              <select
                className="input"
                value={onlineCategory}
                onChange={(e) => setOnlineCategory(e.target.value)}
                aria-label="Catégorie"
              >
                <option value="">Toutes les catégories</option>
                {categories.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
              <Button size="sm" variant="ghost" onClick={() => setOnline(null)}>
                Fermer
              </Button>
            </div>
            <ul className="fontlist fontlist--cards">
              {onlineShown.map((f) => {
                const have = bundledNames.has(f.family.toLowerCase()) || installedNames.has(f.family.toLowerCase());
                return (
                  <li key={f.id} className="fontcard">
                    <div className="fontcard__head">
                      <strong>{f.family}</strong>
                      <span className="muted">
                        {f.category} · {f.weights.length} graisse(s) · {f.license}
                      </span>
                      {have ? (
                        <Badge accent="success">Déjà disponible</Badge>
                      ) : (
                        <Button size="sm" variant="outline" disabled={downloading !== null} onClick={() => download(f)}>
                          {downloading === f.id ? (
                            <>
                              <Loader2 size={14} className="spin" /> Téléchargement…
                            </>
                          ) : (
                            <>
                              <Download size={14} /> Télécharger
                            </>
                          )}
                        </Button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
            {online.fonts.length > onlineShown.length && (
              <p className="muted">Affinez la recherche pour voir les autres polices.</p>
            )}
          </section>
        )}

        {system && (
          <section className="settings__section">
            <h3 className="settings__title">
              <MonitorSmartphone size={15} /> Polices de l'ordinateur ({system.length})
            </h3>
            <input
              className="input"
              placeholder="Filtrer…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              aria-label="Filtrer les polices"
            />
            <div className="fontlist" role="group" aria-label="Polices de l'ordinateur">
              {systemShown.map((f) => (
                <label key={f.fullName} className="fontlist__row">
                  <input
                    type="checkbox"
                    checked={picked.has(f.fullName)}
                    onChange={(e) => {
                      const next = new Set(picked);
                      if (e.target.checked) next.add(f.fullName);
                      else next.delete(f.fullName);
                      setPicked(next);
                    }}
                  />
                  <span>{f.fullName}</span>
                </label>
              ))}
            </div>
            <div className="settings__row">
              <Button size="sm" disabled={busy || picked.size === 0} onClick={importPicked}>
                Importer {picked.size || ""} police(s)
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setSystem(null)}>
                Annuler
              </Button>
            </div>
          </section>
        )}

        <section className="settings__section">
          <h3 className="settings__title">
            <Type size={15} /> Mes polices <Badge>{fonts.length}</Badge>
          </h3>
          {fonts.length === 0 ? (
            <p className="muted">Aucune police personnelle pour l'instant.</p>
          ) : (
            <ul className="fontlist fontlist--cards">
              {fonts.map((f) => (
                <li key={f.name} className="fontcard">
                  <div className="fontcard__head">
                    <strong>{f.name}</strong>
                    <span className="muted">
                      {fmtSize(f.size)} · {f.source}
                    </span>
                    <Button size="sm" variant="ghost" aria-label={`Supprimer ${f.name}`} onClick={() => remove(f)}>
                      <Trash2 size={14} />
                    </Button>
                  </div>
                  <div className="fontcard__sample" style={{ fontFamily: fontCss(f.name) }}>
                    {SAMPLE}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="settings__section">
          <h3 className="settings__title">
            Polices fournies avec Elium <Badge>{BUILTIN_FONTS.length}</Badge>
          </h3>
          <p className="muted">
            Intégrées à l'application : elles fonctionnent hors ligne, sur n'importe quel poste, sans rien installer.
          </p>
          <div className="settings__row">
            <Button size="sm" variant="outline" onClick={() => setShowBundled((s) => !s)}>
              {showBundled ? "Masquer la liste" : "Afficher la liste"}
            </Button>
          </div>
          {showBundled && (
            <>
              <input
                className="input"
                placeholder="Filtrer…"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                aria-label="Filtrer les polices fournies"
              />
              <ul className="fontlist fontlist--cards">
                {bundled.map((f) => (
                  <li key={f.name} className="fontcard">
                    <div className="fontcard__head">
                      <strong>{f.name}</strong>
                    </div>
                    <div className="fontcard__sample" style={{ fontFamily: f.css }}>
                      {SAMPLE}
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      </div>
    </Modal>
  );
}
