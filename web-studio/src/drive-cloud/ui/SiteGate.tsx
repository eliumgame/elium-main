/**
 * Garde d'authentification d'un site DÉPLOYÉ. Au démarrage on sonde
 * `/api/site/policy` : si un serveur Drive répond, aucun module (Documents,
 * Tableur, Présentations, PDF…) n'est accessible tant que l'utilisateur n'a pas
 * un compte déverrouillé ; sinon (application de bureau, dev sans serveur) on
 * reste en mode local, inchangé.
 *
 * Si le propriétaire a rendu la 2FA obligatoire et que ce compte n'en a pas, on
 * affiche l'enrôlement avant tout le reste.
 */
import { Cloud, ShieldAlert } from "lucide-react";
import type { ReactNode } from "react";
import "../drive-cloud.css";
import { useDrive } from "../session";
import AuthPanel from "./AuthPanel";
import SecurityPanel from "./SecurityPanel";
import ResetPasswordPage, { resetTokenFromSearch } from "./ResetPasswordPage";

/**
 * Pages publiques par conception, ouvertes SANS compte (le secret de déchiffrement
 * vit dans le fragment d'URL) : lien de partage (?link=), demande de signature
 * (?sign=) et fenêtre présentateur (?presenter=1, sans données).
 */
export function isPublicEntry(search: string): boolean {
  try {
    const q = new URLSearchParams(search);
    return !!q.get("link") || !!q.get("sign") || q.get("presenter") === "1";
  } catch {
    return false;
  }
}

export default function SiteGate({ children }: { children: ReactNode }) {
  const d = useDrive();
  if (d.policy === null) return <>{children}</>; // pas de serveur Drive : mode local
  // Lien de réinitialisation de mot de passe (?reset=…) : page dédiée, sans compte.
  const resetToken = resetTokenFromSearch(typeof window === "undefined" ? "" : window.location.search);
  if (resetToken) {
    if (d.policy === undefined)
      return (
        <div className="dc-loading" role="status">
          Chargement…
        </div>
      );
    return <ResetPasswordPage token={resetToken} />;
  }
  if (isPublicEntry(typeof window === "undefined" ? "" : window.location.search)) return <>{children}</>;
  if (d.policy === undefined || d.status === "loading") {
    return (
      <div className="dc-loading" role="status">
        <Cloud size={28} /> Chargement…
      </div>
    );
  }
  if (d.status !== "authenticated") return <AuthPanel gated />;
  if (d.mfaEnrollRequired) {
    return (
      <div className="dc-gate" data-testid="mfa-enrollment-gate">
        <div className="dc-gate__card">
          <h1 className="dc-gate__title">
            <ShieldAlert size={22} /> Activez la vérification en deux étapes
          </h1>
          <p className="muted">
            {d.policy.siteName || "Ce Drive"} exige un second facteur pour tous les comptes. Configurez une application
            d'authentification (ou une clé de sécurité) pour continuer.
          </p>
          <SecurityPanel />
          <button className="eb eb--ghost" onClick={() => void d.logout()}>
            Se déconnecter
          </button>
        </div>
      </div>
    );
  }
  return <>{children}</>;
}
