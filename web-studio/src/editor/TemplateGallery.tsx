/**
 * Galerie de modèles : filtre par catégorie, aperçu réel du contenu (rendu par
 * l'export HTML du document) et « Nouveau depuis un modèle ».
 */
import { useMemo, useState } from "react";
import { TEMPLATES, type Template, type TemplateCategory } from "./templates";
import { createDocumentModel } from "../format/document";
import { docToHtml } from "../export/exporters";
import "./template-gallery.css";

const ALL = "Tous" as const;
const CATEGORIES: (TemplateCategory | typeof ALL)[] = [
  ALL,
  "Général",
  "Courrier",
  "Professionnel",
  "Réunion",
  "Finance",
];

/** HTML d'aperçu d'un modèle (rendu une seule fois par modèle). */
export function templatePreviewHtml(tpl: Template): string {
  const { doc } = tpl.build();
  return docToHtml(createDocumentModel(doc, tpl.page));
}

export default function TemplateGallery({ onPick }: { onPick: (tpl: Template) => void }) {
  const [cat, setCat] = useState<(typeof CATEGORIES)[number]>(ALL);
  const previews = useMemo(() => new Map(TEMPLATES.map((t) => [t.id, templatePreviewHtml(t)])), []);
  const shown = TEMPLATES.filter((t) => cat === ALL || (t.category ?? "Général") === cat);
  return (
    <div className="tplgal">
      <div className="tplgal__tabs" role="tablist" aria-label="Catégories de modèles">
        {CATEGORIES.map((c) => (
          <button
            key={c}
            role="tab"
            aria-selected={cat === c}
            className={`tplgal__tab ${cat === c ? "is-active" : ""}`}
            onClick={() => setCat(c)}
          >
            {c}
          </button>
        ))}
      </div>
      <div className="tplgal__grid">
        {shown.map((t) => (
          <button
            key={t.id}
            className="tplgal__card"
            onClick={() => onPick(t)}
            aria-label={`Nouveau depuis le modèle ${t.label}`}
          >
            <div className="tplgal__preview" aria-hidden="true">
              <div className="tplgal__page" dangerouslySetInnerHTML={{ __html: previews.get(t.id) ?? "" }} />
            </div>
            <div className="tplgal__label">{t.label}</div>
            <div className="tplgal__desc">{t.description}</div>
          </button>
        ))}
      </div>
    </div>
  );
}
