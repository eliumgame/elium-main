import { describe, expect, it } from "vitest";
// @ts-expect-error module .mjs sans déclaration de types
import { buildReleaseInfo, latestNotes } from "../scripts/gen-release-info.mjs";
import { compareVersions, formatSize, pickInstallers, type PublishedRelease } from "../src/desktop/web-release";

const JOURNAL = `## Journal des versions

### Version 4.13.0 — sauvegarde de l'espace de travail dans le Drive

- Premier **point** avec \`code\`.
- Deuxième point.

### Version 4.12.0 — Passeport professionnel E4

- Ancien point.
`;

describe("notes de mise à jour du build", () => {
  it("prend la section la plus récente, sans mise en forme Markdown", () => {
    const r = latestNotes(JOURNAL);
    expect(r.heading).toBe("Version 4.13.0 — sauvegarde de l'espace de travail dans le Drive");
    expect(r.notes).toEqual(["Premier point avec code.", "Deuxième point."]);
  });
  it("journal vide : pas de plantage", () => {
    expect(latestNotes("").notes).toEqual([]);
    const info = buildReleaseInfo({ version: "1.0.0", builtAt: "x", buildId: "", journal: "" });
    expect(info.version).toBe("1.0.0");
    expect(info.notes).toEqual([]);
  });
});

describe("installeurs Windows de la dernière publication", () => {
  const rel: PublishedRelease = {
    tag: "v4.12.0",
    publishedAt: "2026-10-18T00:00:00Z",
    url: "https://github.com/x",
    assets: [
      { name: "Elium-User-4.12.0.msi", url: "https://u", size: 42_000_000 },
      { name: "Elium-4.12.0-Setup.msi", url: "https://m", size: 43_000_000 },
      { name: "Elium.exe", url: "https://e", size: 41_000_000 },
      { name: "web.zip", url: "https://w", size: 1 },
    ],
  };
  it("classe machine, utilisateur, portable — et ignore le reste", () => {
    const l = pickInstallers(rel);
    expect(l.map((i) => i.kind)).toEqual(["machine", "user", "portable"]);
    expect(l[0].url).toBe("https://m");
    expect(pickInstallers(undefined)).toEqual([]);
  });
  it("compare les versions et formate les tailles", () => {
    expect(compareVersions("4.13.0", "v4.12.0")).toBeGreaterThan(0);
    expect(compareVersions("4.12.0", "4.12.0")).toBe(0);
    expect(compareVersions("4.9.9", "4.10.0")).toBeLessThan(0);
    expect(formatSize(43_000_000)).toBe("41 Mo");
    expect(formatSize(2048)).toBe("2 Ko");
  });
});
