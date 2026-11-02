/**
 * Passeport chiffré illisible avec le coffre actuel (coffre réinitialisé, désactivé ou recréé avec un autre mot de
 * passe). Rien n'est effacé sans demande explicite : l'élève peut réessayer avec l'ancien mot de passe, garder une
 * copie brute chiffrée, ou repartir à zéro après confirmation.
 */
import { useState } from "react";
import { KeyRound } from "lucide-react";
import type { VaultSecret } from "../../crypto/local-vault";
import { downloadBlob } from "../../export/exporters";
import { Alert, Button } from "../../ui/components";
import { reportError } from "../../ui/crash-log";
import { useDialogs } from "../../ui/dialogs";
import { discardPassport, exportRawPassport, recoverPassport } from "../store";

interface Props {
  reason: "no-vault" | "wrong-secret" | null;
  vaultSecret?: VaultSecret;
  onDone: () => void;
}

export default function UnreadablePassport({ reason, vaultSecret, onDone }: Props) {
  const { prompt, confirm, alert } = useDialogs();
  const [busy, setBusy] = useState(false);
  const [exported, setExported] = useState(false);

  const act = async (source: string, fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      reportError(`passeport.recovery.${source}`, e);
      await alert({ title: "Opération impossible", message: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const retry = () =>
    act("retry", async () => {
      const pwd = await prompt({
        title: "Ancien mot de passe du coffre",
        label: "Mot de passe utilisé quand le passeport a été enregistré",
        password: true,
        confirmLabel: "Déchiffrer",
      });
      if (!pwd) return;
      await recoverPassport({ password: pwd }, vaultSecret);
      onDone();
    });

  const exportRaw = () =>
    act("export", async () => {
      const stamp = new Date().toISOString().slice(0, 10);
      downloadBlob(`Passeport_GPME_chiffre_${stamp}.json`, "application/json", await exportRawPassport());
      setExported(true);
    });

  const reset = () =>
    act("reset", async () => {
      const ok = await confirm({
        title: "Repartir d'un passeport vide ?",
        message:
          (exported ? "" : "Vous n'avez pas exporté la copie chiffrée. ") +
          "Le passeport chiffré et ses annexes seront définitivement supprimés de ce poste : sans l'ancien mot de passe, " +
          "ils ne pourront plus être récupérés. Une sauvegarde JSON ou la copie sur le serveur peut ensuite être réimportée.",
        confirmLabel: "Supprimer et repartir à zéro",
        danger: true,
      });
      if (!ok) return;
      await discardPassport();
      onDone();
    });

  return (
    <Alert tone="warning" title="Passeport chiffré illisible avec le coffre actuel">
      <p>
        {reason === "no-vault"
          ? "Votre passeport a été chiffré par un coffre local qui a depuis été réinitialisé ou supprimé sur ce poste."
          : "Votre passeport a été chiffré avec un autre mot de passe que celui du coffre local actuel (coffre recréé ?)."}{" "}
        Il est toujours enregistré, intact : rien n'a été effacé.
      </p>
      <ul>
        <li>Si vous vous souvenez de l'ancien mot de passe du coffre, déchiffrez-le pour le retrouver.</li>
        <li>Sinon, gardez-en une copie chiffrée (au cas où le mot de passe vous reviendrait), puis repartez à zéro.</li>
      </ul>
      <div className="pp-actions">
        <Button onClick={() => void retry()} disabled={busy}>
          <KeyRound size={14} aria-hidden="true" /> Réessayer avec l'ancien mot de passe
        </Button>
        <Button variant="outline" onClick={() => void exportRaw()} disabled={busy}>
          Exporter la copie chiffrée
        </Button>
        <Button variant="ghost" onClick={() => void reset()} disabled={busy}>
          Repartir à zéro…
        </Button>
      </div>
    </Alert>
  );
}
