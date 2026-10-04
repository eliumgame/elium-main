import { describe, it, expect } from "vitest";
import { DOCUMENTATION_MD, DOC_SECTION_FILES } from "../src/docs/documentation";
import pkg from "../package.json";

// Les lignes `# commentaire` d'un bloc de code ne sont pas des titres.
let inFence = false;
const headings: { level: number; text: string }[] = [];
for (const l of DOCUMENTATION_MD.split("\n")) {
  if (/^\s*```/.test(l)) inFence = !inFence;
  else if (!inFence && /^#{1,3}\s+\S/.test(l)) {
    headings.push({ level: l.match(/^#+/)![0].length, text: l.replace(/^#+\s+/, "").trim() });
  }
}

describe("documentation in-app", () => {
  it("est assemblée depuis les fichiers de sections, dans l'ordre", () => {
    expect(DOC_SECTION_FILES.length).toBeGreaterThan(10);
    expect(DOC_SECTION_FILES[0]).toContain("00-introduction");
    expect(DOC_SECTION_FILES).toEqual([...DOC_SECTION_FILES].sort());
  });

  it("a un seul titre de niveau 1", () => {
    expect(headings.filter((h) => h.level === 1)).toHaveLength(1);
  });

  it("annonce la version courante de l'application", () => {
    const m = /\*\*Version (?:courante|documentée)\s*:\s*([0-9]+\.[0-9]+\.[0-9]+)/.exec(DOCUMENTATION_MD);
    expect(m, "la documentation doit annoncer « Version courante : X.Y.Z »").not.toBeNull();
    // Même majeur.mineur que l'application (le correctif peut avancer sans que la doc bouge).
    const [maj, min] = pkg.version.split(".");
    expect(m![1]!.startsWith(`${maj}.${min}.`)).toBe(true);
  });

  it("n'a aucun titre de niveau 2 ou 3 dupliqué (les ancres doivent être uniques)", () => {
    const seen = new Map<string, number>();
    for (const h of headings.filter((h) => h.level >= 2)) seen.set(h.text, (seen.get(h.text) ?? 0) + 1);
    const dup = [...seen].filter(([, n]) => n > 1).map(([t]) => t);
    expect(dup).toEqual([]);
  });

  it("ne contient aucun lien interne cassé", () => {
    const slug = (t: string) =>
      t
        .toLowerCase()
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/`/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
    const anchors = new Set(headings.map((h) => slug(h.text)));
    const broken = [...DOCUMENTATION_MD.matchAll(/\]\(#([^)]+)\)/g)]
      .map((m) => m[1]!)
      .filter((a) => !anchors.has(slug(decodeURIComponent(a))));
    expect(broken).toEqual([]);
  });

  it("ne mentionne plus de fichiers de documentation supprimés", () => {
    expect(DOCUMENTATION_MD).not.toMatch(/DOCUMENTATION\.md|SPEC\.md|THREAT_MODEL\.md/);
  });
});
