/** Aperçu réel d'un modèle de diapositive (ses éléments dessinés en miniature), pour la galerie « Modèles ». */
import { memo, useMemo } from "react";
import SlideCanvas from "./canvas";
import { REF_H, type Slide, type SlideTheme } from "./model";
import type { SlideTemplate } from "./templates";

const PREVIEW_W = 132;

function TemplatePreviewImpl({ tpl, theme }: { tpl: SlideTemplate; theme: SlideTheme }) {
  const slide = useMemo<Slide>(
    () => ({
      id: `tpl-${tpl.id}`,
      title: "",
      body: "",
      bodyHtml: "",
      layout: "blank",
      elements: tpl.build(),
      ...(tpl.background ? { background: tpl.background } : {}),
    }),
    [tpl],
  );
  return (
    <SlideCanvas
      slide={slide}
      elements={slide.elements ?? []}
      theme={theme}
      scale={PREVIEW_W / (REF_H * (16 / 9))}
      slideNumber={1}
    />
  );
}

export default memo(TemplatePreviewImpl);
