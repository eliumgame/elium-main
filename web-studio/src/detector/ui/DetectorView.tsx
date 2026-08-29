/**
 * Vue Détecteur — page autonome (charte des vues plein écran, cf. DocumentationView).
 * Ne contient aucune logique d'analyse : elle orchestre `loadDocumentModel` puis
 * `runAnalysis` (tous deux dans `../`) et affiche le `AnalysisReport` obtenu.
 * Le plagiat est strictement opt-in : `plagiarism` n'est construit et transmis à
 * `runAnalysis` que si l'utilisateur a coché la case ET saisi une clé — impossible
 * à déclencher par accident (voir `buildPlagiarismOption`).
 */
import { useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, Eye, ExternalLink, FileText, Loader2, UploadCloud } from "lucide-react";
import { Alert, Badge, Button, EmptyState, Field } from "../../ui/components";
import { Tabs } from "../../ui/components";
import { useDialogs } from "../../ui/dialogs";
import type {
  AnalysisProgress,
  AnalysisReport,
  AnalysisStage,
  CategoryReport,
  DocumentMetadata,
  DocumentModel,
  Finding,
  SignalCategory,
  SignalSeverity,
} from "../types";
import {
  EliumPasswordRequired,
  EliumRecipientKeyRequired,
  PdfPasswordRequired,
  loadDocumentModel,
} from "../ingest/loadFile";
import { runAnalysis } from "../runAnalysis";
import { createBingProvider, createSerperProvider } from "../plagiarism/searchProviders";
import { signalsByCategory, type SignalCatalogEntry } from "../signalCatalog";
import DocumentPreview from "./DocumentPreview";
import type { PreviewFlag } from "./previewFlags";
import "./DetectorView.css";

const CATEGORY_TITLES: Record<SignalCategory, string> = {
  texte: "Texte",
  mise_en_forme: "Mise en forme",
  metadonnees: "Métadonnées",
  image: "Images",
  plagiat: "Plagiat",
};

const DISABLED_SIGNALS_KEY = "elium-detector-disabled-signals";

