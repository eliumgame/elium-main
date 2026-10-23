/** Réglages → Sauvegarde : envoyer tout l'espace de travail dans le Drive entreprise (à la demande ou en continu). */
import { useEffect, useMemo, useState } from "react";
import { Cloud, Download, Upload } from "lucide-react";
import { Alert, Button } from "../../ui/components";
import { reportError } from "../../ui/crash-log";
import { isConflict, readAuto, readLink, writeAuto, type DriveLink } from "../../drive-cloud/named-file";
import type { OpsCtx } from "../../drive-cloud/ops";
import { useDrive } from "../../drive-cloud/session";
import {
  AUTO_EVENT,
  AUTO_STATUS_EVENT,
  WORKSPACE_SLOT,
  pullWorkspace,
  pushWorkspace,
} from "../../workspace/drive-backup";
import { VaultLockedError, type BackupDeps } from "../../workspace/backup-io";
import type { BackupManifest, BackupSnapshot } from "../../workspace/backup";
import { RestoreDialog, makeBackupDeps, type WorkspaceSettingsBridge } from "./WorkspaceSection";

type Result = { kind: "idle" | "busy" | "ok" | "error" | "conflict"; message?: string; at?: string };

export default function DriveBackupSection({ bridge }: { bridge: WorkspaceSettingsBridge }) {
  const d = useDrive();
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
  const [link, setLink] = useState<DriveLink | null>(null);
  const [res, setRes] = useState<Result>({ kind: "idle" });
  const [pending, setPending] = useState<{ manifest: BackupManifest; snapshot: BackupSnapshot } | null>(null);
  const deps = (): BackupDeps => makeBackupDeps(bridge);

  const ctxId = ctx ? `${ctx.userId}:${ctx.orgId}` : "";
  useEffect(() => {
    if (!ctx) return;
    setAuto(readAuto(WORKSPACE_SLOT, ctx));
    setLink(readLink(WORKSPACE_SLOT, ctx));
    setRes({ kind: "idle" });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- changement de compte / d'organisation uniquement
  }, [ctxId]);

  // État de la sauvegarde automatique (émis par DriveAutoBackup).
  useEffect(() => {
    const on = (e: Event) => {
      const det = (e as CustomEvent<{ kind: Result["kind"] | "idle"; message?: string; at?: string }>).detail;
      if (ctx) setLink(readLink(WORKSPACE_SLOT, ctx));
      setRes({
        kind: det.kind,
        message: det.kind === "ok" ? "Sauvegarde automatique effectuée." : det.message,
        at: det.at,
      });
    };
    window.addEventListener(AUTO_STATUS_EVENT, on);
    return () => window.removeEventListener(AUTO_STATUS_EVENT, on);
  }, [ctx]);

  const push = async (force = false) => {
    if (!ctx) return;
    setRes({ kind: "busy" });
    try {
      setLink(await pushWorkspace(ctx, deps(), { force }));
      setRes({ kind: "ok", message: "Espace de travail enregistré dans le Drive." });
      if (force) window.dispatchEvent(new Event(AUTO_EVENT));
    } catch (e) {
      if (isConflict(e))
        setRes({
          kind: "conflict",
          message: "Une sauvegarde plus récente (ou d'un autre appareil) existe déjà dans le Drive.",
        });
      else {
        reportError("workspace.drive-push", e);
        setRes({ kind: "error", message: e instanceof VaultLockedError || e instanceof Error ? e.message : String(e) });
      }
    }
  };

  const restore = async () => {
    if (!ctx) return;
    setRes({ kind: "busy" });
    try {
      const got = await pullWorkspace(ctx);
      if (!got)
        return void setRes({ kind: "error", message: "Aucune sauvegarde de l'espace de travail dans le Drive." });
      setLink(got.link);
      setRes({ kind: "idle" });
      setPending(got.backup);
    } catch (e) {
      reportError("workspace.drive-pull", e);
      setRes({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <section className="settings__card" aria-labelledby="drive-backup-title">
      <h3 id="drive-backup-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Cloud size={16} aria-hidden="true" /> Sauvegarde dans le Drive entreprise
      </h3>
      <p className="muted">
        Envoie tous vos documents, tableurs, présentations et PDF dans le Drive de votre serveur, sous la forme d'un
        seul fichier « Espace-de-travail-Elium.elium-workspace », chiffré de bout en bout et versionné par le serveur.
        Les clés et l'identité de cet appareil ne sont jamais incluses.
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
            {link
              ? `Dernière sauvegarde : ${new Date(link.syncedAt).toLocaleString("fr-FR")}.`
              : "Aucune sauvegarde pour l'instant."}
          </p>
          <div className="settings__row">
            <Button size="sm" onClick={() => void push()} disabled={res.kind === "busy" || !bridge.ws.ready}>
              <Upload size={14} /> Sauvegarder maintenant
            </Button>
            <Button size="sm" variant="outline" onClick={() => void restore()} disabled={res.kind === "busy"}>
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
            Sauvegarder automatiquement une minute après chaque modification
            {required && <span className="muted"> — imposé par le propriétaire de ce Drive</span>}
          </label>
          {res.kind === "busy" && <p className="muted">Synchronisation en cours…</p>}
          {res.kind === "ok" && <Alert tone="success">{res.message}</Alert>}
          {res.kind === "error" && <Alert tone="danger">{res.message}</Alert>}
          {res.kind === "conflict" && (
            <Alert tone="warning" title="Conflit">
              {res.message}
              <div className="settings__row">
                <Button size="sm" variant="outline" onClick={() => void restore()}>
                  Voir la sauvegarde du Drive
                </Button>
                <Button size="sm" variant="danger" onClick={() => void push(true)}>
                  Écraser avec cet espace
                </Button>
              </div>
            </Alert>
          )}
        </>
      )}
      {pending && <RestoreDialog bridge={bridge} backup={pending} onClose={() => setPending(null)} />}
    </section>
  );
}
