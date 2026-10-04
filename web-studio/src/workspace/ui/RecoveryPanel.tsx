/**
 * Récupération automatique : brouillons de documents non enregistrés (aperçu,
 * date, taille) et brouillons PDF. Après une fermeture anormale, une bannière
 * l'explique et propose de tout récupérer.
 */
import { AlertTriangle, Download, FileText, FileType, Lock, RotateCcw, Trash2 } from "lucide-react";
import { useI18n } from "../../i18n";
import type { RecoverableDraft } from "../recovery";

export interface PdfDraftLine {
  id: string;
  name: string;
  updatedAt: string;
  size: number;
  /** On peut rouvrir le fichier d'origine directement (poignée conservée). */
  canReopen: boolean;
}

export default function RecoveryPanel({
  drafts,
  pdfDrafts,
  uncleanExit,
  previousStartedAt,
  showAll,
  onToggleAll,
  onRecover,
  onDownload,
  onDelete,
  onClearAll,
  onClearSaved,
  onReopenPdf,
  onDismissBanner,
}: {
  drafts: RecoverableDraft[];
  pdfDrafts: PdfDraftLine[];
  uncleanExit: boolean;
  previousStartedAt: string | null;
  showAll: boolean;
  onToggleAll: () => void;
  onRecover: (id: string) => void;
  onDownload: (id: string) => void;
  onDelete: (id: string) => void;
  onClearAll: () => void;
  onClearSaved: () => void;
  onReopenPdf: (id: string) => void;
  onDismissBanner: () => void;
}) {
  const { t, tn, fmt } = useI18n();
  const pending = drafts.filter((d) => !d.saved);
  const saved = drafts.filter((d) => d.saved);
  if (drafts.length === 0 && pdfDrafts.length === 0) return null;
  const PREVIEW = 6;
  const shown = showAll ? pending : pending.slice(0, PREVIEW);
  const hidden = pending.length - shown.length;

  return (
    <section className="home__section" aria-label={t("recovery.title")}>
      {uncleanExit && pending.length + pdfDrafts.length > 0 && (
        <div className="alert alert--warning recovery__banner" role="alert">
          <span className="alert__icon">
            <AlertTriangle size={16} />
          </span>
          <div className="alert__body">
            <div className="alert__title">{t("recovery.crash_title")}</div>
            <div className="alert__text">
              {previousStartedAt
                ? t("recovery.crash_body_since", { date: fmt.dateTime(previousStartedAt) })
                : t("recovery.crash_body")}
            </div>
          </div>
          <button type="button" className="eb eb--sm eb--ghost" onClick={onDismissBanner}>
            {t("recovery.dismiss")}
          </button>
        </div>
      )}
      <h2 className="home__section-title">
        <RotateCcw size={18} /> {t("recovery.title")}
        <span className="badge badge--neutral">{pending.length + pdfDrafts.length}</span>
        {pending.length > 0 && (
          <button type="button" className="home__section-action" onClick={onClearAll}>
            <Trash2 size={13} /> {t("recovery.clear_all")}
          </button>
        )}
      </h2>
      <p className="muted">{t("recovery.intro")}</p>

      <ul className="recovery__list">
        {shown.map((d) => (
          <li key={d.id} className="recovery__item">
            <FileText size={18} aria-hidden />
            <div className="recovery__main">
              <div className="recovery__title">
                {d.title}
                {d.fromLastSession && <span className="badge badge--warning">{t("recovery.last_session")}</span>}
                {d.protected && (
                  <span className="badge badge--info" title={t("recovery.protected_hint")}>
                    <Lock size={11} /> {t("recovery.protected")}
                  </span>
                )}
                {d.legacy && (
                  <span className="badge badge--warning" title={t("recovery.legacy_hint")}>
                    <Lock size={11} /> {t("recovery.legacy")}
                  </span>
                )}
              </div>
              {d.preview ? (
                <div className="recovery__preview">{d.preview}</div>
              ) : d.protected ? (
                <div className="recovery__preview muted">{t("recovery.preview_hidden")}</div>
              ) : null}
              <div className="recovery__meta">
                <time dateTime={d.updatedAt}>{fmt.dateTime(d.updatedAt)}</time> · {fmt.relative(d.updatedAt)} ·{" "}
                {fmt.bytes(d.size)}
              </div>
            </div>
            <div className="recovery__actions">
              <button type="button" className="eb eb--sm eb--primary" onClick={() => onRecover(d.id)}>
                <RotateCcw size={14} /> {t("recovery.recover")}
              </button>
              <button
                type="button"
                className="icon-btn"
                aria-label={t("recovery.download_docx")}
                title={t("recovery.download_docx")}
                onClick={() => onDownload(d.id)}
              >
                <Download size={14} />
              </button>
              <button
                type="button"
                className="icon-btn icon-btn--danger"
                aria-label={t("recovery.delete")}
                title={t("recovery.delete")}
                onClick={() => onDelete(d.id)}
              >
                <Trash2 size={14} />
              </button>
            </div>
          </li>
        ))}
        {pdfDrafts.map((d) => (
          <li key={`pdf:${d.id}`} className="recovery__item">
            <FileType size={18} aria-hidden />
            <div className="recovery__main">
              <div className="recovery__title">
                {d.name} <span className="badge badge--neutral">PDF</span>
              </div>
              <div className="recovery__preview muted">
                {d.canReopen ? t("recovery.pdf_reopen_hint") : t("recovery.pdf_hint")}
              </div>
              <div className="recovery__meta">
                <time dateTime={d.updatedAt}>{fmt.dateTime(d.updatedAt)}</time> · {fmt.bytes(d.size)}
              </div>
            </div>
            <div className="recovery__actions">
              {d.canReopen && (
                <button type="button" className="eb eb--sm eb--primary" onClick={() => onReopenPdf(d.id)}>
                  <RotateCcw size={14} /> {t("recovery.reopen")}
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {(hidden > 0 || showAll) && pending.length > PREVIEW && (
        <button type="button" className="home__more" onClick={onToggleAll}>
          {showAll ? t("recovery.show_less") : tn("recovery.show_more", hidden)}
        </button>
      )}
      {saved.length > 0 && (
        <p className="muted recovery__saved">
          {tn("recovery.saved_note", saved.length)}{" "}
          <button type="button" className="home__version-manage" onClick={onClearSaved}>
            {t("recovery.clear_saved")}
          </button>
        </p>
      )}
    </section>
  );
}
