import { Save, Eye, Pencil, Home, Settings } from "lucide-react";
import { Button } from "../ui/components";
import StatusBadges from "./StatusBadges";
import type { Studio } from "../studio/types";

export default function TopBar({ studio }: { studio: Studio }) {
  return (
    <header className="topbar">
      <div className="topbar__left">
        <button className="brand brand--sm" onClick={() => studio.goHome()} title="Accueil">
          <img src="/elium-logo.svg" alt="Elium" className="brand__logo" width={22} height={22} />
        </button>
        {studio.editable ? (
          <input
            className="title-input"
            value={studio.file.manifest.title}
            onChange={(e) => studio.setTitle(e.target.value)}
            placeholder="Titre du document"
            aria-label="Titre du document"
          />
        ) : (
          <span className="title-input title-input--ro">{studio.file.manifest.title}</span>
        )}
      </div>

      <div className="topbar__center">
        <StatusBadges studio={studio} />
      </div>

      <div className="topbar__right">
        <button className="icon-btn" onClick={() => studio.openSettings()} title="Paramètres" aria-label="Paramètres">
          <Settings size={18} />
        </button>
        {studio.editable ? (
          <>
            <Button variant="ghost" size="sm" onClick={() => studio.toViewer()} title="Aperçu / vérification">
              <Eye size={16} /> Aperçu
            </Button>
            <Button size="sm" onClick={() => studio.save()} disabled={studio.busy}>
              <Save size={16} /> {studio.busy ? "…" : "Enregistrer"}
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" size="sm" onClick={() => studio.goHome()}><Home size={16} /> Accueil</Button>
            <Button size="sm" onClick={() => studio.toEditor()}><Pencil size={16} /> Éditer</Button>
          </>
        )}
      </div>
    </header>
  );
}
