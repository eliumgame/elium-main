import { describe, it, expect } from "vitest";
import { unzipSync } from "fflate";
import { stringifyDeckCooperative, estimateDeckChars } from "../src/slides/coop-deck";
import { makeDelta, applyDelta, type PresenterDeltaMsg } from "../src/slides/presenter-sync";
import { deckToPptx } from "../src/slides/pptx";
import type { Deck, Slide } from "../src/slides/model";

const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMCAQCB4+O0AAAAAElFTkSuQmCC";
const mkSlide = (i: number, src = PNG): Slide => ({
  id: `s${i}`,
  title: `T${i}`,
  body: "",
  bodyHtml: "",
  layout: "blank",
  elements: [{ id: `e${i}`, type: "image", x: 1, y: 1, w: 30, h: 30, src }],
});
const mkDeck = (n: number): Deck => ({
  slides: Array.from({ length: n }, (_, i) => mkSlide(i)),
  active: 0,
  theme: "dark",
  transition: "fade",
});

describe("sérialisation coopérative du deck", () => {
  it("laisse les petits decks au chemin habituel", async () => {
    expect(await stringifyDeckCooperative(mkDeck(5))).toBeNull();
  });
  it("produit le même contenu que JSON.stringify pour un gros deck", async () => {
    const d = mkDeck(150);
    const blob = await stringifyDeckCooperative(d);
    expect(blob).not.toBeNull();
    expect(JSON.parse(await blob!.text())).toEqual(JSON.parse(JSON.stringify(d)));
  });
  it("estime la taille sans sérialiser", () => {
    const big = "x".repeat(500_000);
    expect(estimateDeckChars({ ...mkDeck(2), slides: [mkSlide(0, big), mkSlide(1, big)] })).toBeGreaterThan(1_000_000);
  });
});

describe("delta de la fenêtre orateur", () => {
  it("n'envoie que les diapositives modifiées, puis rien si rien ne change", () => {
    const slides = mkDeck(6).slides;
    const sent = new Map<string, Slide>();
    const first = makeDelta(sent, slides)!;
    expect(first.changed).toHaveLength(6);
    expect(makeDelta(sent, slides)).toBeNull();
    const edited = slides.map((s, i) => (i === 3 ? { ...s, title: "nouveau" } : s));
    const d = makeDelta(sent, edited)!;
    expect(d.changed.map((s) => s.id)).toEqual(["s3"]);
    const msg: PresenterDeltaMsg = { type: "delta", ids: d.ids, changed: d.changed, theme: "dark", title: "x" };
    const applied = applyDelta(slides, msg)!;
    expect(applied.map((s) => s.title)).toEqual(edited.map((s) => s.title));
    expect(applied[0]).toBe(slides[0]);
  });
  it("détecte un déplacement et une diapositive inconnue", () => {
    const slides = mkDeck(3).slides;
    const sent = new Map<string, Slide>();
    makeDelta(sent, slides);
    const moved = [slides[2], slides[0], slides[1]];
    const d = makeDelta(sent, moved)!;
    expect(d.ids).toEqual(["s2", "s0", "s1"]);
    expect(d.changed).toHaveLength(0);
    expect(applyDelta([], { type: "delta", ids: ["zz"], changed: [], theme: "light", title: "" })).toBeNull();
  });
});

describe("export pptx : médias dédoublonnés et non recompressés", () => {
  it("stocke une seule fois une image répétée sur 50 diapositives", () => {
    const files = unzipSync(deckToPptx(mkDeck(50)));
    const media = Object.keys(files).filter((k) => k.startsWith("ppt/media/"));
    expect(media).toHaveLength(1);
  });
});
