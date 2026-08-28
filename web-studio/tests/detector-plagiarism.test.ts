import { describe, it, expect } from "vitest";
import { jaccardSimilarity, selectPassages } from "../src/detector/plagiarism/shingles";
import { runPlagiarismScan } from "../src/detector/plagiarism/runPlagiarismScan";
import type { ParagraphModel, SearchProvider, SearchResult } from "../src/detector/types";

const para = (index: number, text: string): ParagraphModel => ({ index, text, runs: [{ text }] });

const RARE_WORDS = [
  "photosynthèse",
  "cristallographie",
  "thermodynamique",
  "kaléidoscope",
  "extraterrestre",
  "bureaucratique",
  "anticonstitutionnel",
  "magnétosphère",
  "stratigraphie",
  "électromagnétisme",
  "paléontologie",
  "microorganisme",
  "chlorophylle",
  "stœchiométrie",
  "radioactivité",
  "phytoplancton",
  "sédimentation",
  "biodiversité",
  "cartographie",
  "spectroscopie",
];

const BLAND_WORDS = [
  "le", "de", "la", "et", "que", "qui", "dans", "pour", "avec", "sur",
  "ce", "cette", "il", "elle", "on", "nous", "vous", "je", "tu", "est",
  "sont", "a", "ont", "pas", "ni", "mais", "donc", "or", "car", "si",
];

// A paragraph packed with rare/long content words — low stopword ratio, high distinctiveness.
function distinctiveParagraph(seed: number, wordCount = 25): string {
  const words: string[] = [];
  for (let i = 0; i < wordCount; i++) words.push(RARE_WORDS[(seed + i) % RARE_WORDS.length]);
  return words.join(" ") + ".";
}

// A paragraph made entirely of function words — qualifies (>=8 words) but scores low.
function blandParagraph(wordCount = 25): string {
  const words: string[] = [];
  for (let i = 0; i < wordCount; i++) words.push(BLAND_WORDS[i % BLAND_WORDS.length]);
  return words.join(" ") + ".";
}

// Half stopwords, half content words — qualifies with a middling score, lower
// than a pure distinctiveParagraph but still above blandParagraph.
function moderateParagraph(seed: number, wordCount = 25): string {
  const words: string[] = [];
  for (let i = 0; i < wordCount; i++) {
    words.push(i % 2 === 0 ? BLAND_WORDS[i % BLAND_WORDS.length] : RARE_WORDS[(seed + i) % RARE_WORDS.length]);
  }
  return words.join(" ") + ".";
}

describe("jaccardSimilarity", () => {
  it("is 1 for identical text", () => {
    const text = "Le soleil se lève à l'est chaque matin sans exception notable.";
    expect(jaccardSimilarity(text, text)).toBeCloseTo(1, 5);
  });

  it("ignores case and punctuation differences", () => {
    const a = "Le soleil se lève à l'est chaque matin sans exception.";
    const b = "LE SOLEIL SE LÈVE À L'EST CHAQUE MATIN SANS EXCEPTION";
    expect(jaccardSimilarity(a, b, 3)).toBeCloseTo(1, 5);
  });

  it("is near zero for unrelated passages", () => {
    const a = distinctiveParagraph(0);
    const b = "Le chat dort paisiblement sur le canapé du salon pendant que la pluie tombe dehors.";
    expect(jaccardSimilarity(a, b)).toBeLessThan(0.05);
  });

  it("is high but below 1 for a near-duplicate with a few words changed", () => {
    const a = "La réunion du conseil municipal se tiendra jeudi prochain à dix-neuf heures en mairie.";
    const b = "La réunion du conseil municipal se tiendra vendredi prochain à vingt heures en mairie.";
    const sim = jaccardSimilarity(a, b, 3);
    expect(sim).toBeGreaterThan(0.3);
    expect(sim).toBeLessThan(1);
  });

  it("is 0 when either string has no words", () => {
    expect(jaccardSimilarity("", "quelque chose ici")).toBe(0);
    expect(jaccardSimilarity("!!! ??? ...", "texte normal ici présent")).toBe(0);
  });
});

describe("selectPassages", () => {
  it("skips paragraphs shorter than 8 words", () => {
    const paragraphs = [para(0, "Trop court pour être vérifié."), para(1, distinctiveParagraph(1))];
    const result = selectPassages(paragraphs);
    expect(result.map((p) => p.paragraphIndex)).toEqual([1]);
  });

  it("returns an empty array when nothing qualifies", () => {
    const paragraphs = [para(0, "Trop court."), para(1, "Idem, ici.")];
    expect(selectPassages(paragraphs)).toEqual([]);
  });

  it("prefers the more distinctive passage when the cap forces a choice", () => {
    const paragraphs = [para(0, blandParagraph()), para(1, distinctiveParagraph(0))];
    const result = selectPassages(paragraphs, { maxQueries: 1 });
    expect(result).toHaveLength(1);
    expect(result[0].paragraphIndex).toBe(1);
  });

  it("caps at maxQueries and spreads picks across the whole document instead of clustering at the start", () => {
    const paragraphs: ParagraphModel[] = [];
    // A cluster of highly distinctive paragraphs up front...
    for (let i = 0; i < 20; i++) paragraphs.push(para(i, distinctiveParagraph(i)));
    // ...and lower-scoring (but still qualifying) paragraphs spread through the rest of a long document.
    for (let i = 20; i < 100; i++) paragraphs.push(para(i, moderateParagraph(i)));

    const result = selectPassages(paragraphs, { maxQueries: 10 });
    expect(result).toHaveLength(10);

    // Sorted ascending by paragraph index.
    const indices = result.map((p) => p.paragraphIndex);
    expect(indices).toEqual([...indices].sort((a, b) => a - b));

    // Not exclusively drawn from the highly-distinctive front cluster: naive
    // top-score selection would pick only from indices 0-19.
    expect(indices.some((i) => i >= 50)).toBe(true);
  });

  it("returns everything, sorted by paragraph index, when under the cap", () => {
    const paragraphs = [para(5, distinctiveParagraph(2)), para(1, distinctiveParagraph(1))];
    const result = selectPassages(paragraphs, { maxQueries: 60 });
    expect(result.map((p) => p.paragraphIndex)).toEqual([1, 5]);
  });

  it("returns passage text drawn from the source paragraph", () => {
    const text = distinctiveParagraph(3);
    const result = selectPassages([para(0, text)]);
    expect(result).toHaveLength(1);
    expect(text).toContain(result[0].text.split(" ")[0]);
  });
});

