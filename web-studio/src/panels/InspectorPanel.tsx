import { useState } from "react";
import type { Editor } from "@tiptap/react";
import { PenLine, Stamp, MessageSquare, Lock, History, GitBranch, Download, Info, X, PanelRightOpen } from "lucide-react";
import SignaturesPanel from "./SignaturesPanel";
import ParapheurPanel from "./ParapheurPanel";
import CommentsPanel from "./CommentsPanel";
import SecurityPanel from "./SecurityPanel";
import TrackingPanel from "./TrackingPanel";
import VersionsPanel from "./VersionsPanel";
import ExportPanel from "./ExportPanel";
import InfoPanel from "./InfoPanel";
import type { PanelId, Studio } from "../studio/types";

const TABS: { id: PanelId; icon: React.ReactNode; label: string }[] = [
  { id: "signatures", icon: <PenLine size={16} />, label: "Signatures" },
  { id: "parapheur", icon: <Stamp size={16} />, label: "Parapheur" },
  { id: "comments", icon: <MessageSquare size={16} />, label: "Commentaires" },
  { id: "security", icon: <Lock size={16} />, label: "Sécurité" },
  { id: "tracking", icon: <History size={16} />, label: "Suivi" },
  { id: "versions", icon: <GitBranch size={16} />, label: "Versions" },
  { id: "export", icon: <Download size={16} />, label: "Export" },
  { id: "info", icon: <Info size={16} />, label: "Infos" },
];

interface Props {
  studio: Studio;
  editor?: Editor | null;
  open: boolean;
  onToggle: () => void;
}

export default function InspectorPanel({ studio, editor, open, onToggle }: Props) {
  const [active, setActive] = useState<PanelId>("signatures");
  const activeLabel = TABS.find((t) => t.id === active)?.label ?? "";

  // Collapsed: thin icon rail. Clicking an icon opens the panel on that tab.
  if (!open) {
    return (
      <nav className="inspector-rail" aria-label="Inspecteur">
        <button
          className="inspector-rail__btn inspector-rail__toggle"
          onClick={onToggle}
          title="Ouvrir le panneau (Ctrl+\)"
          aria-label="Ouvrir le panneau latéral"
        >
          <PanelRightOpen size={18} />
        </button>
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`inspector-rail__btn ${active === t.id ? "is-active" : ""}`}
            onClick={() => {
              setActive(t.id);
              onToggle();
            }}
            title={t.label}
            aria-label={t.label}
          >
            {t.icon}
          </button>
        ))}
      </nav>
    );
  }

  return (
    <aside className="inspector">
      <div className="inspector__header">
        <span className="inspector__title">{activeLabel}</span>
        <button
          className="inspector__close"
          onClick={onToggle}
          title="Fermer le panneau (Ctrl+\)"
          aria-label="Fermer le panneau latéral"
        >
          <X size={16} />
        </button>
      </div>
      <div className="inspector__tabs" role="tablist" aria-label="Sections de l'inspecteur">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={active === t.id}
            className={`inspector__tab ${active === t.id ? "is-active" : ""}`}
            onClick={() => setActive(t.id)}
            title={t.label}
            aria-label={t.label}
          >
            {t.icon}
          </button>
        ))}
      </div>
      <div className="inspector__content">
        {active === "signatures" && <SignaturesPanel studio={studio} />}
        {active === "parapheur" && <ParapheurPanel studio={studio} />}
        {active === "comments" && <CommentsPanel editor={editor ?? null} />}
        {active === "security" && <SecurityPanel studio={studio} />}
        {active === "tracking" && <TrackingPanel studio={studio} />}
        {active === "versions" && <VersionsPanel studio={studio} editor={editor ?? null} />}
        {active === "export" && <ExportPanel studio={studio} />}
        {active === "info" && <InfoPanel studio={studio} />}
      </div>
    </aside>
  );
}
