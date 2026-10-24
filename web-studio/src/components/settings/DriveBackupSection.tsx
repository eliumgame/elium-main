/** Réglages → Sauvegarde : état et pilotage de la sauvegarde incrémentale de l'espace de travail dans le Drive entreprise. */
import { useEffect, useMemo, useState } from "react";
import { Cloud, Download, Upload } from "lucide-react";
import { Alert, Button } from "../../ui/components";
import { readAutoOr, writeAuto } from "../../drive-cloud/named-file";
import type { OpsCtx } from "../../drive-cloud/ops";
import { useDrive } from "../../drive-cloud/session";
import { AUTO_EVENT, WORKSPACE_SLOT } from "../../workspace/drive-backup";
import { flushNow, recheck, useSyncStatus } from "../../workspace/sync-controller";
import { EXTRA_PIECES } from "../../workspace/extras";
import { OPEN_RESTORE_EVENT } from "../DriveSyncUi";
import type { WorkspaceSettingsBridge } from "./WorkspaceSection";

export default function DriveBackupSection({ bridge }: { bridge: WorkspaceSettingsBridge }) {
  const d = useDrive();
  const s = useSyncStatus();
  const ctx = useMemo<OpsCtx | null>(() => {
    if (!d.keys || !d.user || !d.currentOrg) return null;
    return {
      api: d.api,
      keys: d.keys,
      userId: d.user.id,
      orgId: d.currentOrg.id,
      orgPublicHex: d.currentOrg.orgPublicHex,
      roleIdByKey: d.roleIdByKey,
    };
  }, [d.api, d.keys, d.user, d.currentOrg, d.roleIdByKey]);
  const [pw, setPw] = useState("");
  const [auto, setAuto] = useState(false);
  const required = d.policy?.backupRequired === true;
  const ctxId = ctx ? `${ctx.userId}:${ctx.orgId}` : "";
  useEffect(() => {
    if (ctx) setAuto(readAutoOr(WORKSPACE_SLOT, ctx, d.policy != null));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- changement de compte / d'organisation uniquement
  }, [ctxId]);

  const busy = s.phase === "syncing" || s.phase === "checking";
  const restore = async () => {
    await recheck();
    window.dispatchEvent(new Event(OPEN_RESTORE_EVENT));
  };

  return (
    <section className="settings__card" aria-labelledby="drive-backup-title">
      <h3 id="drive-backup-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Cloud size={16} aria-hidden="true" /> Sauvegarde dans le Drive entreprise
      </h3>
      <p className="muted">
        Chaque document, tableur, présentation et PDF est enregistré dans le dossier « Sauvegarde Elium » de votre
        Drive, chiffré de bout en bout et versionné par le serveur — seul ce qui change est renvoyé. Sont aussi
        sauvegardés : dossiers, favoris, étiquettes, corbeille, réglages,{" "}
        {EXTRA_PIECES.map((p) => p.label.toLowerCase()).join(", ")}. Sur un nouvel appareil, la restauration vous est
        proposée dès la connexion. Les clés privées et l'identité de signature ne quittent jamais cet appareil.
      </p>
      {!ctx ? (
        d.status === "locked" ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (pw) void d.unlock(pw).then(() => setPw(""));
            }}
            style={{ display: "flex", flexDirection: "column", gap: 8 }}
          >
            <p className="muted">
              Session Drive verrouillée (les clés ne sont jamais conservées) : saisissez votre mot de passe.
            </p>
            <div className="settings__row">
              <input
                className="input"
                type="password"
                autoComplete="current-password"
                aria-label="Mot de passe du Drive"
                value={pw}
                onChange={(e) => setPw(e.target.value)}
              />
              <Button type="submit" size="sm" disabled={!pw || d.busy}>
                Déverrouiller
              </Button>
            </div>
            {d.error && <Alert tone="danger">{d.error}</Alert>}
          </form>
        ) : (
          <Alert tone="info">
            Vous n'êtes pas connecté au Drive entreprise : ouvrez « Drive entreprise » depuis l'accueil et
            connectez-vous, puis revenez ici.
          </Alert>
        )
      ) : (
        <>
          <p className="muted">
            Connecté : {d.user?.email}
            {d.currentOrg ? ` — ${d.currentOrg.name}` : ""}.{" "}
            {s.lastOkAt
              ? `Dernière sauvegarde : ${new Date(s.lastOkAt).toLocaleString("fr-FR")}.`
              : "Aucune sauvegarde pour l'instant."}{" "}
            {s.pending > 0 && `${s.pending} modification(s) en attente.`}
          </p>
          <div className="settings__row">
            <Button size="sm" onClick={() => void flushNow()} disabled={busy || !bridge.ws.ready}>
              <Upload size={14} /> Sauvegarder maintenant
            </Button>
            <Button size="sm" variant="outline" onClick={() => void restore()} disabled={busy}>
              <Download size={14} /> Restaurer depuis le Drive
            </Button>
          </div>
          <label className="settings__row">
            <input
              type="checkbox"
              checked={auto || required}
              disabled={required}
              onChange={(e) => {
                setAuto(e.target.checked);
                writeAuto(WORKSPACE_SLOT, ctx, e.target.checked);
                window.dispatchEvent(new Event(AUTO_EVENT));
              }}
            />
            Sauvegarder automatiquement quelques secondes après chaque modification
            {required && <span className="muted"> — imposé par le propriétaire de ce Drive</span>}
          </label>
          {busy && <p className="muted">Synchronisation en cours…</p>}
          {s.phase === "needs-restore" && (
            <Alert tone="warning" title="Une sauvegarde existe dans le Drive">
              L'envoi est en pause tant que vous n'avez pas choisi de la restaurer ou de repartir à neuf.
              <div className="settings__row">
                <Button size="sm" onClick={() => window.dispatchEvent(new Event(OPEN_RESTORE_EVENT))}>
                  Choisir
                </Button>
              </div>
            </Alert>
          )}
          {s.phase === "offline" && <Alert tone="warning">{s.message}</Alert>}
          {s.phase === "error" && <Alert tone="danger">{s.message}</Alert>}
          {s.phase === "locked" && <Alert tone="warning">{s.message}</Alert>}
          {s.phase === "idle" && s.message && <Alert tone="info">{s.message}</Alert>}
        </>
      )}
    </section>
  );
}
