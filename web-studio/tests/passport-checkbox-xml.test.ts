import { describe, expect, it } from "vitest";
import { convertCheckboxXml } from "../src/passport/checkboxXml";

/** Ancienne implémentation à expressions régulières (référence de résultat sur des documents bien formés). */
function legacy(probe: string): string {
  const run = (c: boolean) => `<w:r><w:t>${c ? "☒" : "☐"}</w:t></w:r>`;
  const on = (v: string | undefined) => v === undefined || /^(1|true|on)$/i.test(v);
  let x = probe;
  if (x.includes("<w14:checkbox"))
    x = x.replace(/<w:sdt>(?:(?!<w:sdt>)[\s\S])*?<\/w:sdt>/g, (m) => {
      if (!m.includes("<w14:checkbox")) return m;
      const v = /<w14:checked(?=[\s/>])[^>]*w14:val="([^"]*)"/.exec(m)?.[1];
      return run(v !== undefined && on(v));
    });
  if (x.includes("<w:checkBox>"))
    x = x.replace(
      /<w:r(?:\s[^>]*)?>(?:(?!<\/w:r>)[\s\S])*?<w:ffData>(?:(?!<\/w:ffData>)[\s\S])*?<w:checkBox>[\s\S]*?<\/w:ffData>[\s\S]*?<\/w:r>/g,
      (m) => {
        const cb = /<w:checkBox>([\s\S]*?)<\/w:checkBox>/.exec(m)?.[1] ?? "";
        const chk = /<w:checked(?=[\s/>])(?:[^>]*w:val="([^"]*)")?[^>]*\/>/.exec(cb);
        const def = /<w:default(?=[\s/>])[^>]*w:val="([^"]*)"/.exec(cb)?.[1];
        return run(chk ? on(chk[1]) : def !== undefined && on(def));
      },
    );
  if (x.includes("<w:sym"))
    x = x.replace(/<w:sym(?=\s)[^>]*w:char="([0-9A-Fa-f]{4})"[^>]*\/>/g, (_m, ch: string) => {
      const c = ch.toUpperCase();
      if (["F0FE", "F0FD", "F0FC", "F078", "F0FB"].includes(c)) return "<w:t>☒</w:t>";
      if (["F0A8", "F06F", "F0A3", "F071"].includes(c)) return "<w:t>☐</w:t>";
      return _m;
    });
  return x;
}

const sdt = (val: string) =>
  `<w:sdt><w:sdtPr><w14:checkbox><w14:checked w14:val="${val}"/></w14:checkbox></w:sdtPr><w:sdtContent><w:r><w:t>x</w:t></w:r></w:sdtContent></w:sdt>`;
const form = (inner: string, attrs = "") =>
  `<w:r${attrs}><w:rPr><w:b/></w:rPr><w:fldChar w:fldCharType="begin"><w:ffData><w:name w:val="C1"/><w:checkBox>${inner}</w:checkBox></w:ffData></w:fldChar></w:r>`;

const CASES: Record<string, string> = {
  sdt: `<w:p>${sdt("1")}${sdt("0")}${sdt("true")}<w:sdt><w:sdtContent>texte</w:sdtContent></w:sdt></w:p>`,
  sdtImbrique: `<w:sdt><w:sdtContent>${sdt("1")}</w:sdtContent></w:sdt>`,
  formulaire: `<w:p>${form(`<w:default w:val="0"/><w:checked/>`)}${form(`<w:default w:val="1"/>`)}${form(
    `<w:checked w:val="0"/>`,
    ` w:rsidR="00A1"`,
  )}${form(`<w:sizeAuto/>`)}</w:p>`,
  runsSansCase: `<w:r><w:t>a</w:t></w:r><w:r><w:fldChar><w:ffData><w:name/></w:ffData></w:fldChar></w:r>${form(
    `<w:checked/>`,
  )}<w:r><w:t>b</w:t></w:r>`,
  symboles: `<w:r><w:sym w:font="Wingdings" w:char="F0FE"/></w:r><w:r><w:sym w:font="Wingdings" w:char="f0a8"/></w:r><w:r><w:sym w:font="Symbol" w:char="F020"/></w:r><w:r><w:symbol/></w:r>`,
  tout: `<w:body>${sdt("1")}${form(`<w:checked/>`)}<w:r><w:sym w:font="Wingdings" w:char="F078"/></w:r></w:body>`,
  rien: `<w:body><w:p><w:r><w:t>Bonjour</w:t></w:r></w:p></w:body>`,
};

describe("cases Word : conversion linéaire de document.xml", () => {
  for (const [name, xml] of Object.entries(CASES))
    it(`même résultat que l'ancienne expression régulière — ${name}`, () => {
      expect(convertCheckboxXml(xml)).toBe(legacy(xml));
    });

  it("le cas « tout » donne bien ☒ ☒ ☒", () => {
    expect(convertCheckboxXml(CASES.tout).match(/[☒☐]/g)?.join("")).toBe("☒☒☒");
  });

  it("entrée piégée (balises fermantes absentes) traitée en temps linéaire", () => {
    const n = 20000;
    const traps = [
      "<w:r><w:ffData><w:checkBox>".repeat(n),
      "<w:r>" + "<w:ffData><w:checkBox></w:ffData>".repeat(n),
      "<w:sdt><w14:checkbox><w14:checked ".repeat(n),
      '<w:sym w:char="F0FE" '.repeat(n),
      "<w:r><w:ffData><w:checkBox></w:ffData>".repeat(n) + "</w:r>",
    ];
    const t0 = Date.now();
    for (const t of traps) convertCheckboxXml(t + "<w:checkBox><w14:checkbox<w:sym ");
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});
