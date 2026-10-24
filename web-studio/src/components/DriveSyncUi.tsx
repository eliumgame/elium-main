/**
 * Interface de la sauvegarde Drive : pastille d'état toujours visible (enregistré / en attente /
 * hors ligne / en pause), invite de restauration à la première connexion sur un appareil sans données,
 * bouton « Enregistrer dans le Drive » des éditeurs.
 */
import { useEffect, useState } from "react";
import { AlertTriangle, Check, Cloud, CloudOff, Loader2, RotateCcw } from "lucide-react";
import { Alert, Button, Modal } from "../ui/components";
import { useDialogs } from "../ui/dialogs";
import { reportError } from "../ui/crash-log";
import type { ConflictChoice } from "../workspace/backup";
import { planBackupRestore } from "../workspace/backup";
import {
  dismissRestorePrompt,
  flushNow,
  restoreFromProbe,
  saveItemToDrive,
  startFresh,
  useSyncStatus,
} from "../workspace/sync-controller";
import type { WorkspaceApi } from "../workspace/useWorkspace";
import "./drive-sync.css";

const when = (iso?: string) => (iso ? new Date(iso).toLocaleString("fr-FR") : "");
export const OPEN_RESTORE_EVENT = "elium-open-restore-prompt";

export function DriveSyncUi({ ws }: { ws: WorkspaceApi }) {
  return (
    <>
      <SyncPill />
      <RestorePrompt ws={ws} />
    </>
  );
}

