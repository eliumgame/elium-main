import { ShieldCheck, ShieldAlert, Shield, KeyRound, UserPlus } from "lucide-react";
import { Button } from "../ui/components";
import { useDialogs } from "../ui/dialogs";
import type { Studio } from "../studio/types";
import type { SignatureVerdict } from "../format/types";
import { profileExpectsSeal } from "../format/profiles";
import { fingerprintWords } from "../sign/safety-words";

/** Read-only summary shown at the top of the viewer. */
export default function VerificationBanner({ studio }: { studio: Studio }) {
  const { file, integrity, journalVerdict, sealVerdict, sealPin, verdicts, attributions, sealAttribution, trustSealKey, trustContact } = studio;
  const { prompt } = useDialogs();
  const list = Object.values(verdicts) as SignatureVerdict[];

  const integrityBad = integrity && !integrity.unchecked && !integrity.contentIntact;
  const sigBad = list.includes("invalid");
  const sigModified = list.includes("modified");
  const journalBad = journalVerdict && journalVerdict.count > 0 && !journalVerdict.valid;
  const sealBroken = sealVerdict === "broken";
  const sealKeyChanged = sealPin?.status === "changed";
  const expiresAt = file.manifest.accessExpiresAt;
  const expired = !!expiresAt && Date.now() > Date.parse(expiresAt);

  const seal = file.manifest.seal;
  const sealed = !!sealVerdict && sealVerdict !== "unsealed";

  // Trust is a SEPARATE dimension from the (purely cryptographic) verdict: a
  // valid seal/proof whose key is NOT in the carnet is "intact but not
  // attributed" — never a confident green. Attribution comes from the carnet.
  const sealUnattributed = sealed && !sealBroken && !sealAttribution;
  const proofUnattributed = file.signatures.some((s) => !!s.proof && !attributions[s.id]);
  const unverifiedTrust = sealUnattributed || proofUnattributed;

  // Le profil promet une garantie d'intégrité (verrouillé/suivi/signé) mais le
  // document n'est PAS scellé → la promesse est non vérifiable (le hash de
  // contenu seul est recalculable). On ne doit alors JAMAIS afficher un « intègre »
  // rassurant : on dégrade en avertissement.
  const missingSeal = profileExpectsSeal(file.manifest.profile) && !sealed && !integrity?.unchecked;

  const overallBad = integrityBad || sigBad || journalBad || sealBroken || sealKeyChanged;
  const overallWarn = sigModified || unverifiedTrust || expired || missingSeal;

  const tone = overallBad ? "danger" : overallWarn ? "warning" : "success";
  const icon = overallBad ? <ShieldAlert size={18} /> : overallWarn ? <Shield size={18} /> : <ShieldCheck size={18} />;
  const headline = overallBad
    ? "Vérification : problème détecté"
    : overallWarn
      ? "Vérification : à confirmer"
      : "Vérification : document intègre";

  // Attribuer la clé du sceau à un contact nommé du carnet.
  const attributeSeal = async () => {
    if (!seal) return;
    const name = await prompt({
      title: "Attribuer la clé du sceau",
      label: "Nom du scelleur",
      hint: `Mots de vérification : ${fingerprintWords(seal.fingerprint)} — comparez-les avec le signataire par un canal de confiance avant d'approuver.`,
      confirmLabel: "Approuver",
    });
    if (name !== null) await trustContact(name.trim() || "Sans nom", seal.publicKeyHex);
  };

  return (
    <div className={`verify-banner verify-banner--${tone}`}>
      <span className="verify-banner__icon">{icon}</span>
      <div className="verify-banner__text">
        <strong>{headline}</strong>
        <span className="verify-banner__detail">
          {integrity?.unchecked ? "Intégrité non applicable" : integrityBad ? "contenu altéré" : missingSeal ? "intégrité non vérifiable (non scellé)" : "contenu intact"}
          {integrity?.resourcesTampered?.length ? ` · ${integrity.resourcesTampered.length} ressource(s) altérée(s)` : ""}
          {file.signatures.length > 0 && ` · ${file.signatures.length} signature(s)`}
          {file.signatures.length > 0 && sigBad && " · une signature invalide"}
          {file.signatures.length > 0 && !sigBad && sigModified && " · document modifié après signature"}
          {journalVerdict && journalVerdict.count > 0 && (journalBad ? " · suivi altéré" : " · suivi valide")}
          {sealed && (
            sealBroken
              ? " · sceau rompu"
              : sealAttribution
                ? ` · scellé par ${sealAttribution}`
                : " · sceau valide (clé non vérifiée)"
          )}
          {sealPin?.status === "pinned" && !sealKeyChanged && !sealAttribution && " · clé du sceau reconnue"}
          {expired && ` · accès expiré le ${new Date(expiresAt!).toLocaleDateString()}`}
          {unverifiedTrust && !overallBad && " · clé non vérifiée (ajoutez-la au carnet de confiance)"}
        </span>
        {sealUnattributed && !sealKeyChanged && (
          <div className="verify-banner__attribute">
            <span>Clé du sceau : {fingerprintWords(seal!.fingerprint)}</span>
            <Button variant="outline" size="sm" onClick={() => void attributeSeal()}>
              <UserPlus size={14} /> Attribuer cette clé…
            </Button>
          </div>
        )}
        {sealKeyChanged && (
          <div className="verify-banner__tofu">
            <KeyRound size={14} />
            <span>
              La clé du sceau a changé depuis la première ouverture de ce document
              {sealPin?.pinned?.fingerprint ? ` (était : ${fingerprintWords(sealPin.pinned.fingerprint)})` : ""}
              {file.manifest.seal?.fingerprint ? ` · nouvelle clé : ${fingerprintWords(file.manifest.seal.fingerprint)}` : ""}.
              Vérifiez ces mots avec le signataire par un canal de confiance avant d'approuver — méfiez-vous d'une usurpation.
            </span>
            <Button variant="outline" size="sm" onClick={trustSealKey}>Approuver la nouvelle clé</Button>
          </div>
        )}
      </div>
    </div>
  );
}
