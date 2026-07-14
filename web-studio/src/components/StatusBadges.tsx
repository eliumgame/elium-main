import { Badge } from "../ui/components";
import { profileOf } from "../format/profiles";
import type { Studio } from "../studio/types";
import type { SignatureVerdict } from "../format/types";

/** Document-level status badges (see SPEC §Visualiseur). */
export default function StatusBadges({ studio }: { studio: Studio }) {
  const { file, verdicts, integrity, journalVerdict } = studio;
  const def = profileOf(file.manifest.profile);
  const verdictList = Object.values(verdicts) as SignatureVerdict[];

  const badges: { label: string; accent: "neutral" | "info" | "success" | "warning" | "danger" }[] = [];

  // Profile / protection
  badges.push({ label: def.badge, accent: def.accent });
  if (file.manifest.protection.encrypted && def.id !== "encrypted" && def.id !== "protected") {
    badges.push({ label: "Chiffré", accent: "warning" });
  }

  // Integrity
  if (integrity && !integrity.unchecked) {
    if (!integrity.contentIntact) badges.push({ label: "Document altéré", accent: "danger" });
  }

  // Signatures
  if (file.signatures.length) {
    if (verdictList.includes("invalid")) badges.push({ label: "Signature invalide", accent: "danger" });
    else if (verdictList.includes("modified")) badges.push({ label: "Document modifié", accent: "warning" });
    else if (verdictList.includes("valid")) badges.push({ label: "Signature valide", accent: "success" });
    else if (verdictList.includes("unknown_key")) badges.push({ label: "Clé inconnue", accent: "warning" });
    else badges.push({ label: "Signé", accent: "info" });
  }

  // Tracking
  if (journalVerdict && journalVerdict.count > 0) {
    badges.push(
      journalVerdict.valid
        ? { label: "Suivi valide", accent: "success" }
        : { label: "Suivi altéré", accent: "danger" },
    );
  }

  return (
    <div className="status-badges">
      {badges.map((b, i) => (
        <Badge key={`${b.label}-${i}`} accent={b.accent}>{b.label}</Badge>
      ))}
    </div>
  );
}