/** Pastille d'état de la sauvegarde (bas-gauche). Masquée hors session Drive. */
export function SyncPill() {
  const s = useSyncStatus();
  if (s.phase === "off") return null;
  let tone = "ok";
  let icon = <Check size={13} aria-hidden="true" />;
  let label = s.lastOkAt ? `Enregistré dans le Drive · ${when(s.lastOkAt)}` : "Drive connecté";
  switch (s.phase) {
    case "checking":
    case "syncing":
      tone = "busy";
      icon = <Loader2 size={13} className="icon-spin" aria-hidden="true" />;
      label = s.phase === "checking" ? "Vérification du Drive…" : "Enregistrement dans le Drive…";
      break;
    case "pending":
      tone = "warn";
      icon = <Cloud size={13} aria-hidden="true" />;
      label = `${s.pending} modification${s.pending > 1 ? "s" : ""} en attente d'envoi`;
      break;
    case "offline":
      tone = "warn";
      icon = <CloudOff size={13} aria-hidden="true" />;
      label = `Hors ligne — ${s.pending || "des"} modification${s.pending > 1 ? "s" : ""} gardée${s.pending > 1 ? "s" : ""} en attente`;
      break;
    case "needs-restore":
      tone = "warn";
      icon = <RotateCcw size={13} aria-hidden="true" />;
      label = "Sauvegarde du Drive à restaurer — envoi en pause";
      break;
    case "locked":
      tone = "warn";
      icon = <AlertTriangle size={13} aria-hidden="true" />;
      label = "Coffre local verrouillé — sauvegarde en pause";
      break;
    case "error":
      tone = "err";
      icon = <AlertTriangle size={13} aria-hidden="true" />;
      label = s.message ? `Sauvegarde Drive : ${s.message}` : "Sauvegarde Drive en échec";
      break;
    case "idle":
      if (!s.auto && !s.required) label = "Drive connecté · sauvegarde automatique désactivée";
      break;
  }
  const act =
    s.phase === "needs-restore"
      ? () => window.dispatchEvent(new Event(OPEN_RESTORE_EVENT))
      : s.phase === "pending" || s.phase === "error" || s.phase === "offline"
        ? () => void flushNow()
        : undefined;
  return (
    <button
      type="button"
      className={`sync-pill sync-pill--${tone}`}
      role="status"
      aria-live="polite"
      title={act ? "Cliquer pour agir" : label}
      onClick={act}
      disabled={!act}
      data-testid="sync-pill"
      data-phase={s.phase}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

/** Bouton « Enregistrer dans le Drive » d'un éditeur : l'élément est envoyé tout de suite, chiffré, versionné. */
export function SaveToDriveButton({
  itemId,
  className,
  size = "sm",
  variant = "outline",
  label = "Enregistrer dans le Drive",
  onDone,
  beforeSave,
}: {
  itemId: string | null | undefined;
  className?: string;
  size?: "sm" | "md";
  variant?: "outline" | "ghost" | "primary";
  label?: string;
  onDone?: (ok: boolean, message: string) => void;
  /** Écrit d'abord le contenu courant de l'éditeur dans la bibliothèque locale (renvoie l'identifiant à envoyer). */
  beforeSave?: () => Promise<string | null | undefined | void>;
}) {
  const s = useSyncStatus();
  const { alert } = useDialogs();
  const [busy, setBusy] = useState(false);
  const connected = s.phase !== "off";
  const click = async () => {
    if (!connected) {
      await alert({
        title: "Drive non connecté",
        message:
          "Connectez-vous (ou déverrouillez) votre Drive entreprise depuis l'accueil, puis réessayez : l'élément y sera enregistré, chiffré et versionné.",
      });
      return;
    }
    if (!itemId && !beforeSave) {
      await alert({
        title: "Enregistrez d'abord",
        message: "Cet élément n'est pas encore dans votre bibliothèque : utilisez « Enregistrer » une première fois.",
      });
      return;
    }
    setBusy(true);
    try {
      const flushed = beforeSave ? await beforeSave() : undefined;
      const id = flushed || itemId;
      if (!id) {
        onDone?.(false, "Rien à enregistrer pour l'instant : l'élément est encore vierge.");
        return;
      }
      const r = await saveItemToDrive(id);
      if (r.ok) onDone?.(true, "Enregistré dans le Drive.");
      else if (r.reason === "needs-restore") {
        window.dispatchEvent(new Event(OPEN_RESTORE_EVENT));
        onDone?.(false, "Une sauvegarde existe déjà dans le Drive : restaurez-la ou repartez à neuf d'abord.");
      } else
        onDone?.(
          false,
          r.reason === "offline"
            ? "Hors ligne : l'élément partira dès le retour du réseau."
            : "L'enregistrement dans le Drive a échoué : réessayez.",
        );
    } catch (e) {
      reportError("save-to-drive", e);
      onDone?.(false, e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button
      size={size}
      variant={variant}
      className={className}
      disabled={busy}
      onClick={() => void click()}
      data-testid="save-to-drive"
      title={connected ? "Chiffré de bout en bout, versionné par le serveur" : "Connectez-vous au Drive pour l'activer"}
    >
      {busy ? <Loader2 size={14} className="icon-spin" /> : <Cloud size={14} />} {label}
    </Button>
  );
}

/** Invite affichée dès qu'une sauvegarde existe dans le Drive et que l'espace local n'en est pas réconcilié. */
function RestorePrompt({ ws }: { ws: WorkspaceApi }) {
  const s = useSyncStatus();
  const { alert, confirm } = useDialogs();
  const [hidden, setHidden] = useState(false);
  const [choice, setChoice] = useState<ConflictChoice>("keep_both");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const probe = s.probe;
  useEffect(() => {
    if (s.phase === "needs-restore") setHidden(false);
  }, [s.phase, probe]);
  useEffect(() => {
    const on = () => setHidden(false);
    window.addEventListener(OPEN_RESTORE_EVENT, on);
    return () => window.removeEventListener(OPEN_RESTORE_EVENT, on);
  }, []);
  if (s.phase !== "needs-restore" || !probe || hidden) return null;

  const localCount = ws.items.length;
  const remoteCount = probe.kind === "incremental" ? probe.items.length : 0;
  const conflicts =
    probe.kind === "incremental"
      ? planBackupRestore(
          ws.items,
          ws.folders,
          {
            items: probe.items,
            folders: probe.folders,
            contents: new Map(probe.items.map((i) => [`${i.contentStore}/${i.id}`, new Uint8Array(1)])),
          },
          choice,
        ).counts.conflicts
      : 0;

  const restore = async () => {
    setBusy(true);
    try {
      const r = await restoreFromProbe(choice, (d, t) => setProgress(`${d} / ${t}`));
      await ws.refresh();
      const lines = [
        `${r.added} élément(s) restauré(s)`,
        r.replaced ? `${r.replaced} remplacé(s)` : "",
        r.copied ? `${r.copied} copie(s) « (restauré) » ajoutée(s) à côté de vos versions locales` : "",
        r.extras
          ? `Brouillons, versions, polices, passeport… : ${r.extras} enregistrement(s) (${r.extraLabels.join(", ")})`
          : "",
        ...r.errors.map((e) => `⚠ ${e.title} — ${e.message}`),
      ].filter(Boolean);
      await alert({ title: "Espace de travail restauré", message: lines.join("\n") });
      if (r.settingsApplied || r.extras) {
        const ok = await confirm({
          title: "Recharger Elium ?",
          message: "Les réglages, polices et brouillons restaurés s'appliquent pleinement après un rechargement.",
          confirmLabel: "Recharger maintenant",
        });
        if (ok) window.location.reload();
      }
    } catch (e) {
      reportError("drive-restore", e);
      await alert({ title: "Restauration impossible", message: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
      setProgress("");
    }
  };

  const fresh = async () => {
    const ok = await confirm({
      title: "Repartir sans restaurer ?",
      message:
        "Votre espace actuel deviendra la référence : les éléments du Drive portant le même identifiant seront remplacés par vos versions locales (l'historique du Drive les conserve). Les autres éléments du Drive restent intacts.",
      confirmLabel: "Repartir à neuf",
      danger: true,
    });
    if (ok) startFresh();
  };

  return (
    <Modal
      title="Une sauvegarde existe dans votre Drive"
      onClose={() => {
        setHidden(true);
        dismissRestorePrompt();
      }}
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={() => void fresh()}>
            Repartir sans restaurer
          </Button>
          <Button disabled={busy} onClick={() => void restore()} data-testid="restore-apply">
            {busy ? <Loader2 size={14} className="icon-spin" /> : <RotateCcw size={14} />} Restaurer {progress}
          </Button>
        </>
      }
    >
      {probe.kind === "legacy" ? (
        <p>
          Une ancienne sauvegarde monolithique (« Espace-de-travail-Elium ») a été trouvée. Elle sera restaurée, puis
          remplacée par la sauvegarde incrémentale.
        </p>
      ) : (
        <p>
          Dernière sauvegarde : <strong>{when(probe.createdAt) || "date inconnue"}</strong> — {remoteCount} élément(s)
          et {probe.folders.length} dossier(s), plus vos brouillons, versions, polices et passeport.
        </p>
      )}
      <p>
        Cet appareil contient {localCount} élément(s).{" "}
        {localCount === 0
          ? "Retrouvez tout votre travail en un clic."
          : conflicts
            ? `${conflicts} élément(s) existent des deux côtés : choisissez ce qu'il advient.`
            : "Rien n'est supprimé localement : la restauration ajoute ce qui manque."}
      </p>
      {conflicts > 0 && (
        <label className="settings__row" style={{ display: "flex", gap: 8, alignItems: "center" }}>
          En cas de conflit :
          <select
            className="input"
            value={choice}
            onChange={(e) => setChoice(e.target.value as ConflictChoice)}
            aria-label="Gestion des conflits"
          >
            <option value="keep_both">Garder les deux (copie « (restauré) »)</option>
            <option value="replace">Remplacer ma version locale par celle du Drive</option>
            <option value="skip">Garder ma version locale</option>
          </select>
        </label>
      )}
      <Alert tone="info">
        L'envoi automatique reste en pause tant que vous n'avez pas choisi : aucune sauvegarde existante n'est écrasée
        sans votre accord.
      </Alert>
    </Modal>
  );
}
