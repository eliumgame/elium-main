import { useCallback, useRef } from "react";
import { useOptionalDialogs } from "../ui/dialogs";

/**
 * Notifie l'utilisateur d'une modification collaborative refusée (trop volumineuse, quota atteint).
 * Sans DialogsProvider (tests, intégrations isolées), la notification est simplement ignorée.
 */
export function useCollabNotice(): (message: string) => void {
  const dialogs = useOptionalDialogs();
  const ref = useRef(dialogs);
  ref.current = dialogs;
  return useCallback((message: string) => {
    void ref.current?.alert({ title: "Modification non synchronisée", message });
  }, []);
}
