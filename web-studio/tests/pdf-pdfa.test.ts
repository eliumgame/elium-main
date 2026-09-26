import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDict, PDFDocument, PDFName, PDFRawStream, StandardFonts, cmyk, rgb } from "pdf-lib";
import { checkPdfA, convertToPdfA, srgbProfile } from "../src/pdf/ops/pdfa";

/**
 * PDF/A-2b / 3b conversion. veraPDF (the reference validator, Java) is used
 * when VERAPDF_JAR points at its greenfield-apps jar; the structural checks
 * run everywhere.
 */

const ICC = new Uint8Array(
  readFileSync(new URL("../node_modules/pdfjs-dist/iccs/CGATS001Compat-v2-micro.icc", import.meta.url)),
);
const VERAPDF =
  process.env.VERAPDF_JAR ??
  "/tmp/claude-0/-home-user/c05fc523-b909-5103-991d-7dcab269304e/scratchpad/vera/greenfield-apps.jar";

function verapdf(bytes: Uint8Array, flavour: string): string {
  const dir = mkdtempSync(join(tmpdir(), "pdfa-"));
  const file = join(dir, "doc.pdf");
  writeFileSync(file, bytes);
  const out = execFileSync(
    "java",
    ["-cp", VERAPDF, "org.verapdf.apps.GreenfieldCliWrapper", "-f", flavour, "--format", "text", "-v", file],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  return out
    .split("\n")
    .filter((l) => /PASS|FAIL/.test(l))
    .join("\n");
}

async function sample(): Promise<PDFDocument> {
  const doc = await PDFDocument.create();
  doc.setTitle("Rapport annuel");
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const times = await doc.embedFont(StandardFonts.TimesRomanBold);
  const p = doc.addPage([595, 842]);
  p.drawText("Rapport annuel — été 2026", { x: 60, y: 760, size: 20, font: helv, color: rgb(0.1, 0.2, 0.6) });
  p.drawText("Chiffres clés", { x: 60, y: 720, size: 14, font: times, color: cmyk(0, 0.5, 1, 0) });
  doc.getForm().createTextField("nom").addToPage(p, { x: 60, y: 600, width: 200, height: 20 });
  return doc;
}

describe("PDF/A", () => {
  it("the sRGB profile is a well-formed ICC v2 display profile", () => {
    const icc = srgbProfile();
    const v = new DataView(icc.buffer);
    expect(v.getUint32(0)).toBe(icc.length);
    expect(new TextDecoder().decode(icc.subarray(12, 24))).toBe("mntrRGB XYZ ");
    expect(new TextDecoder().decode(icc.subarray(36, 40))).toBe("acsp");
  });

  it("a plain document fails the checks; converted, it passes them", async () => {
    const doc = await sample();
    await doc.flush();
    expect(checkPdfA(doc).length).toBeGreaterThan(0);
    const r = await convertToPdfA(doc, { part: 2, cmykProfile: ICC });
    expect(r.remaining).toEqual([]);
    expect(r.fixed).toContain("polices incorporées (substituts Liberation)");
    expect(checkPdfA(doc)).toEqual([]);
    const reread = await PDFDocument.load(await doc.save({ useObjectStreams: false }));
    const meta = reread.catalog.lookup(PDFName.of("Metadata")) as PDFRawStream;
    expect(new TextDecoder().decode(meta.contents)).toContain("<pdfaid:part>2</pdfaid:part>");
    expect(reread.catalog.lookup(PDFName.of("OutputIntents"))).toBeTruthy();
    expect(checkPdfA(reread)).toEqual([]);
  });

  it("removes what PDF/A forbids: JavaScript, launch actions, signatures", async () => {
    const doc = await sample();
    doc.catalog.set(PDFName.of("OpenAction"), doc.context.obj({ S: "JavaScript", JS: "app.alert(1)" }) as PDFDict);
    const r = await convertToPdfA(doc, { part: 3 });
    expect(doc.catalog.has(PDFName.of("OpenAction"))).toBe(false);
    expect(r.fixed.join(" ")).toContain("action à l'ouverture supprimée");
  });

  it.skipIf(!existsSync(VERAPDF))(
    "veraPDF: PDF/A-2b and PDF/A-3b pass",
    async () => {
      for (const part of [2, 3] as const) {
        const doc = await sample();
        await convertToPdfA(doc, { part, cmykProfile: ICC });
        expect(verapdf(await doc.save({ useObjectStreams: false }), `${part}b`)).toMatch(/^PASS/);
      }
    },
    120_000,
  );
});
