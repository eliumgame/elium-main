import { describe, it, expect } from "vitest";
import { MAX_MEDIA_BYTES, clampTrim, formatTime, mediaExt, mediaKindOf, mimeFromExt, newMediaElement, playbackSrc, validateMediaFile } from "../src/slides/media";

describe("médias de présentation", () => {
  it("type par MIME, puis par extension quand le MIME est absent", () => {
    expect(mediaKindOf("video/mp4")).toBe("video");
    expect(mediaKindOf("audio/mpeg")).toBe("audio");
    expect(mediaKindOf("", "clip.WEBM")).toBe("video");
    expect(mediaKindOf("", "voix.m4a")).toBe("audio");
    expect(mediaKindOf("application/pdf", "x.pdf")).toBeNull();
  });
  it("validation : format, taille, fichier vide", () => {
    expect(validateMediaFile({ name: "a.mp4", type: "video/mp4", size: 1000 })).toBeNull();
    expect(validateMediaFile({ name: "a.pdf", type: "application/pdf", size: 10 })).toMatch(/Format non pris en charge/);
    expect(validateMediaFile({ name: "a.mp4", type: "video/mp4", size: MAX_MEDIA_BYTES + 1 })).toMatch(/trop volumineux/);
    expect(validateMediaFile({ name: "a.mp3", type: "audio/mpeg", size: 0 })).toMatch(/vide/);
  });
  it("rognage cohérent", () => {
    expect(clampTrim(-3, 5)).toEqual({ trimStart: 0, trimEnd: 5 });
    expect(clampTrim(10, 4)).toEqual({ trimStart: 10, trimEnd: 0 }); // fin avant le début → jusqu'à la fin
    expect(clampTrim(2, 99, 30)).toEqual({ trimStart: 2, trimEnd: 30 });
    expect(clampTrim(50, undefined, 30).trimStart).toBe(29.9);
    expect(clampTrim(NaN, NaN)).toEqual({ trimStart: 0, trimEnd: 0 });
  });
  it("fragment de lecture #t=", () => {
    const base = { kind: "video" as const, src: "data:video/mp4;base64,AAAA", mime: "video/mp4" };
    expect(playbackSrc(base)).toBe(base.src);
    expect(playbackSrc({ ...base, trimStart: 1.5 })).toBe("data:video/mp4;base64,AAAA#t=1.5");
    expect(playbackSrc({ ...base, trimStart: 1, trimEnd: 9 })).toBe("data:video/mp4;base64,AAAA#t=1,9");
    expect(playbackSrc({ ...base, src: "blob:x#t=3", trimEnd: 4 })).toBe("blob:x#t=0,4");
  });
  it("format du temps, extensions, éléments", () => {
    expect(formatTime(65)).toBe("1:05");
    expect(formatTime(7.5)).toBe("0:07,5");
    expect(mediaExt("video/webm").ext).toBe("webm");
    expect(mediaExt("audio/mpeg").ext).toBe("mp3");
    expect(mediaExt("video/inconnu").ext).toBe("mp4");
    expect(mimeFromExt("M4A")).toBe("audio/mp4");
    const a = newMediaElement({ kind: "audio", src: "data:audio/mpeg;base64,AA", mime: "audio/mpeg" });
    const v = newMediaElement({ kind: "video", src: "data:video/mp4;base64,AA", mime: "video/mp4" });
    expect(a.type).toBe("media");
    expect(a.h).toBeLessThan(v.h);
  });
});
