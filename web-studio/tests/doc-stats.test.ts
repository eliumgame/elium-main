import { describe, it, expect } from "vitest";
import {
  averageSentenceLength, countSyllablesFr, countWords, formatMinutes, keywords, readability, textStats,
} from "../src/editor/stats";

describe("Document statistics — word counting", () => {
  it("counts plain words", () => {
    expect(countWords("Le chat dort sur le tapis")).toBe(6);
  });

  it("keeps an elision as one word", () => {
    // "l'État" is one word in French, not two.
    expect(countWords("l'État")).toBe(1);
    expect(countWords("l’État français")).toBe(2);
    expect(countWords("aujourd'hui")).toBe(1);
  });

  it("keeps hyphenated compounds together", () => {
    expect(countWords("porte-parole")).toBe(1);
    expect(countWords("c'est-à-dire")).toBe(1);
    expect(countWords("Saint-Jean-de-Luz")).toBe(1);
  });

  it("does not count punctuation as words", () => {
    expect(countWords("Bonjour, monde ! — vraiment ?")).toBe(3);
    expect(countWords("… ; :")).toBe(0);
  });

  it("counts numbers and alphanumerics", () => {
    expect(countWords("24 000 euros en 2027")).toBe(5);
  });

  it("handles an empty document", () => {
    expect(countWords("")).toBe(0);
    expect(countWords("   \n  ")).toBe(0);
  });
});

describe("Document statistics — totals", () => {
  const text = "Le loyer est de 24 000 euros. Il est payable par trimestre.\nLa durée est de neuf ans.";

  it("reports characters with and without spaces", () => {
    const s = textStats("abc def");
    expect(s.characters).toBe(7);
    expect(s.charactersNoSpaces).toBe(6);
  });

  it("counts sentences on terminators", () => {
    expect(textStats("Un. Deux. Trois.").sentences).toBe(3);
    expect(textStats("Vraiment ? Oui ! Bien.").sentences).toBe(3);
  });

  it("counts a fragment with no terminator as one sentence", () => {
    expect(textStats("Une phrase sans point").sentences).toBe(1);
  });

  it("counts paragraphs from line breaks unless told otherwise", () => {
    expect(textStats("un\n\ndeux\n\ntrois").paragraphs).toBe(3);
    expect(textStats("un\n\ndeux", 7).paragraphs).toBe(7);
  });

  it("estimates reading and speaking time, never zero for real text", () => {
    const s = textStats(text);
    expect(s.words).toBeGreaterThan(10);
    expect(s.readingMinutes).toBe(1);
    expect(s.speakingMinutes).toBe(1);
    const long = textStats(Array.from({ length: 1000 }, () => "mot").join(" "));
    expect(long.readingMinutes).toBe(5);
    expect(long.speakingMinutes).toBe(8);
  });

  it("reports nothing for an empty document", () => {
    const s = textStats("");
    expect(s).toMatchObject({ words: 0, sentences: 0, readingMinutes: 0, speakingMinutes: 0 });
  });

  it("averages sentence length", () => {
    expect(averageSentenceLength(textStats("Un deux trois. Quatre cinq."))).toBeCloseTo(2.5, 5);
  });
});

describe("Document statistics — readability", () => {
  it("declines to score a fragment", () => {
    expect(readability("Trop court").score).toBe(0);
    expect(readability("Trop court").label).toContain("court");
  });

  it("scores short simple sentences as easier than long dense ones", () => {
    const simple = "Le chat dort. Le chien court. La porte est bleue. Il fait beau. Je mange.";
    const dense = "L'incompréhensibilité constitutionnelle des dispositions réglementaires "
      + "particulièrement alambiquées engendre invariablement une interprétation "
      + "administrative extraordinairement problématique pour les administrés concernés.";
    expect(readability(simple).score).toBeGreaterThan(readability(dense).score);
  });

  it("stays inside 0..100", () => {
    const s = readability(Array.from({ length: 60 }, () => "anticonstitutionnellement").join(" ") + ".");
    expect(s.score).toBeGreaterThanOrEqual(0);
    expect(s.score).toBeLessThanOrEqual(100);
  });
});

describe("Document statistics — syllables", () => {
  it("counts vowel groups", () => {
    expect(countSyllablesFr("chat")).toBe(1);
    expect(countSyllablesFr("maison")).toBe(2);
    expect(countSyllablesFr("bateau")).toBe(2);
  });

  it("drops the silent final e", () => {
    expect(countSyllablesFr("porte")).toBe(1);
    expect(countSyllablesFr("table")).toBe(1);
  });

  it("never returns zero", () => {
    expect(countSyllablesFr("rythme")).toBeGreaterThanOrEqual(1);
    expect(countSyllablesFr("x")).toBe(1);
  });

  it("ignores accents when grouping", () => {
    expect(countSyllablesFr("écolé")).toBe(countSyllablesFr("ecole"));
  });
});

describe("Document statistics — keywords", () => {
  it("ranks by frequency and skips stop words", () => {
    const text = "Le bail commercial. Le bail est un bail de neuf ans. Le contrat de bail.";
    const top = keywords(text, 3);
    expect(top[0]).toEqual({ word: "bail", count: 4 });
    expect(top.map((k) => k.word)).not.toContain("le");
    expect(top.map((k) => k.word)).not.toContain("de");
  });

  it("skips very short tokens and bare numbers", () => {
    const top = keywords("ab ab ab 2027 2027 2027 loyer loyer loyer loyer");
    expect(top.map((k) => k.word)).toEqual(["loyer"]);
  });

  it("respects the limit", () => {
    expect(keywords("alpha beta gamma delta epsilon zeta", 3)).toHaveLength(3);
  });
});

describe("Document statistics — formatting", () => {
  it("formats durations", () => {
    expect(formatMinutes(0)).toBe("—");
    expect(formatMinutes(7)).toBe("7 min");
    expect(formatMinutes(60)).toBe("1 h");
    expect(formatMinutes(95)).toBe("1 h 35 min");
  });
});
