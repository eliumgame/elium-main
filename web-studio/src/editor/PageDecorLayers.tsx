/** Calques de la feuille : bordures de page (une par page) et numéros de ligne dans la marge. */
import { useEffect, useState, type RefObject } from "react";
import type { Editor } from "@tiptap/react";
import { borderCss, groupLineTops, lineNumberLabels, type LineLabel, type LineNumbering, type PageBorder } from "./pageDecor";

interface PageBox {
  top: number;
  height: number;
}

const MM_PX = 96 / 25.4;

export function PageBorders({ border, pages, widthMm }: { border: PageBorder; pages: PageBox[] | null; widthMm: number }) {
  const css = borderCss(border);
  const off = border.offsetMm * MM_PX;
  const boxes: PageBox[] = pages?.length ? pages : [{ top: 0, height: 0 }];
  return (
    <div className="elium-pageborders" aria-hidden="true" style={{ width: `${widthMm}mm` }}>
      {boxes.map((p, i) => (
        <div
          key={i}
          className="elium-pageborder"
          style={{
            top: p.top + off,
            ...(p.height ? { height: p.height - 2 * off } : { bottom: off }),
            left: css.inset,
            right: css.inset,
            border: css.border,
          }}
        />
      ))}
    </div>
  );
}

/** Mesure les lignes de texte de l'éditeur et affiche leur numéro dans la marge gauche. */
export function LineNumbers({
  editor,
  pageRef,
  cfg,
  pages,
  zoom,
  marginLeftPx,
}: {
  editor: Editor;
  pageRef: RefObject<HTMLDivElement>;
  cfg: LineNumbering;
  pages: PageBox[] | null;
  zoom: number;
  marginLeftPx: number;
}) {
  const [labels, setLabels] = useState<LineLabel[]>([]);

  useEffect(() => {
    let raf = 0;
    const measure = () => {
      raf = 0;
      const page = pageRef.current;
      if (!page || editor.isDestroyed) return;
      const base = page.getBoundingClientRect().top;
      const tops: number[] = [];
      const blocks = editor.view.dom.querySelectorAll("p, h1, h2, h3, h4, li > p, td p, th p");
      blocks.forEach((el) => {
        // Les paragraphes de tableau ne sont pas numérotés (comme dans Word) ; les autres le sont.
        if (el.closest("td, th, .elium-page-gap, .elium-bibliography, .elium-footnotes")) return;
        const range = document.createRange();
        range.selectNodeContents(el);
        const rects = Array.from(range.getClientRects()).filter((r) => r.height > 0);
        const lineTops = groupLineTops(rects.map((r) => (r.top - base) / zoom));
        tops.push(...lineTops);
      });
      setLabels(lineNumberLabels(tops, pages, cfg));
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(measure);
    };
    schedule();
    editor.on("update", schedule);
    window.addEventListener("resize", schedule);
    return () => {
      editor.off("update", schedule);
      window.removeEventListener("resize", schedule);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [editor, pageRef, cfg, pages, zoom]);

  return (
    <div className="elium-linenos" aria-hidden="true">
      {labels.map((l, i) => (
        <span key={i} className="elium-lineno" style={{ top: l.top, left: Math.max(0, marginLeftPx - 34) }}>
          {l.n}
        </span>
      ))}
    </div>
  );
}
