/** État du passeport + enregistrement automatique (différé, vidé à la fermeture). */
import { useCallback, useEffect, useRef, useState } from "react";
import type { VaultSecret } from "../../crypto/local-vault";
import { reportError } from "../../ui/crash-log";
import { emptyPassport } from "../model";
import { PassportLockedError, PassportUnreadableError, loadPassport, savePassport } from "../store";
import type { PassportData } from "../types";

export type LoadStatus = "loading" | "locked" | "unreadable" | "ready" | "error";
export type SaveStatus = "saved" | "saving" | "error";

const SAVE_DELAY_MS = 600;

export function usePassport(vaultSecret?: VaultSecret) {
  const [data, setData] = useState<PassportData | null>(null);
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("saved");
  const [unreadableReason, setUnreadableReason] = useState<PassportUnreadableError["reason"] | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const secretRef = useRef(vaultSecret);
  secretRef.current = vaultSecret;
  const dataRef = useRef<PassportData | null>(null);
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Enregistre l'écriture en attente ; renvoie l'erreur éventuelle (déjà signalée) au lieu de la lever. */
  const flush = useCallback(async (): Promise<unknown> => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const d = dataRef.current;
    if (!d || !dirty.current) return null;
    dirty.current = false;
    try {
      await savePassport(d, secretRef.current);
      setSaveStatus(dirty.current ? "saving" : "saved");
      return null;
    } catch (e) {
      dirty.current = true;
      setSaveStatus("error");
      reportError("passeport.save", e);
      return e;
    }
  }, []);

  // Chargement (et nouvelle tentative quand le coffre est déverrouillé).
  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    loadPassport(vaultSecret)
      .then((d) => {
        if (cancelled) return;
        const next = d ?? emptyPassport();
        dataRef.current = next;
        dirty.current = false;
        setData(next);
        setStatus("ready");
      })
      .catch((e) => {
        if (cancelled) return;
        if (e instanceof PassportLockedError) setStatus("locked");
        else if (e instanceof PassportUnreadableError) {
          // Données chiffrées illisibles : jamais remplacées par un passeport vide — la vue propose une issue.
          setUnreadableReason(e.reason);
          setStatus("unreadable");
        } else {
          reportError("passeport.load", e);
          setStatus("error");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [vaultSecret, reloadTick]);

  /** Relit le stockage (après récupération ou remise à zéro depuis l'écran « passeport illisible »). */
  const reload = useCallback(() => setReloadTick((n) => n + 1), []);

  // Vide l'écriture en attente à la fermeture de la vue / de l'onglet.
  useEffect(() => {
    const onHide = () => void flush();
    window.addEventListener("pagehide", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      void flush();
    };
  }, [flush]);

  const update = useCallback(
    (fn: (d: PassportData) => PassportData) => {
      const prev = dataRef.current;
      if (!prev) return;
      const next = { ...fn(prev), updatedAt: new Date().toISOString() };
      dataRef.current = next;
      dirty.current = true;
      setData(next);
      setSaveStatus("saving");
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), SAVE_DELAY_MS);
    },
    [flush],
  );

  /**
   * Remplace tout le passeport (import, réinitialisation) et enregistre aussitôt. LÈVE si l'enregistrement échoue :
   * l'appelant ne doit pas enchaîner d'opération destructive (purge des annexes) sur un remplacement non enregistré.
   */
  const replace = useCallback(
    async (next: PassportData) => {
      dataRef.current = { ...next, updatedAt: new Date().toISOString() };
      dirty.current = true;
      setData(dataRef.current);
      setSaveStatus("saving");
      const err = await flush();
      if (err) throw err instanceof Error ? err : new Error(String(err));
    },
    [flush],
  );

  return { data, status, unreadableReason, saveStatus, update, replace, flush, reload };
}