function fakeProvider(
  name: string,
  handler: (query: string, signal?: AbortSignal) => Promise<SearchResult[]>,
): SearchProvider {
  return { name, search: handler };
}

describe("runPlagiarismScan", () => {
  it("keeps only results at or above the similarity threshold", async () => {
    const passageText = distinctiveParagraph(0);
    const paragraphs = [para(0, passageText)];

    const provider = fakeProvider("Fake", async (query) => [
      { title: "Source proche", url: "https://exemple.test/proche", snippet: query },
      {
        title: "Source non liée",
        url: "https://exemple.test/loin",
        snippet: "Le chat dort paisiblement sur le canapé du salon pendant la pluie.",
      },
    ]);

    const result = await runPlagiarismScan(paragraphs, provider);

    expect(result.provider).toBe("Fake");
    expect(result.checkedPassages).toBe(1);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].url).toBe("https://exemple.test/proche");
    expect(result.matches[0].sourceTitle).toBe("Source proche");
    expect(result.matches[0].paragraphIndex).toBe(0);
    expect(result.matches[0].similarity).toBeGreaterThanOrEqual(0.5);
  });

  it("respects maxQueries and only queries that many passages", async () => {
    const paragraphs = Array.from({ length: 20 }, (_, i) => para(i, distinctiveParagraph(i)));
    let calls = 0;
    const provider = fakeProvider("Fake", async () => {
      calls++;
      return [];
    });

    const result = await runPlagiarismScan(paragraphs, provider, { maxQueries: 5 });

    expect(calls).toBe(5);
    expect(result.checkedPassages).toBe(5);
    expect(result.matches).toHaveLength(0);
  });

  it("never runs more than `concurrency` searches at once", async () => {
    const paragraphs = Array.from({ length: 9 }, (_, i) => para(i, distinctiveParagraph(i)));
    let inFlight = 0;
    let maxInFlight = 0;
    const provider = fakeProvider("Fake", async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight--;
      return [];
    });

    const result = await runPlagiarismScan(paragraphs, provider, { concurrency: 3 });

    expect(result.checkedPassages).toBe(9);
    expect(maxInFlight).toBe(3);
  });

  it("calls onProgress once per checked passage with the right processed/total", async () => {
    const paragraphs = Array.from({ length: 4 }, (_, i) => para(i, distinctiveParagraph(i)));
    const provider = fakeProvider("Fake", async () => []);
    const calls: Array<[number, number]> = [];

    await runPlagiarismScan(paragraphs, provider, {
      onProgress: (processed, total) => calls.push([processed, total]),
    });

    expect(calls).toHaveLength(4);
    expect(calls.every(([, total]) => total === 4)).toBe(true);
    expect(calls.map(([processed]) => processed).sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
  });

  it("does not throw when the signal is already aborted, and returns an empty result", async () => {
    const paragraphs = Array.from({ length: 5 }, (_, i) => para(i, distinctiveParagraph(i)));
    let calls = 0;
    const provider = fakeProvider("Fake", async () => {
      calls++;
      return [];
    });
    const controller = new AbortController();
    controller.abort();

    const result = await runPlagiarismScan(paragraphs, provider, { signal: controller.signal });

    expect(calls).toBe(0);
    expect(result.checkedPassages).toBe(0);
    expect(result.matches).toEqual([]);
  });

  it("stops early on a mid-scan abort and returns what was gathered so far, without throwing", async () => {
    const paragraphs = Array.from({ length: 10 }, (_, i) => para(i, distinctiveParagraph(i)));
    const controller = new AbortController();
    let calls = 0;
    const provider = fakeProvider("Fake", async () => {
      calls++;
      controller.abort(); // simulate the user cancelling while the first request is in flight
      return [{ title: "t", url: "https://exemple.test/x", snippet: distinctiveParagraph(0) }];
    });

    const result = await runPlagiarismScan(paragraphs, provider, {
      signal: controller.signal,
      concurrency: 1,
    });

    expect(calls).toBe(1);
    expect(result.checkedPassages).toBe(1);
    expect(result.matches).toEqual([]);
    expect(result.checkedPassages).toBeLessThan(paragraphs.length);
  });
});