function loadDisabledSignals(): Set<string> {
  try {
    const raw = localStorage.getItem(DISABLED_SIGNALS_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? new Set(arr.filter((v) => typeof v === "string")) : new Set();
  } catch {
    return new Set();
  }
}

/** Tous les points repérés du rapport, quelle que soit la catégorie active à
 *  l'écran — l'aperçu souligne le document dans son ensemble, pas seulement
 *  l'onglet ouvert. */
function buildPreviewFlags(report: AnalysisReport): PreviewFlag[] {
  const flags: PreviewFlag[] = [];
  for (const cat of report.categories) {
    for (const f of cat.findings) {
      if (f.location.paragraphIndex == null) continue;
      flags.push({ id: f.id, paragraphIndex: f.location.paragraphIndex, label: f.label, evidence: f.evidence });
    }
  }
  if (report.plagiarism) {
    report.plagiarism.matches.forEach((m, i) => {
      flags.push({
        id: `plagiat-${m.paragraphIndex}-${i}`,
        paragraphIndex: m.paragraphIndex,
        label: `Correspondance possible avec ${m.sourceTitle || m.url}`,
        evidence: m.passage,
      });
    });
  }
  return flags;
}

function saveDisabledSignals(set: Set<string>): void {
  try {
    localStorage.setItem(DISABLED_SIGNALS_KEY, JSON.stringify([...set]));
  } catch {
    // stockage indisponible (navigation privée, quota) : le réglage retombera
    // simplement à "tout activé" à la prochaine session, rien de grave.
  }
}

type Phase = "upload" | "reading" | "ready" | "analyzing" | "report";

interface LoadFailure {
  tone: "danger" | "warning";
  title: string;
  message: string;
}

const SEARCH_PROVIDER_KEY = "elium-detector-search-provider";
const SEARCH_API_KEY_KEY = "elium-detector-search-api-key";

const STAGE_LABELS: Record<AnalysisStage, string> = {
  ingestion: "Lecture du document",
  texte: "Analyse du texte",
  mise_en_forme: "Analyse de la mise en forme",
  metadonnees: "Analyse des métadonnées",
  image: "Analyse des images",
  plagiat: "Recherche de plagiat sur le web",
  score: "Calcul du score",
};

export default function DetectorView({ onHome }: { onHome: () => void }) {
  const dialogs = useDialogs();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const [phase, setPhase] = useState<Phase>("upload");
  const [fileName, setFileName] = useState("");
  const [model, setModel] = useState<DocumentModel | null>(null);
  const [loadError, setLoadError] = useState<LoadFailure | null>(null);
  const [progress, setProgress] = useState<AnalysisProgress | null>(null);
  const [report, setReport] = useState<AnalysisReport | null>(null);
  const [activeTab, setActiveTab] = useState("texte");
  const [isDragOver, setIsDragOver] = useState(false);

  const [plagiarismEnabled, setPlagiarismEnabled] = useState(false);
  const [searchProvider, setSearchProvider] = useState<"serper" | "bing">(() =>
    localStorage.getItem(SEARCH_PROVIDER_KEY) === "bing" ? "bing" : "serper",
  );
  const [searchApiKey, setSearchApiKey] = useState(() => localStorage.getItem(SEARCH_API_KEY_KEY) ?? "");

  const [disabledSignals, setDisabledSignals] = useState<Set<string>>(() => loadDisabledSignals());
  const [sensitivityOpen, setSensitivityOpen] = useState(false);
  const toggleSignal = (id: string) => {
    setDisabledSignals((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      saveDisabledSignals(next);
      return next;
    });
  };

  const [focusedFlagId, setFocusedFlagId] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const previewFlags = useMemo(() => (report ? buildPreviewFlags(report) : []), [report]);
  const showInDocument = (id: string, paragraphIndex: number | undefined) => {
    if (paragraphIndex == null) return;
    setFocusedFlagId(id);
    setPreviewOpen(true);
  };

  const changeProvider = (v: "serper" | "bing") => {
    setSearchProvider(v);
    localStorage.setItem(SEARCH_PROVIDER_KEY, v);
  };
  const changeApiKey = (v: string) => {
    setSearchApiKey(v);
    localStorage.setItem(SEARCH_API_KEY_KEY, v);
  };

  async function attemptLoad(file: File, password?: string) {
    setLoadError(null);
    setFileName(file.name);
    setPhase("reading");
    try {
      const loaded = await loadDocumentModel(file, password !== undefined ? { password } : undefined);
      setModel(loaded);
      setPhase("ready");
    } catch (err) {
      if (err instanceof EliumRecipientKeyRequired) {
        setLoadError({
          tone: "warning",
          title: "Document chiffré pour des destinataires",
          message:
            "Ce document est chiffré pour des destinataires spécifiques. Le Détecteur ne prend pas encore en charge ce cas de figure.",
        });
        setPhase("upload");
        return;
      }
      if (err instanceof EliumPasswordRequired || err instanceof PdfPasswordRequired) {
        // Un mot de passe déjà fourni qui redéclenche la même exception veut dire
        // qu'il était incorrect — EliumPasswordRequired ne porte pas ce détail,
        // contrairement à PdfPasswordRequired.wrong, donc on le déduit ici.
        const wasWrongAttempt = password !== undefined || (err instanceof PdfPasswordRequired && err.wrong);
        const nextPassword = await dialogs.prompt({
          title: "Mot de passe requis",
          label: `Mot de passe pour « ${file.name} »`,
          hint: wasWrongAttempt ? "Mot de passe incorrect, réessayez." : undefined,
          confirmLabel: "Déverrouiller",
        });
        if (nextPassword == null) {
          setPhase("upload");
          return;
        }
        await attemptLoad(file, nextPassword);
        return;
      }
      setLoadError({
        tone: "danger",
        title: "Impossible de lire le document",
        message: err instanceof Error ? err.message : String(err),
      });
      setPhase("upload");
    }
  }

  function onFileChosen(file: File | undefined) {
    if (!file) return;
    void attemptLoad(file);
  }

  function buildPlagiarismOption() {
    if (!plagiarismEnabled) return undefined;
    const key = searchApiKey.trim();
    if (!key) return undefined;
    const provider = searchProvider === "bing" ? createBingProvider(key) : createSerperProvider(key);
    return { provider, maxQueries: 60, similarityThreshold: 0.5 };
  }

  async function startAnalysis() {
    if (!model) return;
    const controller = new AbortController();
    abortControllerRef.current = controller;
    setProgress(null);
    setPhase("analyzing");
    try {
      const result = await runAnalysis(model, {
        generatedAt: new Date().toISOString(),
        signal: controller.signal,
        onProgress: setProgress,
        plagiarism: buildPlagiarismOption(),
        disabledSignals,
      });
      setReport(result);
      setActiveTab("texte");
      setFocusedFlagId(null);
      setPreviewOpen(false);
      setPhase("report");
    } catch (err) {
      if (controller.signal.aborted) {
        setPhase("ready");
        return;
      }
      setLoadError({
        tone: "danger",
        title: "L'analyse a échoué",
        message: err instanceof Error ? err.message : String(err),
      });
      setPhase("ready");
    } finally {
      abortControllerRef.current = null;
    }
  }

  function cancelAnalysis() {
    abortControllerRef.current?.abort();
  }

  function resetAll() {
    setPhase("upload");
    setFileName("");
    setModel(null);
    setReport(null);
    setProgress(null);
    setLoadError(null);
    setPlagiarismEnabled(false);
    setFocusedFlagId(null);
    setPreviewOpen(false);
  }

  const tabs = (() => {
    if (!report) return [];
    const withScore = (id: SignalCategory, label: string) => {
      const cat = report.categories.find((c) => c.category === id);
      return { id, label: cat ? `${label} (${cat.score})` : label };
    };
    const base = [
      withScore("texte", "Texte"),
      withScore("mise_en_forme", "Mise en forme"),
      withScore("metadonnees", "Métadonnées"),
      withScore("image", "Images"),
    ];
    if (report.plagiarism) base.push({ id: "plagiat", label: `Plagiat (${report.plagiarism.matches.length})` });
    return base;
  })();

  return (
    <div className="det-page">
      <header className="det-header">
        <Button variant="ghost" size="sm" className="det-header__back" onClick={onHome}>
          <ArrowLeft size={15} /> Retour à l'accueil
        </Button>
        <div className="det-header__titles">
          <h1 className="det-header__title">Détecteur</h1>
          <p className="det-header__subtitle">
            Analyse un document (.elium, .docx, .pdf) ou une image seule (.png, .jpg, .webp) à la recherche de
            signaux de rédaction ou de génération par IA, d'anomalies de mise en forme et de métadonnées — avec une
            vérification optionnelle de plagiat sur le web.
          </p>
        </div>
      </header>

      <div className="det-body">
        {phase === "upload" && (
          <div className="det-upload">
            {loadError && (
              <Alert tone={loadError.tone} title={loadError.title}>
                {loadError.message}
              </Alert>
            )}
            <div
              className={`det-dropzone ${isDragOver ? "is-over" : ""}`}
              onDragOver={(e) => {
                e.preventDefault();
                setIsDragOver(true);
              }}
              onDragLeave={() => setIsDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setIsDragOver(false);
                onFileChosen(e.dataTransfer.files?.[0]);
              }}
            >
              <div className="det-dropzone__card">
                <div className="det-dropzone__icon">
                  <UploadCloud size={28} />
                </div>
                <h2>Déposez un document ou une image à analyser</h2>
                <p>
                  Formats acceptés : .elium, .docx, .pdf, .png, .jpg, .webp. Le fichier reste sur votre appareil ;
                  rien n'en sort sans votre accord explicite (voir la vérification de plagiat, plus loin).
                </p>
                <div className="det-dropzone__actions">
                  <Button variant="primary" onClick={() => fileInputRef.current?.click()}>
                    Choisir un fichier…
                  </Button>
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".elium,.docx,.pdf,.png,.jpg,.jpeg,.webp"
                  className="visually-hidden"
                  onChange={(e) => {
                    onFileChosen(e.target.files?.[0]);
                    e.target.value = "";
                  }}
                />
              </div>
            </div>
          </div>
        )}

        {phase === "reading" && (
          <div className="det-loading">
            <Loader2 className="elx-spin" size={28} />
            <p>Lecture de « {fileName} »…</p>
          </div>
        )}

        {phase === "ready" && model && (
          <div className="det-ready">
            <div className="det-ready__file">
              <FileText size={18} />
              <div>
                <div className="det-ready__filename">{fileName}</div>
                <div className="det-ready__filemeta">
                  {model.metadata.sourceFormat === "image"
                    ? "Image seule" +
                      (model.images[0]?.width && model.images[0]?.height
                        ? ` — ${model.images[0].width}×${model.images[0].height}`
                        : "")
                    : `${model.paragraphs.length} paragraphe(s)` +
                      (model.images.length > 0 ? `, ${model.images.length} image(s)` : "") +
                      (model.metadata.pageCount ? `, ${model.metadata.pageCount} page(s)` : "")}
                </div>
              </div>
            </div>

            {loadError && (
              <Alert tone={loadError.tone} title={loadError.title}>
                {loadError.message}
              </Alert>
            )}

            <div className="det-plagiarism-settings">
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={plagiarismEnabled}
                  onChange={(e) => setPlagiarismEnabled(e.target.checked)}
                />
                <span>Vérifier aussi le plagiat sur le web (optionnel)</span>
              </label>
              {plagiarismEnabled && (
                <div className="det-plagiarism-fields">
                  <Field label="Moteur de recherche">
                    <select
                      className="input"
                      value={searchProvider}
                      onChange={(e) => changeProvider(e.target.value === "bing" ? "bing" : "serper")}
                    >
                      <option value="serper">Serper (Google)</option>
                      <option value="bing">Bing</option>
                    </select>
                  </Field>
                  <Field
                    label="Clé API"
                    hint="Cette vérification envoie de courts extraits distinctifs du document (pas le document
                      entier) au moteur de recherche choisi, uniquement si vous l'activez. La clé est stockée
                      uniquement dans votre navigateur (localStorage), jamais transmise ailleurs qu'au moteur
                      choisi."
                  >
                    <input
                      type="password"
                      className="input"
                      value={searchApiKey}
                      onChange={(e) => changeApiKey(e.target.value)}
                      placeholder="Clé API"
                    />
                  </Field>
                </div>
              )}
            </div>

            <SensitivitySettings
              open={sensitivityOpen}
              onToggleOpen={() => setSensitivityOpen((o) => !o)}
              disabledSignals={disabledSignals}
              onToggleSignal={toggleSignal}
            />

            <div className="det-actions">
              <Button variant="outline" onClick={resetAll}>
                Changer de fichier
              </Button>
              <Button variant="primary" onClick={() => void startAnalysis()}>
                Analyser le document
              </Button>
            </div>
          </div>
        )}

        {phase === "analyzing" && (
          <div className="det-progress">
            <div className="det-progress__stage">{progress ? STAGE_LABELS[progress.stage] : "Préparation…"}</div>
            <div className={`det-progress__bar ${progress && progress.total > 1 ? "" : "is-indeterminate"}`}>
              <div
                className="det-progress__fill"
                style={
                  progress && progress.total > 1
                    ? { width: `${Math.min(100, Math.round((progress.processed / progress.total) * 100))}%` }
                    : undefined
                }
              />
            </div>
            {progress && progress.total > 1 && (
              <div className="det-progress__count">
                {progress.processed} / {progress.total}
              </div>
            )}
            <Button variant="outline" onClick={cancelAnalysis}>
              Annuler
            </Button>
          </div>
        )}

        {phase === "report" && report && (
          <div className="det-report">
            <div className="det-score">
              <div className={`det-score__value det-score__value--${scoreTone(report.overallScore)}`}>
                {report.overallScore}
                <span className="det-score__scale">/100</span>
              </div>
              <div className="det-score__side">
                <div className="det-score__bar">
                  <div
                    className={`det-score__fill det-score__fill--${scoreTone(report.overallScore)}`}
                    style={{ width: `${report.overallScore}%` }}
                  />
                </div>
                <div className="det-score__meta">
                  <Badge accent={confidenceAccent(report.confidence)}>Confiance : {report.confidence}</Badge>
                  <span className="det-score__date">
                    Généré le {new Date(report.generatedAt).toLocaleString("fr-FR")}
                  </span>
                </div>
                <p className="det-score__confidence-note">{confidenceExplanation(report.confidence)}</p>
              </div>
            </div>

            <Alert tone="info">{report.disclaimer}</Alert>

            <Tabs tabs={tabs} active={activeTab} onChange={setActiveTab} />

            <div className="det-tabpanel">
              {activeTab === "plagiat" && report.plagiarism ? (
                <PlagiarismPanel
                  result={report.plagiarism}
                  totalParagraphs={model?.paragraphs.length ?? 0}
                  onShowInDocument={showInDocument}
                />
              ) : (
                (() => {
                  const cat = report.categories.find((c) => c.category === activeTab);
                  if (!cat) return null;
                  return (
                    <CategoryPanel
                      category={cat}
                      metadata={activeTab === "metadonnees" ? report.documentMetadata : undefined}
                      onShowInDocument={showInDocument}
                    />
                  );
                })()
              )}
            </div>

            <div className="det-actions det-actions--report">
              <Button variant="outline" onClick={resetAll}>
                Nouvelle analyse
              </Button>
              <Button variant="primary" onClick={() => window.print()}>
                Imprimer / Exporter en PDF
              </Button>
            </div>
          </div>
        )}
      </div>

      {previewOpen && model && (
        <DocumentPreview
          paragraphs={model.paragraphs}
          flags={previewFlags}
          focusedId={focusedFlagId}
          onClose={() => setPreviewOpen(false)}
        />
      )}
    </div>
  );
}

