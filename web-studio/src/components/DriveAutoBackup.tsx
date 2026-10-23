/**
 * Sauvegarde automatique de l'espace de travail dans le Drive entreprise.
 * Monté une fois dans l'application : une minute après la dernière modification d'un document, si
 * l'option est activée et la session Drive déverrouillée, l'archive est poussée en nouvelle version.
 * Invisible ; l'état et les réglages sont dans Réglages → Sauvegarde.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { isConflict, readAuto } from "../drive-cloud/named-file";
import type { OpsCtx } from "../drive-cloud/ops";
import { useDrive } from "../drive-cloud/session";
import type { VaultSecret } from "../crypto/local-vault";
import { reportError } from "../ui/crash-log";
import {
  AUTO_EVENT,
  AUTO_STATUS_EVENT,
  WORKSPACE_SLOT,
  pushWorkspace,
  workspaceSignature,
} from "../workspace/drive-backup";
import { VaultLockedError } from "../workspace/backup-io";
import type { WorkspaceApi } from "../workspace/useWorkspace";
import { makeBackupDeps } from "./settings/WorkspaceSection";

const DELAY_MS = 60_000;

export default function DriveAutoBackup({
  ws,
  getSecret,
  appVersion,
}: {
  ws: WorkspaceApi;
  getSecret: () => VaultSecret | undefined;
  appVersion?: string;
}) {
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
  const wsRef = useRef(ws);
  wsRef.current = ws;
  const secretRef = useRef(getSecret);
  secretRef.current = getSecret;
  // Sauvegarde imposée par le propriétaire du Drive (portail) : l'option locale est ignorée.
  const required = d.policy?.backupRequired === true;
  const lastPushed = useRef("");
  const stopped = useRef(false); // un conflit suspend l'automatique jusqu'à une action manuelle

  const sig = ws.ready ? workspaceSignature(ws.items) : "";
  // Un rechangement d'option (Réglages) relance l'évaluation.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const on = () => {
      stopped.current = false;
      setTick((n) => n + 1);
    };
    window.addEventListener(AUTO_EVENT, on);
    return () => window.removeEventListener(AUTO_EVENT, on);
  }, []);

  useEffect(() => {
    if (!ctx || !sig || !(required || readAuto(WORKSPACE_SLOT, ctx)) || stopped.current || sig === lastPushed.current) return;
    const id = setTimeout(() => {
      const deps = makeBackupDeps({ ws: wsRef.current, getSecret: secretRef.current, appVersion });
      const status = (kind: string, message?: string) =>
        window.dispatchEvent(
          new CustomEvent(AUTO_STATUS_EVENT, { detail: { kind, message, at: new Date().toISOString() } }),
        );
      status("busy");
      pushWorkspace(ctx, deps)
        .then(() => {
          lastPushed.current = sig;
          status("ok");
        })
        .catch((e) => {
          if (e instanceof VaultLockedError) return status("idle");
          if (isConflict(e)) {
            stopped.current = true;
            return status("conflict", "Une sauvegarde plus récente existe dans le Drive : l'automatique est suspendu.");
          }
          reportError("workspace.drive-auto", e);
          status("error", e instanceof Error ? e.message : String(e));
        });
    }, DELAY_MS);
    return () => clearTimeout(id);
  }, [ctx, sig, appVersion, tick, required]);

  return null;
}
