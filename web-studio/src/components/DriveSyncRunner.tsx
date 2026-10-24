/**
 * Sauvegarde continue de l'espace de travail dans le Drive entreprise — montée une fois dans
 * l'application. Sur un site déployé elle est ACTIVÉE par défaut (et obligatoire quand le propriétaire
 * l'impose : `backupRequired`) ; hors site, elle reste une option des Réglages. Elle configure le
 * chef d'orchestre (workspace/sync-controller.ts) et déclenche un envoi quelques secondes après la
 * dernière modification, à la reconnexion réseau et à la fermeture / mise en arrière-plan de la page.
 * Rendu : la pastille d'état et l'invite de restauration (components/DriveSyncUi.tsx).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { readAutoOr } from "../drive-cloud/named-file";
import type { OpsCtx } from "../drive-cloud/ops";
import { useDrive } from "../drive-cloud/session";
import type { VaultSecret } from "../crypto/local-vault";
import { AUTO_EVENT, WORKSPACE_SLOT, workspaceSignature } from "../workspace/drive-backup";
import { DIRTY_EVENT } from "../workspace/sync-dirty";
import { configureSync, flushNow, request, getSyncStatus } from "../workspace/sync-controller";
import type { WorkspaceApi } from "../workspace/useWorkspace";
import { makeBackupDeps } from "./settings/WorkspaceSection";
import { DriveSyncUi } from "./DriveSyncUi";

export default function DriveSyncRunner({
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
  const [tick, setTick] = useState(0);
  const deployed = d.policy != null; // site Drive déployé : sauvegarde automatique par défaut
  const required = d.policy?.backupRequired === true;
  const auto = ctx ? required || readAutoOr(WORKSPACE_SLOT, ctx, deployed) : false;

  useEffect(() => {
    const on = () => setTick((n) => n + 1);
    window.addEventListener(AUTO_EVENT, on);
    return () => window.removeEventListener(AUTO_EVENT, on);
  }, []);

  useEffect(() => {
    configureSync({
      ctx,
      getDeps: () => makeBackupDeps({ ws: wsRef.current, getSecret: secretRef.current, appVersion }),
      getItems: () => wsRef.current.items,
      auto,
      required,
      appVersion,
    });
  }, [ctx, auto, required, appVersion, tick]);

  // Un élément créé / modifié / supprimé, ou une pièce annexe (brouillon, version, police…) modifiée.
  const sig = ws.ready ? workspaceSignature(ws.items) : "";
  useEffect(() => {
    if (ctx && sig) request("modification");
  }, [ctx, sig]);
  useEffect(() => {
    const on = () => request("pièce annexe");
    window.addEventListener(DIRTY_EVENT, on);
    return () => window.removeEventListener(DIRTY_EVENT, on);
  }, []);

  // Reconnexion réseau, fermeture ou mise en arrière-plan : on vide la file tout de suite.
  useEffect(() => {
    const flush = () => {
      const s = getSyncStatus();
      if (s.pending > 0 || s.phase === "offline" || s.phase === "error") void flushNow();
    };
    const onHide = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("online", flush);
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.removeEventListener("online", flush);
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onHide);
    };
  }, []);

  return <DriveSyncUi ws={ws} />;
}