function scoreTone(score: number): "success" | "warning" | "danger" {
  if (score < 34) return "success";
  if (score < 67) return "warning";
  return "danger";
}

function confidenceAccent(confidence: AnalysisReport["confidence"]): "warning" | "neutral" | "success" {
  if (confidence === "faible") return "warning";
  if (confidence === "haute") return "success";
  return "neutral";
}

/** La confiance mesure la quantité de texte disponible pour les statistiques
 *  (seuils exacts dans scoring.ts : faible sous 300 mots ou 5 paragraphes,
 *  haute au-delà de 3000 mots ET 20 paragraphes) — ce n'est PAS une seconde
 *  note sur la fiabilité du score lui-même, d'où ce mémo pour éviter la
 *  confusion entre les deux nombres affichés côte à côte. */
function confidenceExplanation(confidence: AnalysisReport["confidence"]): string {
  if (confidence === "faible") {
    return "Confiance faible : ce document est trop court (moins de 300 mots ou 5 paragraphes) pour que les statistiques soient significatives — le score ci-contre est peu fiable, quel qu'il soit.";
  }
  if (confidence === "haute") {
    return "Confiance haute : ce document est assez long (plus de 3000 mots et 20 paragraphes) pour que les statistiques du texte soient significatives.";
  }
  return "Confiance moyenne : ce document a une longueur intermédiaire — ni trop court pour fausser les statistiques, ni assez long pour une confiance maximale.";
}

