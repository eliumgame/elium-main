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
        {/* Les libellés sont dans un span pour pouvoir disparaître sur très
            petit écran sans perdre l'info-bulle ni le nom accessible. */}
        {studio.editable ? (
          <>
            <Button variant="ghost" size="sm" onClick={() => studio.toViewer()} title="Aperçu / vérification" aria-label="Aperçu">
              <Eye size={16} /> <span className="eb__label">Aperçu</span>
            </Button>
            <Button size="sm" onClick={() => studio.save()} disabled={studio.busy} title="Enregistrer" aria-label="Enregistrer">
              <Save size={16} /> <span className="eb__label">{studio.busy ? "…" : "Enregistrer"}</span>
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" size="sm" onClick={() => studio.goHome()} title="Accueil" aria-label="Accueil">
              <Home size={16} /> <span className="eb__label">Accueil</span>
            </Button>
            <Button size="sm" onClick={() => studio.toEditor()} title="Éditer" aria-label="Éditer">
              <Pencil size={16} /> <span className="eb__label">Éditer</span>
            </Button>
          </>
        )}
      </div>
    </header>
  );
}
