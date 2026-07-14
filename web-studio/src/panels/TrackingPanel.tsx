import { Alert, Badge, EmptyState } from "../ui/components";
import { History, ShieldCheck, ShieldAlert } from "lucide-react";
import { eventLabel } from "../format/journal";
import type { Studio } from "../studio/types";

export default function TrackingPanel({ studio }: { studio: Studio }) {
  const { file, journalVerdict } = studio;
  const events = file.journal.events;

  return (
    <div className="panel">
      <section className="panel-section">
        <div className="panel-title-row">
          <h3 className="panel-title"><History size={15} /> Journal de suivi</h3>
          {journalVerdict && events.length > 0 && (
            <Badge accent={journalVerdict.valid ? "success" : "danger"}>
              {journalVerdict.valid ? <><ShieldCheck size={12} /> Intègre</> : <><ShieldAlert size={12} /> Altéré</>}
            </Badge>
          )}
        </div>

        {events.length === 0 ? (
          <EmptyState title="Suivi désactivé" hint="Activez un profil « Suivi », « Signé » ou « Final » pour journaliser les évènements." />
        ) : (
          <ol className="timeline">
            {events.map((e) => (
              <li key={e.seq} className="timeline__item">
                <div className="timeline__dot" />
                <div className="timeline__body">
                  <div className="timeline__label">{eventLabel(e.type)}</div>
                  <div className="timeline__meta">
                    {new Date(e.at).toLocaleString("fr-FR")}
                    {e.actor?.name ? ` · ${e.actor.name}` : ""}
                    {e.actor?.fingerprint ? ` · ${e.actor.fingerprint.slice(0, 10)}…` : ""}
                  </div>
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>

      <Alert tone="info" title="Chaîne d'intégrité">
        Chaque évènement est chaîné par empreinte SHA-256. Toute modification du journal casse la chaîne
        et est détectée. Données minimisées (RGPD) : nom, date, rôle, empreinte de clé, action.
      </Alert>
    </div>
  );
}