function severityRank(s: SignalSeverity): number {
  return { eleve: 0, moyen: 1, faible: 2, info: 3 }[s];
}

function sortedFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    const rank = severityRank(a.severity) - severityRank(b.severity);
    return rank !== 0 ? rank : b.weight - a.weight;
  });
}

function severityAccent(s: SignalSeverity): "neutral" | "info" | "warning" | "danger" {
  switch (s) {
    case "eleve":
      return "danger";
    case "moyen":
      return "warning";
    case "faible":
      return "info";
    case "info":
      return "neutral";
  }
}

function severityLabel(s: SignalSeverity): string {
  switch (s) {
    case "eleve":
      return "Élevé";
    case "moyen":
      return "Moyen";
    case "faible":
      return "Faible";
    case "info":
      return "Info";
  }
}

function FindingCard({
  finding,
  onShowInDocument,
}: {
  finding: Finding;
  onShowInDocument?: (id: string, paragraphIndex: number | undefined) => void;
}) {
  const canShow = onShowInDocument && finding.location.paragraphIndex != null;
  return (
    <article className="det-finding">
      <div className="det-finding__head">
        <Badge accent={severityAccent(finding.severity)}>{severityLabel(finding.severity)}</Badge>
        <span className="det-finding__location">{finding.location.label}</span>
        {canShow && (
          <button
            type="button"
            className="det-finding__show"
            onClick={() => onShowInDocument!(finding.id, finding.location.paragraphIndex)}
          >
            <Eye size={13} /> Voir dans le document
          </button>
        )}
      </div>
      <h3 className="det-finding__label">{finding.label}</h3>
      <p className="det-finding__explanation">{finding.explanation}</p>
      {finding.evidence && <blockquote className="det-finding__evidence">{finding.evidence}</blockquote>}
    </article>
  );
}

