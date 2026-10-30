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
    let webauthn: unknown;
    const st = await d.api.mfaStatus().catch(() => null);
    const hasPasskey = ((await d.api.webauthnCredentials().catch(() => null))?.credentials.length ?? 0) > 0;
    if (hasPasskey) {
      // Clé d'accès d'abord (seul facteur possible pour un compte WebAuthn-only) ; repli sur le code si TOTP.
      try {
        const { startAuthentication } = await import("@simplewebauthn/browser");
        const options = await d.api.webauthnReauthOptions();
        webauthn = await startAuthentication({ optionsJSON: options as never });
      } catch {
        if (!st?.enabled) return null;
      }
    }
    if (st?.enabled && !webauthn) {
      const c = await dialogs.prompt({
        title: "Code de vérification",
        label: "Code de votre application (ou code de secours)",
        placeholder: "123456",
        confirmLabel: "Confirmer",
      });
      if (!c) return null;
      code = c.trim();
    }
    return reauthenticate(d.api, email, password, code, webauthn);
  }, [d.api, d.user?.email, dialogs]);
}
