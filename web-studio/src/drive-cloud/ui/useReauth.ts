/**
 * Hook : demande à l'utilisateur de confirmer son identité (mot de passe, puis code 2FA s'il
 * en a un) et renvoie le jeton de ré-authentification, ou `null` s'il annule.
 */
import { useCallback } from "react";
import { useDrive } from "../session";
import { useDialogs } from "../../ui/dialogs";
import { reauthenticate } from "../reauth";

export function useReauth(): () => Promise<string | null> {
  const d = useDrive();
  const dialogs = useDialogs();
  return useCallback(async () => {
    const email = d.user?.email;
    if (!email) return null;
    const password = await dialogs.prompt({
      title: "Confirmez votre identité",
      label: "Votre mot de passe",
      password: true,
      hint: "Cette opération sensible exige une confirmation récente.",
      confirmLabel: "Continuer",
    });
    if (!password) return null;
    let code: string | undefined;
    const st = await d.api.mfaStatus().catch(() => null);
    if (st?.enabled) {
      const c = await dialogs.prompt({
        title: "Code de vérification",
        label: "Code de votre application (ou code de secours)",
        placeholder: "123456",
        confirmLabel: "Confirmer",
      });
      if (!c) return null;
      code = c.trim();
    }
    return reauthenticate(d.api, email, password, code);
  }, [d.api, d.user?.email, dialogs]);
}
