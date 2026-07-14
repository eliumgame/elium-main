/**
 * Presenter view — the speaker's private screen, opened in a separate window at
 * ?presenter=1. It renders purely from BroadcastChannel messages sent by the main
 * editor window (current slide + reveal step, next-slide preview, speaker notes,
 * elapsed timer) and posts navigation intents back. Works for both the local and
 * collaborative editors since all data flows from the already-open main window.
 */
import { useEffect, useRef, useState } from "react";
import { Timer, ChevronLeft, ChevronRight, MonitorPlay } from "lucide-react";
import SlideCanvas from "./canvas";
import { elementsOf, REF_H, type Slide, type SlideTheme } from "./model";
import { revealAt, maxStep } from "./playback";
import { PRESENTER_CHANNEL, type PresenterMsg } from "./presenter-sync";
import "./slides.css";

function useMeasureScale(): [React.RefObject<HTMLDivElement>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.5);
  useEffect(() => {
    const node = ref.current; if (!node) return;
    const ro = new ResizeObserver(() => { const h = node.clientHeight; if (h) setScale(h / REF_H); });
    ro.observe(node);
    return () => ro.disconnect();
  }, []);
  return [ref, scale];
}

export default function PresenterView() {
  const [slides, setSlides] = useState<Slide[]>([]);
  const [theme, setTheme] = useState<SlideTheme>("light");
  const [title, setTitle] = useState("");
  const [idx, setIdx] = useState(0);
  const [step, setStep] = useState(0);
  const [startedAt, setStartedAt] = useState<number>(() => Date.now());
  const [ended, setEnded] = useState(false);
  const [now, setNow] = useState<number>(() => Date.now());
  const chan = useRef<BroadcastChannel | null>(null);

  const nav = (dir: "next" | "prev") => chan.current?.postMessage({ type: "nav", dir } as PresenterMsg);

  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const ch = new BroadcastChannel(PRESENTER_CHANNEL);
    chan.current = ch;
    ch.onmessage = (e: MessageEvent) => {
      const m = e.data as PresenterMsg;
      if (m.type === "deck") { setSlides(m.slides); setTheme(m.theme); setTitle(m.title); setEnded(false); }
      else if (m.type === "pos") { setIdx(m.idx); setStep(m.step); setStartedAt(m.startedAt); if (!m.presenting) setEnded(true); }
      else if (m.type === "end") setEnded(true);
    };
    ch.postMessage({ type: "ready" } as PresenterMsg);
    return () => { ch.close(); chan.current = null; };
  }, []);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight" || e.key === " " || e.key === "PageDown") { e.preventDefault(); nav("next"); }
      else if (e.key === "ArrowLeft" || e.key === "PageUp") { e.preventDefault(); nav("prev"); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const [curRef, curScale] = useMeasureScale();
  const [nextRef, nextScale] = useMeasureScale();

  const cur = slides[idx];
  const next = slides[idx + 1];
  const curEls = cur ? (cur.elements ?? elementsOf(cur)) : [];
  const nextEls = next ? (next.elements ?? elementsOf(next)) : [];
  const reveal = cur ? revealAt(curEls, cur.anims, step) : undefined;
  const steps = maxStep(cur?.anims);

  const elapsed = Math.max(0, Math.floor((now - startedAt) / 1000));
  const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
  const ss = String(elapsed % 60).padStart(2, "0");

  if (!cur) {
    return <div className="pv pv--empty"><MonitorPlay size={44} /><p>En attente de la présentation…</p></div>;
  }

  return (
    <div className="pv">
      <div className="pv__bar">
        <span className="pv__badge"><MonitorPlay size={15} /> Vue présentateur</span>
        <span className="pv__title" title={title}>{title}</span>
        <span className="pv__timer"><Timer size={15} /> {mm}:{ss}</span>
      </div>

      <div className="pv__main">
        <div className="pv__stage">
          <div className="pv__frame" ref={curRef}>
            <SlideCanvas slide={cur} elements={curEls} theme={theme} reveal={reveal} scale={curScale} />
          </div>
        </div>
        <div className="pv__controls">
          <button className="icon-btn" title="Précédent" onClick={() => nav("prev")}><ChevronLeft size={22} /></button>
          <span className="pv__pos">{idx + 1} / {slides.length}{steps > 0 ? ` · clic ${step}/${steps}` : ""}</span>
          <button className="icon-btn" title="Suivant" onClick={() => nav("next")}><ChevronRight size={22} /></button>
        </div>
      </div>

      <aside className="pv__side">
        <div className="pv__label">Diapo suivante</div>
        <div className="pv__next" ref={nextRef}>
          {next ? <SlideCanvas slide={next} elements={nextEls} theme={theme} scale={nextScale} /> : <div className="pv__end">Fin de la présentation</div>}
        </div>
        <div className="pv__label">Notes de l'orateur</div>
        <div className="pv__notes">{cur.notes ? cur.notes : <span className="pv__notes-empty">Aucune note pour cette diapo.</span>}</div>
      </aside>

      {ended && <div className="pv__banner">Présentation terminée — vous pouvez fermer cette fenêtre.</div>}
    </div>
  );
}
