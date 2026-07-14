import { ShieldCheck, ShieldAlert, Shield, KeyRound } from "lucide-react";
import { Button } from "../ui/components";
import type { Studio } from "../studio/types";
import type { SignatureVerdict } from "../format/types";

/** Read-only summary shown at the top of the viewer. */
export default function VerificationBanner({ studio }: { studio: Studio }) {
  const { file, integrity, journalVerdict, sealVerdict, sealPin, verdicts, trustedKey, trustSealKey } = studio;
  const list = Object.values(verdicts) as SignatureVerdict[];

  const integrityBad = integrity && !integrity.unchecked && !integrity.contentIntact;
  const sigBad = list.includes("invalid");
  const sigModified = list.includes("modified");
  const journalBad = journalVerdict && journalVerdict.count > 0 && !journalVerdict.valid;
  const sealBroken = sealVerdict === "broken";
  const sealKeyChanged = sealPin?.status === "changed";
  const expiresAt = file.manifest.accessExpiresAt;
  const expired = !!expiresAt && Date.now() > Date.parse(expiresAt);

  // A "valid" crypto verdict only attributes to a *trusted* identity when a
  // trusted key is configured. Without one, it is merely "cryptographically
  // intact, key not verified" — never a confident green.
  const hasProof = file.signatures.some((s) => !!s.proof);
  const sealed = !!sealVerdict && sealVerdict !== "unsealed";
  const unverifiedTrust = !trustedKey && (hasProof || sealed);

  const overallBad = integrityBad || sigBad || journalBad || sealBroken || sealKeyChanged;
  const overallWarn =
    sigModified || list.includes("unknown_key") || sealVerdict === "unknown_key" || unverifiedTrust || expired;

  const tone = overallBad ? "danger" : overallWarn ? "warning" : "success";
  const icon = overallBad ? <ShieldAlert size={18} /> : overallWarn ? <Shield size={18} /> : <ShieldCheck size={18} />;
  const headline = overallBad
    ? "Vérification : problème détecté"
    : overallWarn
      ? "Vérification : à confirmer"
      : "Vérification : document intègre";

  return (
    <div className={`verify-banner verify-banner--${tone}`}>
      <span className="verify-banner__icon">{icon}</span>
      <div className="verify-banner__text">
        <strong>{headline}</strong>
        <span className="verify-banner__detail">
          {integrity?.unchecked ? "Intégrité non applicable" : integrityBad ? "contenu altéré" : "contenu intact"}
          {file.signatures.length > 0 && ` · ${file.signatures.length} signature(s)`}
          {file.signatures.length > 0 && sigBad && " · une signature invalide"}
          {file.signatures.length > 0 && !sigBad && sigModified && " · document modifié après signature"}
          {journalVerdict && journalVerdict.count > 0 && (journalBad ? " · suivi altéré" : " · suivi valide")}
          {sealVerdict && sealVerdict !== "unsealed" && (
            sealBroken ? " · sceau rompu" : sealVerdict === "unknown_key" ? " · sceau non vérifié" : " · sceau valide"
          )}
          {sealPin?.status === "pinned" && !sealKeyChanged && " · clé du sceau reconnue"}
          {expired && ` · accès expiré le ${new Date(expiresAt!).toLocaleDateString()}`}
          {unverifiedTrust && !overallBad && " · clé non vérifiée (configurez une clé de confiance)"}
        </span>
        {sealKeyChanged && (
          <div className="verify-banner__tofu">
            <KeyRound size={14} />
            <span>
              La clé du sceau a changé depuis la première ouverture de ce document
              {sealPin?.pinned?.fingerprint ? ` (était ${sealPin.pinned.fingerprint.slice(0, 12)}…)` : ""}.
              Méfiez-vous d'une éventuelle usurpation.
            </span>
            <Button variant="outline" size="sm" onClick={trustSealKey}>Approuver la nouvelle clé</Button>
          </div>
        )}
      </div>
    </div>
  );
}
