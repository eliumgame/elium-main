import { useEffect, useRef, useState } from "react";
import {
  UploadCloud, FileText, PenLine, ShieldCheck, Lock, Settings,
  FolderOpen, Trash2, Clock, FileSpreadsheet, Presentation, ArrowRight, FileType,
  History, RotateCcw, Download, Cloud, Users,
} from "lucide-react";
import { TEMPLATES, type Template } from "../editor/templates";
import { IMPORT_ACCEPT } from "../format/importers";
import { listDriveDocs, getDriveDoc, deleteDriveDoc, type ResolvedDriveEntry } from "../format/drive-store";
import { listDrafts, deleteDraft, type DraftEntry } from "../format/drafts-store";
import { PROFILES } from "../format/profiles";
import { useDialogs } from "../ui/dialogs";
import type { VaultSecret } from "../crypto/local-vault";
import "../drive-cloud/drive-cloud.css";

export default function HomeView({
  onCreate,
  onOpen,
  onOpenSettings,
  onNewSheet,
  onNewSlides,
  onNewPdf,
  onOpenDriveCloud,
  onRecoverDraft,
  onDownloadDraft,
  vaultSecret,
}: {
  onCreate: (tpl: Template) => void;
  onOpen: (file: File) => void;
  onOpenSettings: () => void;
  onNewSheet: () => void;
  onNewSlides: () => void;
  onNewPdf: () => void;
  onOpenDriveCloud: () => void;
  onRecoverDraft: (id: string) => void;
  onDownloadDraft: (id: string) => void;
  /** Set only when the opt-in local vault (Settings) is configured and unlocked. */
  vaultSecret?: VaultSecret;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const [library, setLibrary] = useState<ResolvedDriveEntry[]>([]);
  const [libQuery, setLibQuery] = useState("");
  const [drafts, setDrafts] = useState<DraftEntry[]>([]);
  const { confirm, alert } = useDialogs();

  const reloadLibrary = () => {
    listDriveDocs(vaultSecret).then(setLibrary).catch(() => setLibrary([]));
  };
  const reloadDrafts = () => {
    listDrafts().then(setDrafts).catch(() => setDrafts([]));
  };
  useEffect(() => {
    reloadLibrary();
    reloadDrafts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vaultSecret]);

  const removeDraft = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (!(await confirm({ title: "Supprimer le brouillon", message: "Supprimer définitivement ce brouillon auto-enregistré ?", danger: true, confirmLabel: "Supprimer" }))) return;
    await deleteDraft(id);
    reloadDrafts();
  };

  const openFromLibrary = async (entry: ResolvedDriveEntry) => {
    try {
      const doc = await getDriveDoc(entry.id, vaultSecret);
      if (!doc) {
        reloadLibrary();
        return;
      }
      const part = doc.bytes as unknown as BlobPart;
      onOpen(new File([part], `${doc.title || "document"}.elium`, { type: "application/x-elium" }));
    } catch (e) {
      await alert({ title: "Impossible d'ouvrir ce document", message: e instanceof Error ? e.message : "Erreur inconnue." });
    }
  };

  const removeFromLibrary = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (!(await confirm({ title: "Retirer de la bibliothèque", message: "Retirer ce document de la bibliothèque locale ?\n(le fichier .elium déjà exporté n'est pas supprimé)", confirmLabel: "Retirer" }))) return;
    await deleteDriveDoc(id);
    reloadLibrary();
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDrag(false);
    const f = e.dataTransfer.files?.[0];
    if (f) onOpen(f);
  };

  const blank = TEMPLATES.find((t) => t.id === "blank") ?? TEMPLATES[0];
  const filteredLibrary = library.filter((d) => {
    const q = libQuery.trim().toLowerCase();
    return !q || d.title.toLowerCase().includes(q) || d.profile.toLowerCase().includes(q);
  });

  const apps = [
    { key: "docs", name: "Documents", desc: "Éditeur de texte riche", icon: <FileText size={26} />, onClick: () => onCreate(blank) },
    { key: "sheets", name: "Tableur", desc: "Feuilles de calcul & formules", icon: <FileSpreadsheet size={26} />, onClick: onNewSheet },
    { key: "slides", name: "Présentations", desc: "Diapositives & présentateur", icon: <Presentation size={26} />, onClick: onNewSlides },
    { key: "pdf", name: "PDF", desc: "Lire, annoter & éditer des PDF", icon: <FileType size={26} />, onClick: onNewPdf },
  ];

  return (
    <main className="home">
      <header className="home__top">
        <div className="brand">
          <img src="/elium-logo.svg" alt="" className="brand__logo" width={30} height={30} />
          <span className="brand__name">Elium</span>
          <span className="home__pill">Workspace</span>
        </div>
        <button className="icon-btn" onClick={onOpenSettings} title="Paramètres" aria-label="Paramètres">
          <Settings size={20} />
        </button>
      </header>

      <section className="home__hero">
        <h1 className="home__title">Votre espace de travail documentaire</h1>
        <p className="home__subtitle">
          Documents, tableurs et présentations — <b>chiffrés, signés et scellés</b>, 100 % en local, au format <code>.elium</code>.
        </p>
        <div className="home__hero-badges">
          <span className="home__badge"><ShieldCheck size={15} /> Preuve cryptographique</span>
          <span className="home__badge"><Lock size={15} /> Chiffrement à la demande</span>
          <span className="home__badge"><PenLine size={15} /> Signatures placées librement</span>
        </div>
      </section>

      <section className="home__section">
        <button className="home__drive-cta" onClick={onOpenDriveCloud}>
          <span className="home__drive-cta__icon"><Cloud size={28} /></span>
          <span className="home__drive-cta__body">
            <span className="home__drive-cta__title">Drive entreprise chiffré <span className="home__pill">Nouveau</span></span>
            <span className="home__drive-cta__desc">Stockez, partagez et collaborez à plusieurs — chiffré de bout en bout, rôles & permissions détaillés.</span>
          </span>
          <span className="home__drive-cta__meta"><Users size={16} /> Multi-utilisateurs</span>
          <span className="app-tile__go"><ArrowRight size={18} /></span>
        </button>
      </section>

      <section className="home__section">
        <h2 className="home__section-title">Créer</h2>
        <div className="app-launcher">
          {apps.map((a) => (
            <button key={a.key} className={`app-tile app-tile--${a.key}`} onClick={a.onClick}>
              <span className="app-tile__icon">{a.icon}</span>
              <span className="app-tile__body">
                <span className="app-tile__name">{a.name}</span>
                <span className="app-tile__desc">{a.desc}</span>
              </span>
              <span className="app-tile__go"><ArrowRight size={18} /></span>
            </button>
          ))}
        </div>
      </section>

      <section className="home__section">
        <h2 className="home__section-title">Ouvrir</h2>
        <div
          className={`dropzone ${drag ? "is-active" : ""}`}
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
          onDragLeave={() => setDrag(false)}
          onDrop={handleDrop}
          onClick={() => inputRef.current?.click()}
          role="button"
          tabIndex={0}
        >
          <UploadCloud size={32} />
          <div className="dropzone__title">Glissez un fichier <b>.elium</b> ou cliquez pour parcourir</div>
          <div className="dropzone__hint">Importez aussi <b>.docx</b>, <b>.txt</b>, <b>.md</b> ou <b>.html</b></div>
          <input
            ref={inputRef}
            type="file"
            accept={IMPORT_ACCEPT}
            hidden
            onChange={(e) => { const f = e.target.files?.[0]; if (f) onOpen(f); e.target.value = ""; }}
          />
        </div>
      </section>

      {drafts.length > 0 && (
        <section className="home__section">
          <h2 className="home__section-title"><History size={18} /> Récupération automatique</h2>
          <p className="muted">
            Brouillons enregistrés automatiquement pendant l'édition (jamais perdus en cas de fermeture).
            Ils restent ici jusqu'à ce que vous les supprimiez.
          </p>
          <div className="library-grid">
            {drafts.map((d) => (
              <div
                key={d.id}
                className="library-card"
                role="button"
                tabIndex={0}
                onClick={() => onRecoverDraft(d.id)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onRecoverDraft(d.id); } }}
              >
                <div className="library-card__top">
                  <FileText size={18} />
                  <span className="library-card__title">{d.title}</span>
                  <button
                    type="button"
                    className="icon-btn library-card__del"
                    aria-label="Télécharger en .docx"
                    title="Télécharger en .docx"
                    onClick={(e) => { e.stopPropagation(); onDownloadDraft(d.id); }}
                  >
                    <Download size={14} />
                  </button>
                  <button
                    type="button"
                    className="icon-btn icon-btn--danger library-card__del"
                    aria-label="Supprimer le brouillon"
                    title="Supprimer le brouillon"
                    onClick={(e) => void removeDraft(e, d.id)}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
                <div className="library-card__meta">
                  <span className="badge badge--neutral"><RotateCcw size={11} /> Brouillon</span>
                  {d.protected && (
                    <span className="badge badge--info" title="Brouillon chiffré — mot de passe requis pour l'ouvrir">
                      <Lock size={11} /> Protégé
                    </span>
                  )}
                  {d.legacy && (
                    <span
                      className="badge badge--warning"
                      title="Enregistré avant la mise à jour de sécurité du 2026-07-02 : si le document d'origine était protégé par mot de passe, ce brouillon en contient une copie NON chiffrée. Supprimez-le si besoin."
                    >
                      <Lock size={11} /> Ancien format — non chiffré
                    </span>
                  )}
                  <span className="library-card__date"><Clock size={12} /> {new Date(d.updatedAt).toLocaleString("fr-FR")}</span>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {library.length > 0 && (
        <section className="home__section">
          <div className="home__section-head">
            <h2 className="home__section-title"><FolderOpen size={18} /> Récents</h2>
            <input
              className="library-search"
              type="search"
              placeholder="Rechercher…"
              value={libQuery}
              onChange={(e) => setLibQuery(e.target.value)}
              aria-label="Rechercher dans mes documents"
            />
          </div>
          {filteredLibrary.length === 0 ? (
            <p className="muted">Aucun document ne correspond à « {libQuery} ».</p>
          ) : (
            <div className="library-grid">
              {filteredLibrary.map((d) => (
                <div
                  key={d.id}
                  className="library-card"
                  role="button"
                  tabIndex={0}
                  onClick={() => void openFromLibrary(d)}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); void openFromLibrary(d); } }}
                >
                  <div className="library-card__top">
                    {d.locked ? <Lock size={18} /> : <FileText size={18} />}
                    <span className="library-card__title">{d.title}</span>
                    <button
                      type="button"
                      className="icon-btn icon-btn--danger library-card__del"
                      aria-label="Retirer de la bibliothèque"
                      title="Retirer de la bibliothèque"
                      onClick={(e) => void removeFromLibrary(e, d.id)}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                  <div className="library-card__meta">
                    {d.locked ? (
                      <span className="badge badge--warning" title="Coffre local verrouillé ou mot de passe incorrect">
                        <Lock size={11} /> Coffre verrouillé
                      </span>
                    ) : (
                      <span className="badge badge--neutral">{PROFILES[d.profile as keyof typeof PROFILES]?.badge ?? d.profile}</span>
                    )}
                    <span className="library-card__date"><Clock size={12} /> {new Date(d.savedAt).toLocaleDateString("fr-FR")}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      <section className="home__section">
        <h2 className="home__section-title">Modèles de documents</h2>
        <div className="template-grid">
          {TEMPLATES.map((t) => (
            <button key={t.id} className="template-card" onClick={() => onCreate(t)}>
              <div className="template-card__label">{t.label}</div>
              <div className="template-card__desc">{t.description}</div>
            </button>
          ))}
        </div>
      </section>

      <footer className="home__footer">
        Traitement 100 % local · aucune donnée envoyée en ligne sans action explicite · conforme RGPD par conception
      </footer>
    </main>
  );
}
