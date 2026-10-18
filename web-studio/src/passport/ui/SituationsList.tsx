/** Liste des fiches de situation (gestion du passeport : ajouter, copier, supprimer, transférer). */
import { useState } from "react";
import { ClipboardList, Copy, FileDown, Plus, Send, Trash2 } from "lucide-react";
import { Badge, Button, EmptyState } from "../../ui/components";
import { MODALITES, STATE_LABEL, completion, periodLabel, situationState, spLabel } from "../model";
import type { Situation } from "../types";
import { STATE_ACCENT } from "./SituationEditor";

interface Props {
  situations: Situation[];
  onOpen: (id: number) => void;
  onNew: () => void;
  onDuplicate: (id: number) => void;
  onDelete: (id: number) => void;
  onTransfer: (id: number) => void;
  onDocx: (id: number) => void;
}

type Filter = "all" | "todo" | "validated";

export default function SituationsList(p: Props) {
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const rows = [...p.situations]
    .sort((a, b) => a.id - b.id)
    .filter((s) => {
      const st = situationState(s);
      if (filter === "validated" && st !== "validee") return false;
      if (filter === "todo" && st === "validee") return false;
      const needle = q.trim().toLowerCase();
      return !needle || `${spLabel(s.id)} ${s.intitule} ${s.lieuPeriodeDuree}`.toLowerCase().includes(needle);
    });

  return (
    <div className="pp-list">
      <div className="pp-list__bar">
        <Button onClick={p.onNew}>
          <Plus size={16} /> Nouvelle situation
        </Button>
        <input
          className="pp-input pp-list__search"
          type="search"
          placeholder="Rechercher une situation…"
          aria-label="Rechercher une situation"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <select
          className="pp-input pp-list__filter"
          aria-label="Filtrer par état"
          value={filter}
          onChange={(e) => setFilter(e.target.value as Filter)}
        >
          <option value="all">Toutes les fiches</option>
          <option value="todo">À compléter / à valider</option>
          <option value="validated">Validées dans le passeport</option>
        </select>
      </div>

      {p.situations.length === 0 ? (
        <EmptyState
          icon={<ClipboardList size={28} />}
          title="Aucune situation professionnelle"
          hint="Créez une fiche pour chaque situation vécue ou observée, puis transférez-la vers le passeport."
        />
      ) : rows.length === 0 ? (
        <EmptyState title="Aucune fiche ne correspond" />
      ) : (
        <ul className="pp-cards">
          {rows.map((s) => {
            const st = situationState(s);
            const pct = completion(s);
            return (
              <li key={s.id} className="pp-sit">
                <button className="pp-sit__main" onClick={() => p.onOpen(s.id)}>
                  <span className="pp-sit__id">{spLabel(s.id)}</span>
                  <span className="pp-sit__body">
                    <span className="pp-sit__title">{s.intitule || "Sans intitulé"}</span>
                    <span className="pp-sit__meta">
                      {periodLabel(s)} · {MODALITES.find((m) => m.id === s.modalite)?.short}
                      {s.activityIds.length > 0 && ` · Activités ${s.activityIds.join(", ")}`}
                      {s.taskIds.length > 0 && ` · ${s.taskIds.length} tâche(s)`}
                    </span>
                    <span className="pp-progress pp-progress--thin" aria-hidden="true">
                      <span className="pp-progress__bar">
                        <span style={{ width: `${pct}%` }} />
                      </span>
                      <span>{pct} %</span>
                    </span>
                  </span>
                  <Badge accent={STATE_ACCENT[st]}>{STATE_LABEL[st]}</Badge>
                </button>
                <div className="pp-sit__actions">
                  {(st === "a-valider" || st === "a-retransferer" || st === "a-completer") && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => p.onTransfer(s.id)}
                      title="Transférer vers le passeport"
                    >
                      <Send size={14} />
                      <span className="pp-sr">Transférer {spLabel(s.id)}</span>
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => p.onDocx(s.id)} title="Fiche d'analyse Word">
                    <FileDown size={14} />
                    <span className="pp-sr">Fiche d'analyse {spLabel(s.id)}</span>
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => p.onDuplicate(s.id)} title="Dupliquer">
                    <Copy size={14} />
                    <span className="pp-sr">Dupliquer {spLabel(s.id)}</span>
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => p.onDelete(s.id)} title="Supprimer">
                    <Trash2 size={14} />
                    <span className="pp-sr">Supprimer {spLabel(s.id)}</span>
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
