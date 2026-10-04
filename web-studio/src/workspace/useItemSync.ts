/**
 * Lie un éditeur (Tableur, Présentations) à l'espace de travail : inscrit
 * l'élément au catalogue à son premier enregistrement, met à jour taille et
 * date à intervalle raisonnable (pas à chaque frappe), mémorise l'ouverture,
 * et gère le titre (renommage depuis l'éditeur).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDialogs } from "../ui/dialogs";
import { useI18n } from "../i18n";
import { createThrottle } from "./throttle";
import type { WorkspaceApi } from "./useWorkspace";
import type { ItemKind } from "./types";

export interface ItemSession {
  id: string;
  /** Élément pas encore enregistré : il n'apparaît dans la bibliothèque qu'au premier contenu réel. */
  isNew: boolean;
  title: string;
}

export function useItemSync(ws: WorkspaceApi, session: ItemSession | undefined, kind: ItemKind) {
  const { t } = useI18n();
  const { prompt } = useDialogs();
  const [title, setTitle] = useState(session?.title ?? "");
  const titleRef = useRef(title);
  titleRef.current = title;
  const created = useRef(!session?.isNew);
  const wsRef = useRef(ws);
  wsRef.current = ws;
  const sessionId = session?.id;

  useEffect(() => {
    setTitle(session?.title ?? "");
    created.current = !session?.isNew;
    if (session && !session.isNew) wsRef.current.touchOpened(session.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const throttled = useMemo(
    () =>
      createThrottle((size: number) => {
        if (!sessionId) return;
        created.current = true;
        void wsRef.current.registerSaved({ id: sessionId, kind, size, title: titleRef.current || undefined });
      }, 4000),
    [sessionId, kind],
  );
  // L'enregistrement final part quand on quitte l'éditeur.
  useEffect(() => () => throttled.flush(), [throttled]);

  const onSaved = useCallback((_value: unknown, size: number) => throttled(size), [throttled]);

  const rename = useCallback(async () => {
    if (!sessionId) return;
    const next = await prompt({
      title: t("workspace.rename_title"),
      label: t("workspace.rename_label"),
      defaultValue: titleRef.current,
    });
    if (next === null || !next.trim() || next.trim() === titleRef.current) return;
    setTitle(next.trim());
    if (created.current) await wsRef.current.run("rename", (s) => s.rename(sessionId, next.trim()));
    // Pas encore créé : le nouveau titre sera utilisé à l'inscription (titleRef).
  }, [sessionId, prompt, t]);

  return { title, onSaved, rename, active: !!session };
}
