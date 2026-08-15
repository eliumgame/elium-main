/**
 * La galerie de formes du ruban.
 *
 * Chaque vignette est la **vraie** forme, dessinée par le générateur de
 * `shapes.ts` : une icône dessinée à part finirait par ne plus ressembler à ce
 * qu'on obtient en cliquant. Les vignettes sont carrées et neutres (un seul jeu
 * de couleurs) pour que l'œil compare des géométries, pas des styles.
 */
import { useMemo, useState } from "react";
import { SHAPES, SHAPE_GROUPS, shapeSvg, type ShapeGroup, type ShapeKind } from "./shapes";

/** Le style des vignettes : neutre, contrasté, indépendant du thème. */
const THUMB_STYLE = {
  fill: "#dbeafe",
  fillOpacity: 1,
  gradient: "" as const,
  fill2: "#93c5fd",
  gradientAngle: 90,
  strokeColor: "#2563eb",
  strokeWidth: 1,
  dash: "solid" as const,
  shadow: false,
  textColor: "#0f172a",
  vAlign: "middle" as const,
  padMm: 0,
};

/** Taille de la vignette en « millimètres » du générateur (unités du viewBox). */
const THUMB_MM = 22;

export default function ShapeGallery({ onPick, onClose }: { onPick: (kind: ShapeKind) => void; onClose: () => void }) {
  const [filter, setFilter] = useState<ShapeGroup | "all">("all");

  // Les 53 tracés ne changent jamais : les générer à chaque frappe du filtre
  // referait tout le travail pour rien.
  const thumbs = useMemo(() => {
    const map = new Map<ShapeKind, string>();
    for (const s of SHAPES) {
      // Une ligne dans un carré ne se lit pas : elle est tracée en diagonale
      // légèrement aplatie, comme dans la galerie de Word.
      const h = s.line ? THUMB_MM * 0.55 : THUMB_MM;
      map.set(s.kind, shapeSvg(s.kind, THUMB_MM, h, THUMB_STYLE, undefined, `gal-${s.kind}`));
    }
    return map;
  }, []);

  const groups = filter === "all" ? SHAPE_GROUPS : SHAPE_GROUPS.filter((g) => g.id === filter);

  return (
    <div className="shapegal">
      <div className="shapegal__filters">
        <button
          type="button"
          className={`shapegal__filter${filter === "all" ? " is-active" : ""}`}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setFilter("all")}
        >
          Toutes
        </button>
        {SHAPE_GROUPS.map((g) => (
          <button
            key={g.id}
            type="button"
            className={`shapegal__filter${filter === g.id ? " is-active" : ""}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setFilter(g.id)}
          >
            {g.label}
          </button>
        ))}
      </div>

      <div className="shapegal__body">
        {groups.map((group) => (
          <section key={group.id} className="shapegal__group">
            <div className="shapegal__title">{group.label}</div>
            <div className="shapegal__grid">
              {SHAPES.filter((s) => s.group === group.id).map((s) => (
                <button
                  key={s.kind}
                  type="button"
                  className="shapegal__item"
                  title={s.label}
                  aria-label={s.label}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    onPick(s.kind);
                    onClose();
                  }}
                >
                  <span
                    className="shapegal__thumb"
                    // Le tracé vient du générateur ; c'est du SVG que nous
                    // produisons nous-mêmes, jamais du contenu de document.
                    dangerouslySetInnerHTML={{ __html: thumbs.get(s.kind) ?? "" }}
                  />
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>
      <div className="shapegal__foot">
        Glissez la poignée du haut pour déplacer, celle du coin pour redimensionner, celle du dessus pour faire pivoter.
        Alt ignore le quadrillage.
      </div>
    </div>
  );
}
