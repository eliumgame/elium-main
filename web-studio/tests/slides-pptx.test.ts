import { describe, it, expect } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import { deckToPptx } from "../src/slides/pptx";
import type { Deck } from "../src/slides/model";

function buildDeck(): Deck {
  return {
    theme: "light",
    active: 0,
    transition: "fade",
    slides: [
      { id: "s1", title: "Bienvenue", body: "", bodyHtml: "<ul><li>Point A</li><li>Point B</li></ul>", layout: "title-content" },
      { id: "s2", title: "Formes", body: "", bodyHtml: "<p>Texte simple</p>", layout: "title-content",
        shapes: [
          { id: "sh1", kind: "rect", x: 10, y: 10, w: 30, h: 20, fill: "#bfdbfe", stroke: "#2563eb", strokeWidth: 2, text: "Boîte" },
          { id: "sh2", kind: "arrow", x: 50, y: 50, w: 40, h: 5, fill: "transparent", stroke: "#0f172a", strokeWidth: 3 },
        ],
      },
    ],
  };
}

describe("PPTX export", () => {
  it("produces a well-formed package", () => {
    const bytes = deckToPptx(buildDeck());
    expect(bytes.length).toBeGreaterThan(1000);
    const zip = unzipSync(bytes);
    const names = Object.keys(zip);
    // Required package parts.
    for (const part of [
      "[Content_Types].xml",
      "_rels/.rels",
      "ppt/presentation.xml",
      "ppt/_rels/presentation.xml.rels",
      "ppt/slideMasters/slideMaster1.xml",
      "ppt/slideLayouts/slideLayout1.xml",
      "ppt/theme/theme1.xml",
      "ppt/slides/slide1.xml",
      "ppt/slides/slide2.xml",
      "ppt/slides/_rels/slide1.xml.rels",
    ]) {
      expect(names).toContain(part);
    }
  });

  it("carries the slide content (title, bullets, shapes)", () => {
    const zip = unzipSync(deckToPptx(buildDeck()));
    const s1 = strFromU8(zip["ppt/slides/slide1.xml"]);
    expect(s1).toContain("Bienvenue");
    expect(s1).toContain("Point A");
    expect(s1).toContain("buChar"); // bullets
    const s2 = strFromU8(zip["ppt/slides/slide2.xml"]);
    expect(s2).toContain("Boîte");
    expect(s2).toContain('prst="rect"');
    expect(s2).toContain('prst="line"');
    expect(s2).toContain("tailEnd"); // arrow head
  });

  it("lists every slide in presentation.xml and content types", () => {
    const zip = unzipSync(deckToPptx(buildDeck()));
    const pres = strFromU8(zip["ppt/presentation.xml"]);
    expect((pres.match(/<p:sldId /g) || []).length).toBe(2);
    const ct = strFromU8(zip["[Content_Types].xml"]);
    expect(ct).toContain("/ppt/slides/slide1.xml");
    expect(ct).toContain("/ppt/slides/slide2.xml");
  });

  it("preserves inline bold / italic / underline / colour as separate runs", () => {
    const deck = buildDeck();
    deck.slides[1].bodyHtml = '<p>normal <b>gras</b> <i>ital</i> <u>souligné</u> <span style="color: #ff0000">rouge</span></p>';
    const s2 = strFromU8(unzipSync(deckToPptx(deck))["ppt/slides/slide2.xml"]);
    // Multiple runs in the body paragraph, each carrying its own formatting.
    expect(s2).toContain("<a:t>normal </a:t>");
    expect(s2).toMatch(/b="1"[^>]*><a:solidFill>[\s\S]*?<a:t>gras<\/a:t>/);
    expect(s2).toMatch(/i="1"[^>]*>[\s\S]*?<a:t>ital<\/a:t>/);
    expect(s2).toMatch(/u="sng"[^>]*>[\s\S]*?<a:t>souligné<\/a:t>/);
    expect(s2).toContain('<a:srgbClr val="FF0000"/>');
    expect(s2).toContain("<a:t>rouge</a:t>");
  });

  it("still emits bullets and plain text after the rich-run change", () => {
    const zip = unzipSync(deckToPptx(buildDeck()));
    const s1 = strFromU8(zip["ppt/slides/slide1.xml"]);
    expect(s1).toContain("Point A");
    expect(s1).toContain("buChar");
  });

  it("embeds images as media with relationships", () => {
    const deck = buildDeck();
    deck.slides[0].layout = "image-full";
    deck.slides[0].image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const zip = unzipSync(deckToPptx(deck));
    const names = Object.keys(zip);
    expect(names.some((n) => n.startsWith("ppt/media/image"))).toBe(true);
    const rels = strFromU8(zip["ppt/slides/_rels/slide1.xml.rels"]);
    expect(rels).toContain("../media/image1.png");
  });
});

function chartDeck(kind: "bar" | "line" | "pie"): Deck {
  return {
    theme: "light",
    active: 0,
    slides: [
      {
        id: "sc", title: "", body: "", layout: "blank",
        elements: [
          { id: "c1", type: "chart", x: 10, y: 12, w: 80, h: 70,
            chart: { kind, title: "Ventes", labels: ["Jan", "Fév", "Mar"], values: [12, 19, 9] } },
        ],
      },
    ],
  };
}

describe("PPTX native charts (c:chart)", () => {
  it("emits a native chart part wired into the slide, rels and content types", () => {
    const zip = unzipSync(deckToPptx(chartDeck("bar")));
    // The chart part exists and carries the data + a bar plot.
    const chart = strFromU8(zip["ppt/charts/chart1.xml"]);
    expect(chart).toContain("<c:barChart>");
    expect(chart).toContain("<c:barDir val=\"col\"/>");
    for (const label of ["Jan", "Fév", "Mar"]) expect(chart).toContain(`<c:v>${label}</c:v>`);
    for (const v of ["12", "19", "9"]) expect(chart).toContain(`<c:v>${v}</c:v>`);
    expect(chart).toContain("Ventes"); // series/title text

    // The slide references it via a graphicFrame + c:chart r:id (NOT a picture).
    const slide = strFromU8(zip["ppt/slides/slide1.xml"]);
    expect(slide).toContain("<p:graphicFrame>");
    expect(slide).toMatch(/<c:chart[^>]*r:id="rId\d+"/);

    // The relationship is a chart relationship pointing at the part.
    const rels = strFromU8(zip["ppt/slides/_rels/slide1.xml.rels"]);
    expect(rels).toContain("../charts/chart1.xml");
    expect(rels).toContain("/relationships/chart");

    // Content types declare the chart part.
    const ct = strFromU8(zip["[Content_Types].xml"]);
    expect(ct).toContain("/ppt/charts/chart1.xml");
    expect(ct).toContain("drawingml.chart+xml");
  });

  it("maps chart kind to the right plot element", () => {
    expect(strFromU8(unzipSync(deckToPptx(chartDeck("pie")))["ppt/charts/chart1.xml"])).toContain("<c:pieChart>");
    expect(strFromU8(unzipSync(deckToPptx(chartDeck("line")))["ppt/charts/chart1.xml"])).toContain("<c:lineChart>");
  });

  it("gives each chart across slides a globally unique part name", () => {
    const deck = chartDeck("bar");
    deck.slides.push({ ...chartDeck("pie").slides[0], id: "sc2" });
    const zip = unzipSync(deckToPptx(deck));
    expect(Object.keys(zip)).toContain("ppt/charts/chart1.xml");
    expect(Object.keys(zip)).toContain("ppt/charts/chart2.xml");
  });
});
