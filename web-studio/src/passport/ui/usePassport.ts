/** État du passeport + enregistrement automatique (différé, vidé à la fermeture). */
import { useCallback, useEffect, useRef, useState } from "react";
import type { VaultSecret } from "../../crypto/local-vault";
import { reportError } from "../../ui/crash-log";
import { emptyPassport } from "../model";
import { PassportLockedError, loadPassport, savePassport } from "../store";
import type { PassportData } from "../types";

export type LoadStatus = "loading" | "locked" | "ready" | "error";
export type SaveStatus = "saved" | "saving" | "error";

const SAVE_DELAY_MS = 600;

export function usePassport(vaultSecret?: VaultSecret) {
  const [data, setData] = useState<PassportData | null>(null);
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("saved");
  const secretRef = useRef(vaultSecret);
  secretRef.current = vaultSecret;
  const dataRef = useRef<PassportData | null>(null);
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const d = dataRef.current;
    if (!d || !dirty.current) return;
    dirty.current = false;
    try {
      await savePassport(d, secretRef.current);
      setSaveStatus(dirty.current ? "saving" : "saved");
    } catch (e) {
      dirty.current = true;
      setSaveStatus("error");
      reportError("passeport.save", e);
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
        else {
          reportError("passeport.load", e);
          setStatus("error");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [vaultSecret]);

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

  /** Remplace tout le passeport (import, réinitialisation) et enregistre aussitôt. */
  const replace = useCallback(
    async (next: PassportData) => {
      dataRef.current = { ...next, updatedAt: new Date().toISOString() };
      dirty.current = true;
      setData(dataRef.current);
      setSaveStatus("saving");
      await flush();
    },
    [flush],
  );

  return { data, status, saveStatus, update, replace, flush };
}
