/**
 * Passeport professionnel BTS Gestion de la PME — épreuve E4.
 * Vue autonome (comme le Détecteur) : tableau de bord, fiches de situation,
 * passeport synoptique, référentiel, contexte commercial et stages.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, GraduationCap, Loader2, Lock } from "lucide-react";
import type { VaultSecret } from "../../crypto/local-vault";
import { downloadBlob } from "../../export/exporters";
import { Alert, Badge, Button, Tabs } from "../../ui/components";
import { useDialogs } from "../../ui/dialogs";
import { reportError } from "../../ui/crash-log";
import { buildFicheDocx, ficheFileName } from "../exportFiche";
import {
  buildAttestationPdf,
  buildContextePdf,
  buildDossierPdf,
  buildFichePdf,
  buildSynopticPdf,
  loadFonts,
} from "../pdf";
import { backupJson, buildSynopticDocx, parseBackup } from "../exportPasseport";
import {
  dossierProgress,
  dossierChecklist,
  duplicateSituation,
  emptyPassport,
  newSituation,
  nextSituationId,
  prefillSolutions,
  normalizePassport,
  spLabel,
  transferIssues,
  transferSituation,
  untransferSituation,
} from "../model";
import { safeStem } from "../print";
import type { Holder, PassportData, Situation } from "../types";
import Dashboard, { type TabId } from "./Dashboard";
import PassportTab from "./PassportTab";
import ReferentielTab from "./ReferentielTab";
import SituationEditor from "./SituationEditor";
import SituationsList from "./SituationsList";
import { ContexteTab, StagesTab } from "./ContexteStagesTabs";
import { usePassport } from "./usePassport";
import DriveSyncSection from "./DriveSyncSection";
import FileSyncSection from "./FileSyncSection";
import "./PassportView.css";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

interface Props {
  onHome: () => void;
  onOpenDrive?: () => void;
  vaultSecret?: VaultSecret;
}

export default function PassportView({ onHome, onOpenDrive, vaultSecret }: Props) {
  const { data, status, saveStatus, update, replace } = usePassport(vaultSecret);
  const { prompt, confirm, alert } = useDialogs();
  const [tab, setTab] = useState<TabId>("dashboard");
  const [editing, setEditing] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [allDomains, setAllDomains] = useState(false);

  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(id);
  }, [notice]);

  const goto = useCallback((t: TabId) => {
    setTab(t);
    setEditing(null);
  }, []);

  const guard = useCallback(
    async <T,>(source: string, fn: () => T | Promise<T>): Promise<T | undefined> => {
      try {
        return await fn();
      } catch (e) {
        reportError(`passeport.${source}`, e);
        await alert({ title: "Opération impossible", message: e instanceof Error ? e.message : String(e) });
        return undefined;
      }
    },
    [alert],
  );

  const sit = useMemo(() => data?.situations.find((s) => s.id === editing) ?? null, [data, editing]);

  if (status === "loading")
    return (
      <div className="pp-page">
        <div className="pp-loading">
          <Loader2 className="pp-spin" size={24} /> Chargement du passeport…
        </div>
      </div>
    );
  if (status === "locked" || status === "error" || !data)
    return (
      <div className="pp-page">
        <Header onHome={onHome} saveStatus="saved" />
        <div className="pp-body">
          {status === "locked" ? (
            <Alert tone="warning" title="Passeport protégé par le coffre local">
              <Lock size={14} /> Déverrouillez le coffre local (Réglages → Sécurité) puis revenez ici : le passeport est
              chiffré au repos et ne peut pas être lu sans lui.
            </Alert>
          ) : (
            <Alert tone="danger" title="Impossible de lire le passeport">
              Les données locales n'ont pas pu être chargées. Consultez le journal d'incidents dans les réglages.
            </Alert>
          )}
        </div>
      </div>
    );

  // ---------------------------------------------------------------- actions
  const setHolder = (patch: Partial<Holder>) => update((d) => ({ ...d, holder: { ...d.holder, ...patch } }));
  const editSituation = (id: number, fn: (s: Situation) => Situation) =>
    update((d) => ({ ...d, situations: d.situations.map((s) => (s.id === id ? fn(s) : s)) }));

  const createSituation = () => {
    const id = nextSituationId(data.situations);
    update((d) => ({ ...d, situations: [...d.situations, newSituation(id)] }));
    setTab("situations");
    setEditing(id);
  };

  const duplicate = async (id: number) => {
    const src = data.situations.find((s) => s.id === id);
    if (!src) return;
    const v = await prompt({
      title: `Dupliquer la fiche ${spLabel(id)}`,
      label: "Numéro de la nouvelle situation",
      defaultValue: String(nextSituationId(data.situations)),
      hint: "Le transfert vers le passeport est à refaire pour la copie.",
      confirmLabel: "Dupliquer",
    });
    if (v === null) return;
    const n = Number(v.replace(/^SP/i, "").trim());
    if (!Number.isInteger(n) || n < 1)
      return void (await alert({ title: "Numéro invalide", message: "Saisissez un entier positif." }));
    if (data.situations.some((s) => s.id === n))
      return void (await alert({ title: "Numéro déjà utilisé", message: `La fiche ${spLabel(n)} existe déjà.` }));
    update((d) => ({ ...d, situations: [...d.situations, duplicateSituation(src, n)].sort((a, b) => a.id - b.id) }));
    setNotice(`${spLabel(n)} créée à partir de ${spLabel(id)}.`);
    setTab("situations");
    setEditing(n);
  };

  const remove = async (id: number) => {
    const s = data.situations.find((x) => x.id === id);
    if (!s) return;
    const ok = await confirm({
      title: `Supprimer la fiche ${spLabel(id)} ?`,
      message: s.transfer
        ? "Elle est validée dans le passeport : ses activités et tâches seront retirées du passeport."
        : "Cette action est définitive.",
      confirmLabel: "Supprimer",
      danger: true,
    });
    if (!ok) return;
    update((d) => ({ ...d, situations: d.situations.filter((x) => x.id !== id) }));
    if (editing === id) setEditing(null);
    setNotice(`${spLabel(id)} supprimée.`);
  };

  const transfer = async (id: number) => {
    const s = data.situations.find((x) => x.id === id);
    if (!s) return;
    const done = transferSituation(s);
    if (!done) {
      const msg = transferIssues(s)
        .map((i) => i.message)
        .join(" ");
      await alert({ title: "Transfert impossible", message: msg });
      setEditing(id);
      setTab("situations");
      return;
    }
    editSituation(id, () => done);
    const warns = transferIssues(done).filter((i) => i.level === "warning");
    setNotice(
      `${spLabel(id)} validée dans le passeport.${warns.length ? ` Attention : ${warns.map((w) => w.message).join(" ")}` : ""}`,
    );
  };

  const docx = (id: number) =>
    guard("docx", () => {
      const s = data.situations.find((x) => x.id === id);
      if (!s) return;
      downloadBlob(ficheFileName(data.holder, s, "docx"), DOCX_MIME, buildFicheDocx(data.holder, s));
      setNotice(`Fiche d'analyse ${spLabel(id)} générée (Word).`);
    });

  const stem = safeStem([data.holder.nom, data.holder.prenom].filter(Boolean).join("_") || "candidat");

  const importFile = async (f: File) => {
    await guard("import", async () => {
      let parsed: PassportData | null = null;
      try {
        parsed = normalizePassport(parseBackup(await f.text()));
      } catch {
        parsed = null; // JSON illisible : même message que pour un fichier d'un autre format
      }
      if (!parsed)
        return void (await alert({
          title: "Fichier non reconnu",
          message: "Ce n'est pas une sauvegarde de passeport Elium.",
        }));
      const ok = await confirm({
        title: "Remplacer le passeport actuel ?",
        message: `La sauvegarde contient ${parsed.situations.length} situation(s). Le passeport actuel sera remplacé.`,
        confirmLabel: "Remplacer",
        danger: true,
      });
      if (!ok) return;
      await replace(parsed);
      setEditing(null);
      setNotice("Sauvegarde importée.");
    });
  };

  const reset = async () => {
    const ok = await confirm({
      title: "Tout réinitialiser ?",
      message: "Identité, situations, contexte et stages seront effacés. Pensez à exporter une sauvegarde avant.",
      confirmLabel: "Tout effacer",
      danger: true,
    });
    if (!ok) return;
    await replace(emptyPassport());
    setEditing(null);
    setNotice("Passeport réinitialisé.");
  };

  const progress = dossierProgress(dossierChecklist(data));
  const tabs: { id: TabId; label: string }[] = [
    { id: "dashboard", label: "Tableau de bord" },
    { id: "situations", label: `Situations (${data.situations.length})` },
    { id: "passport", label: "Passeport" },
    { id: "referentiel", label: "Référentiel" },
    { id: "contexte", label: "Contexte commercial" },
    { id: "stages", label: `Stages et alternance (${data.stages.length})` },
  ];
  const openSituation = (id: number) => {
    setTab("situations");
    setEditing(id);
  };

  return (
    <div className="pp-page">
      <Header onHome={onHome} saveStatus={saveStatus} progress={progress} />
      <Tabs tabs={tabs} active={tab} onChange={(id) => goto(id as TabId)} />
      {notice && (
        <div className="pp-notice" role="status">
          {notice}
        </div>
      )}
      <div className="pp-body">
        {tab === "dashboard" && (
          <Dashboard
            data={data}
            onHolder={setHolder}
            onGoto={goto}
            onNewSituation={createSituation}
            onBackup={() => downloadBlob(`Passeport_GPME_${stem}.json`, "application/json", backupJson(data))}
            onImport={(f) => void importFile(f)}
            onReset={() => void reset()}
            extra={
              <>
                <FileSyncSection data={data} />
                <DriveSyncSection
                  data={data}
                  onRestore={async (next) => {
                    await replace(next);
                    setEditing(null);
                    setNotice("Passeport restauré depuis le Drive.");
                  }}
                  onOpenDrive={onOpenDrive}
                />
              </>
            }
          />
        )}
        {tab === "situations" &&
          (sit ? (
            <SituationEditor
              situation={sit}
              onChange={(fn) => editSituation(sit.id, fn)}
              onBack={() => setEditing(null)}
              onTransfer={() => void transfer(sit.id)}
              onUntransfer={() => {
                editSituation(sit.id, untransferSituation);
                setNotice(`${spLabel(sit.id)} retirée du passeport.`);
              }}
              onDocx={() => void docx(sit.id)}
              onPdf={() =>
                void guard("pdf", async () => {
                  downloadBlob(
                    ficheFileName(data.holder, sit, "pdf"),
                    "application/pdf",
                    await buildFichePdf(data.holder, sit, await loadFonts()),
                  );
                })
              }
              onDuplicate={() => void duplicate(sit.id)}
              onDelete={() => void remove(sit.id)}
            />
          ) : (
            <SituationsList
              situations={data.situations}
              onOpen={setEditing}
              onNew={createSituation}
              onDuplicate={(id) => void duplicate(id)}
              onDelete={(id) => void remove(id)}
              onTransfer={(id) => void transfer(id)}
              onDocx={(id) => void docx(id)}
            />
          ))}
        {tab === "passport" && (
          <PassportTab
            data={data}
            onVisa={(visa) => update((d) => ({ ...d, visa }))}
            onDocx={() =>
              void guard("synoptic", () =>
                downloadBlob(
                  `Passeport_professionnel_${stem}.docx`,
                  DOCX_MIME,
                  buildSynopticDocx(data, { allDomains }),
                ),
              )
            }
            onPdf={() =>
              void guard("pdf", async () =>
                downloadBlob(
                  `Passeport_professionnel_${stem}.pdf`,
                  "application/pdf",
                  await buildSynopticPdf(data, await loadFonts(), { allDomains }),
                ),
              )
            }
            onDossier={() =>
              void guard("pdf", async () =>
                downloadBlob(
                  `Dossier_E4_${stem}.pdf`,
                  "application/pdf",
                  await buildDossierPdf(data, await loadFonts(), { allDomains, onlyValidated: true }),
                ),
              )
            }
            allDomains={allDomains}
            onAllDomains={setAllDomains}
            onSolutions={(id, text) => update((d) => ({ ...d, solutions: { ...d.solutions, [id]: text } }))}
            onPrefillSolutions={() => update((d) => ({ ...d, solutions: prefillSolutions(d) }))}
            onOpenSituation={openSituation}
          />
        )}
        {tab === "referentiel" && <ReferentielTab data={data} onOpenSituation={openSituation} />}
        {tab === "contexte" && (
          <ContexteTab
            items={data.contexte}
            onChange={(contexte) => update((d: PassportData) => ({ ...d, contexte }))}
            onPrint={() =>
              void guard("pdf", async () =>
                downloadBlob(
                  `Contexte_commercial_${stem}.pdf`,
                  "application/pdf",
                  await buildContextePdf(data, await loadFonts()),
                ),
              )
            }
          />
        )}
        {tab === "stages" && (
          <StagesTab
            data={data}
            onParcours={(parcours) => update((d) => ({ ...d, parcours }))}
            onChange={(stages) => update((d) => ({ ...d, stages }))}
            onPrint={(st) =>
              void guard("pdf", async () =>
                downloadBlob(
                  `Attestation_de_stage_${stem}.pdf`,
                  "application/pdf",
                  await buildAttestationPdf(data.holder, st, data.holder.session, await loadFonts()),
                ),
              )
            }
          />
        )}
      </div>
    </div>
  );
}

function Header({
  onHome,
  saveStatus,
  progress,
}: {
  onHome: () => void;
  saveStatus: "saved" | "saving" | "error";
  progress?: number;
}) {
  return (
    <header className="pp-header">
      <Button variant="ghost" size="sm" className="pp-header__back" onClick={onHome}>
        <ArrowLeft size={16} /> Accueil
      </Button>
      <div className="pp-header__titles">
        <h1 className="pp-header__title">
          <GraduationCap size={22} aria-hidden="true" /> Passeport professionnel E4
        </h1>
        <p className="pp-header__subtitle">
          BTS Gestion de la PME — Gérer les relations avec les clients et les fournisseurs
        </p>
      </div>
      <div className="pp-header__status" aria-live="polite">
        {progress !== undefined && <Badge accent={progress === 100 ? "success" : "info"}>Dossier {progress} %</Badge>}
        <span className={`pp-save pp-save--${saveStatus}`}>
          {saveStatus === "saved"
            ? "Enregistré"
            : saveStatus === "saving"
              ? "Enregistrement…"
              : "Échec de l'enregistrement"}
        </span>
      </div>
    </header>
  );
}
