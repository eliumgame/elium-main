/** Insérer / modifier un diagramme SmartArt depuis un plan (une ligne par nœud, retrait = niveau). */
import { useState } from "react";
import { Modal, Button } from "../ui/components";
import { DiagramView } from "./canvas";
import { DEFAULT_OUTLINE, DIAGRAM_KIND_LABELS, DIAGRAM_PALETTE, nodeCount } from "./diagram";
import type { DiagramData, DiagramKind } from "./model";

export default function DiagramDialog({
  initial,
  onSave,
  onClose,
}: {
  initial?: DiagramData;
  onSave: (d: DiagramData) => void;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<DiagramKind>(initial?.kind ?? "process");
  const [outline, setOutline] = useState(initial?.outline ?? DEFAULT_OUTLINE.process);
  const [colors, setColors] = useState<string[]>(initial?.colors ?? DIAGRAM_PALETTE.slice(0, 4));
  const n = nodeCount(outline);
  return (
    <Modal
      title={initial ? "Modifier le diagramme" : "Insérer un diagramme"}
      onClose={onClose}
      wide
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Annuler
          </Button>
          <Button
            disabled={n === 0}
            onClick={() => {
              onSave({ kind, outline, colors });
              onClose();
            }}
          >
            {initial ? "Mettre à jour" : "Insérer"}
          </Button>
        </>
      }
    >
      <div className="dgdlg">
        <div>
          <label className="dgdlg__field">
            Type
            <select
              className="settings__select"
              value={kind}
              onChange={(e) => {
                const k = e.target.value as DiagramKind;
                // on ne remplace pas un plan déjà personnalisé
                if (outline === DEFAULT_OUTLINE[kind]) setOutline(DEFAULT_OUTLINE[k]);
                setKind(k);
              }}
            >
              {(Object.keys(DIAGRAM_KIND_LABELS) as DiagramKind[]).map((k) => (
                <option key={k} value={k}>
                  {DIAGRAM_KIND_LABELS[k]}
                </option>
              ))}
            </select>
          </label>
          <label className="dgdlg__field">
            Plan (une ligne par élément ; retrait de 2 espaces = sous-élément)
            <textarea
              className="input dgdlg__outline"
              rows={10}
              value={outline}
              onChange={(e) => setOutline(e.target.value)}
              aria-label="Plan du diagramme"
            />
          </label>
          <div className="dgdlg__colors" role="group" aria-label="Couleurs">
            {colors.map((c, i) => (
              <input
                key={i}
                type="color"
                value={c}
                aria-label={`Couleur ${i + 1}`}
                onChange={(e) => setColors(colors.map((x, k) => (k === i ? e.target.value : x)))}
              />
            ))}
          </div>
          <p className="dgdlg__hint">
            {n} élément{n > 1 ? "s" : ""}. Le diagramme reste modifiable : rouvrez-le et changez le plan.
          </p>
        </div>
        <div className="dgdlg__preview">
          <DiagramView d={{ kind, outline, colors }} scale={0.35} w={100} h={56} />
        </div>
      </div>
    </Modal>
  );
}