function MetadataList({ meta }: { meta: DocumentMetadata }) {
  const rows: [string, string][] = [];
  if (meta.title) rows.push(["Titre", meta.title]);
  if (meta.author) rows.push(["Auteur", meta.author]);
  if (meta.creator) rows.push(["Application", meta.creator]);
  if (meta.producer) rows.push(["Producteur", meta.producer]);
  if (meta.createdAt) rows.push(["Créé le", new Date(meta.createdAt).toLocaleString("fr-FR")]);
  if (meta.modifiedAt) rows.push(["Modifié le", new Date(meta.modifiedAt).toLocaleString("fr-FR")]);
  if (meta.editingMinutes != null) rows.push(["Temps d'édition cumulé", `${meta.editingMinutes} min`]);
  if (meta.revisionCount != null) rows.push(["Révisions", String(meta.revisionCount)]);
  if (meta.pageCount != null) rows.push(["Pages", String(meta.pageCount)]);
  if (rows.length === 0) return null;
  return (
    <dl className="det-meta-grid">
      {rows.map(([k, v]) => (
        <div className="det-meta-row" key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function CategoryPanel({
  category,
  metadata,
  onShowInDocument,
}: {
  category: CategoryReport;
  metadata?: DocumentMetadata;
  onShowInDocument?: (id: string, paragraphIndex: number | undefined) => void;
}) {
  const findings = sortedFindings(category.findings);
  return (
    <div className="det-category">
      <div className="det-category__score">
        Score de la catégorie : <strong>{category.score}</strong> / 100
      </div>
      {metadata && <MetadataList meta={metadata} />}
      {findings.length === 0 ? (
        <EmptyState title="Aucun signal détecté dans cette catégorie." />
      ) : (
        <div className="det-findings">
          {findings.map((f) => (
            <FindingCard key={f.id} finding={f} onShowInDocument={onShowInDocument} />
          ))}
        </div>
      )}
    </div>
  );
}

function SensitivitySettings({
  open,
  onToggleOpen,
  disabledSignals,
  onToggleSignal,
}: {
  open: boolean;
  onToggleOpen: () => void;
  disabledSignals: Set<string>;
  onToggleSignal: (id: string) => void;
}) {
  const grouped = signalsByCategory();
  const disabledCount = disabledSignals.size;
  return (
    <div className="det-sensitivity">
      <button type="button" className="det-sensitivity__toggle" onClick={onToggleOpen} aria-expanded={open}>
        <span>
          Réglages de sensibilité
          {disabledCount > 0 && <span className="det-sensitivity__count">{disabledCount} désactivé(s)</span>}
        </span>
        <span className="det-sensitivity__chevron">{open ? "−" : "+"}</span>
      </button>
      {open && (
        <div className="det-sensitivity__body">
          <p className="det-sensitivity__hint">
            Désactivez un signal qui produit trop de faux positifs pour ce type de document (ex. un document
            technique qui utilise légitimement beaucoup de listes). Un signal désactivé n'apparaît plus dans le
            rapport et ne compte plus dans le score. Ce choix est mémorisé sur cet appareil.
          </p>
          {(Object.keys(CATEGORY_TITLES) as SignalCategory[])
            .filter((cat) => cat !== "plagiat" && grouped[cat]?.length)
            .map((cat) => (
              <div className="det-sensitivity__group" key={cat}>
                <h4>{CATEGORY_TITLES[cat]}</h4>
                {grouped[cat].map((entry: SignalCatalogEntry) => (
                  <label className="checkbox-row det-sensitivity__row" key={entry.id}>
                    <input
                      type="checkbox"
                      checked={!disabledSignals.has(entry.id)}
                      onChange={() => onToggleSignal(entry.id)}
                    />
                    <span>
                      {entry.label}
                      {!entry.affectsScore && <span className="det-sensitivity__badge">informatif</span>}
                      <span className="det-sensitivity__desc">{entry.description}</span>
                    </span>
                  </label>
                ))}
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

function PlagiarismPanel({
  result,
  totalParagraphs,
  onShowInDocument,
}: {
  result: NonNullable<AnalysisReport["plagiarism"]>;
  totalParagraphs: number;
  onShowInDocument?: (id: string, paragraphIndex: number | undefined) => void;
}): ReactNode {
  return (
    <div className="det-category">
      <p className="det-plagiarism-summary">
        {result.checkedPassages} passage(s) vérifié(s) sur {totalParagraphs} paragraphe(s) du document,{" "}
        {result.matches.length} correspondance(s) trouvée(s) via {result.provider}.
      </p>
      {result.matches.length === 0 ? (
        <EmptyState title="Aucune correspondance trouvée sur le web." />
      ) : (
        <div className="det-findings">
          {result.matches.map((m, i) => (
            <article className="det-finding" key={`${m.paragraphIndex}-${i}`}>
              <div className="det-finding__head">
                <Badge accent="warning">{Math.round(m.similarity * 100)}% de similarité</Badge>
                <span className="det-finding__location">Paragraphe {m.paragraphIndex + 1}</span>
                {onShowInDocument && (
                  <button
                    type="button"
                    className="det-finding__show"
                    onClick={() => onShowInDocument(`plagiat-${m.paragraphIndex}-${i}`, m.paragraphIndex)}
                  >
                    <Eye size={13} /> Voir dans le document
                  </button>
                )}
              </div>
              <h3 className="det-finding__label">{m.sourceTitle || m.url}</h3>
              <blockquote className="det-finding__evidence">{m.passage}</blockquote>
              <a className="det-plagiarism-link" href={m.url} target="_blank" rel="noreferrer">
                {m.url} <ExternalLink size={13} />
              </a>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
