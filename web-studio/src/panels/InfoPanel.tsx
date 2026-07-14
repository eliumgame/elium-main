import { Alert } from "../ui/components";
import { Info } from "lucide-react";
import { profileOf } from "../format/profiles";
import type { Studio } from "../studio/types";

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="info-row">
      <span className="info-row__label">{label}</span>
      <span className="info-row__value">{value}</span>
    </div>
  );
}

export default function InfoPanel({ studio }: { studio: Studio }) {
  const { file, integrity } = studio;
  const m = file.manifest;
  const def = profileOf(m.profile);

  return (
    <div className="panel">
      <section className="panel-section">
        <h3 className="panel-title"><Info size={15} /> Document</h3>
        <Row label="Titre" value={m.title} />
        <Row label="Profil" value={def.label} />
        <Row label="Format" value={`elium v${m.formatVersion}`} />
        <Row label="Langue" value={m.language} />
        <Row label="Créé le" value={new Date(m.createdAt).toLocaleString("fr-FR")} />
        <Row label="Modifié le" value={new Date(m.modifiedAt).toLocaleString("fr-FR")} />
        <Row label="Ressources" value={m.features.resources} />
        <Row
          label="Intégrité"
          value={
            integrity?.unchecked
              ? "non vérifiée (nouveau document)"
              : integrity?.contentIntact
                ? "contenu intact"
                : "contenu altéré"
          }
        />
        {m.integrity.contentHash && (
          <Row label="Empreinte" value={<code className="fp">{m.integrity.contentHash.slice(0, 24)}…</code>} />
        )}
      </section>

      <section className="panel-section">
        <h3 className="panel-title">Confidentialité (RGPD)</h3>
        <Row label="Traitement" value={m.rgpd.localOnly ? "100% local" : "service en ligne utilisé"} />
        <Row
          label="Données personnelles"
          value={m.rgpd.storedPersonalData.length ? m.rgpd.storedPersonalData.join(", ") : "aucune"}
        />
        <Alert tone="info">{m.rgpd.notice || "Traitement local par défaut. Voir PRIVACY_RGPD.md."}</Alert>
      </section>
    </div>
  );
}
