import { describe, it, expect } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import { deckToPptx } from "../src/slides/pptx";
import { importPptx } from "../src/slides/pptx-import";
import type { Deck } from "../src/slides/model";

const MP4 = "data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDE=";
const MP3 = "data:audio/mpeg;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4Ljc2LjEwMAAAAAAAAAAAAAAA";

const deck = (): Deck => ({
  active: 0,
  slides: [
    {
      id: "s",
      title: "",
      body: "",
      layout: "blank",
      elements: [
        {
          id: "v",
          type: "media",
          x: 10,
          y: 10,
          w: 50,
          h: 50,
          media: { kind: "video", src: MP4, mime: "video/mp4", name: "démo.mp4", trimStart: 1.5, trimEnd: 8 },
        },
        {
          id: "a",
          type: "media",
          x: 10,
          y: 70,
          w: 40,
          h: 10,
          media: { kind: "audio", src: MP3, mime: "audio/mpeg", name: "voix.mp3" },
        },
      ],
    },
  ],
});

describe("PPTX — audio et vidéo", () => {
  const bytes = deckToPptx(deck());
  const zip = unzipSync(bytes);
  it("écrit les parties média, les relations vidéo/audio + média Office, l'affiche et les types de contenu", () => {
    const names = Object.keys(zip).filter((k) => k.startsWith("ppt/media/"));
    expect(names.some((n) => n.endsWith(".mp4"))).toBe(true);
    expect(names.some((n) => n.endsWith(".mp3"))).toBe(true);
    const slide = strFromU8(zip["ppt/slides/slide1.xml"]!);
    expect(slide).toContain("<a:videoFile");
    expect(slide).toContain("<a:audioFile");
    expect(slide).toContain('<p14:trim st="1500" end="8000"/>');
    const rels = strFromU8(zip["ppt/slides/_rels/slide1.xml.rels"]!);
    expect(rels).toContain("relationships/video");
    expect(rels).toContain("relationships/audio");
    expect(rels).toContain("office/2007/relationships/media");
    const ct = strFromU8(zip["[Content_Types].xml"]!);
    expect(ct).toContain('Extension="mp4" ContentType="video/mp4"');
    expect(ct).toContain('Extension="mp3" ContentType="audio/mpeg"');
  });
  it("aller-retour : médias, nom et rognage conservés", () => {
    const back = importPptx(bytes).slides[0]!.elements!.filter((e) => e.type === "media");
    expect(back).toHaveLength(2);
    const v = back.find((e) => e.media!.kind === "video")!;
    expect(v.media!.src.startsWith("data:video/mp4;base64,")).toBe(true);
    expect(v.media!.src.endsWith(MP4.split(",")[1]!)).toBe(true);
    expect(v.media!.name).toBe("démo.mp4");
    expect(v.media!.trimStart).toBe(1.5);
    expect(v.media!.trimEnd).toBe(8);
    const a = back.find((e) => e.media!.kind === "audio")!;
    expect(a.media!.mime).toBe("audio/mpeg");
    expect(a.media!.trimStart).toBeUndefined();
  });
});
