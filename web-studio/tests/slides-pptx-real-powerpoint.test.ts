// Fidélité PPTX : un package « tel que PowerPoint l'écrit » (placeholders sans
// xfrm qui héritent de la disposition/du masque, couleurs de thème, groupes
// avec chOff/chExt, retrait automatique, puces à niveaux, notes, sauts de
// ligne/champs, AlternateContent) — et non tel que notre exporteur le fait.
import { describe, it, expect } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { importPptx } from "../src/slides/pptx-import";

const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const NS = `xmlns:a="${A}" xmlns:r="${R}" xmlns:p="${P}"`;
const rels = (items: [string, string, string][]) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${REL}">${items
    .map(([id, type, target]) => `<Relationship Id="${id}" Type="${R}/${type}" Target="${target}"/>`)
    .join("")}</Relationships>`;
const grp = `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>`;

const theme = `<?xml version="1.0"?><a:theme xmlns:a="${A}" name="Office"><a:themeElements><a:clrScheme name="Office">
<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>
<a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>
<a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3>
<a:accent4><a:srgbClr val="FFC000"/></a:accent4><a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6>
<a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme>
<a:fontScheme name="Office"><a:majorFont><a:latin typeface="Calibri Light"/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/></a:minorFont></a:fontScheme></a:themeElements></a:theme>`;

const master = `<?xml version="1.0"?><p:sldMaster ${NS}><p:cSld><p:spTree>${grp}
<p:sp><p:nvSpPr><p:cNvPr id="2" name="Titre"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
<p:spPr><a:xfrm><a:off x="838200" y="365125"/><a:ext cx="10515600" cy="1325563"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
<p:txBody><a:bodyPr vert="horz" anchor="ctr"><a:normAutofit/></a:bodyPr><a:lstStyle/><a:p><a:r><a:rPr lang="fr-FR"/><a:t>Modifiez le style</a:t></a:r></a:p></p:txBody></p:sp>
<p:sp><p:nvSpPr><p:cNvPr id="3" name="Texte"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>
<p:spPr><a:xfrm><a:off x="838200" y="1825625"/><a:ext cx="10515600" cy="4351338"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:pPr lvl="0"/><a:r><a:t>Modifiez</a:t></a:r></a:p></p:txBody></p:sp>
</p:spTree></p:cSld>
<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
<p:txStyles>
<p:titleStyle><a:lvl1pPr algn="l"><a:defRPr sz="4400" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill></a:defRPr></a:lvl1pPr></p:titleStyle>
<p:bodyStyle>
<a:lvl1pPr marL="228600" indent="-228600" algn="l"><a:buFont typeface="Arial"/><a:buChar char="&#8226;"/><a:defRPr sz="2800"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill></a:defRPr></a:lvl1pPr>
<a:lvl2pPr marL="685800" indent="-228600" algn="l"><a:buFont typeface="Arial"/><a:buChar char="&#8226;"/><a:defRPr sz="2400"/></a:lvl2pPr>
</p:bodyStyle><p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>`;

const layoutTitle = `<?xml version="1.0"?><p:sldLayout ${NS} type="title"><p:cSld name="Diapositive de titre"><p:spTree>${grp}
<p:sp><p:nvSpPr><p:cNvPr id="2" name="Titre"/><p:cNvSpPr/><p:nvPr><p:ph type="ctrTitle"/></p:nvPr></p:nvSpPr>
<p:spPr><a:xfrm><a:off x="1524000" y="1122363"/><a:ext cx="9144000" cy="2387600"/></a:xfrm></p:spPr>
<p:txBody><a:bodyPr anchor="b"/><a:lstStyle><a:lvl1pPr algn="ctr"><a:defRPr sz="6000"/></a:lvl1pPr></a:lstStyle><a:p><a:endParaRPr lang="fr-FR"/></a:p></p:txBody></p:sp>
<p:sp><p:nvSpPr><p:cNvPr id="3" name="Sous-titre"/><p:cNvSpPr/><p:nvPr><p:ph type="subTitle" idx="1"/></p:nvPr></p:nvSpPr>
<p:spPr><a:xfrm><a:off x="1524000" y="3602038"/><a:ext cx="9144000" cy="1655762"/></a:xfrm></p:spPr>
<p:txBody><a:bodyPr/><a:lstStyle><a:lvl1pPr marL="0" indent="0" algn="ctr"><a:buNone/><a:defRPr sz="2400"/></a:lvl1pPr></a:lstStyle><a:p><a:endParaRPr lang="fr-FR"/></a:p></p:txBody></p:sp>
</p:spTree></p:cSld></p:sldLayout>`;

const layoutContent = `<?xml version="1.0"?><p:sldLayout ${NS} type="obj"><p:cSld name="Titre et contenu"><p:spTree>${grp}
<p:sp><p:nvSpPr><p:cNvPr id="2" name="Titre"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="fr-FR"/></a:p></p:txBody></p:sp>
<p:sp><p:nvSpPr><p:cNvPr id="3" name="Contenu"/><p:cNvSpPr/><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="fr-FR"/></a:p></p:txBody></p:sp>
</p:spTree></p:cSld></p:sldLayout>`;

const slide1 = `<?xml version="1.0"?><p:sld ${NS}><p:cSld><p:spTree>${grp}
<p:sp><p:nvSpPr><p:cNvPr id="2" name="Titre 1"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="ctrTitle"/></p:nvPr></p:nvSpPr><p:spPr/>
<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="fr-FR" dirty="0"/><a:t>Bilan annuel</a:t></a:r></a:p></p:txBody></p:sp>
<p:sp><p:nvSpPr><p:cNvPr id="3" name="Sous-titre 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="subTitle" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/>
<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="fr-FR"/><a:t>Direction financière</a:t></a:r></a:p></p:txBody></p:sp>
</p:spTree></p:cSld></p:sld>`;

const slide2 = `<?xml version="1.0"?><p:sld ${NS} xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" show="0"><p:cSld><p:spTree>${grp}
<p:sp><p:nvSpPr><p:cNvPr id="2" name="Titre 1"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/>
<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="fr-FR"/><a:t>Points clés</a:t></a:r></a:p></p:txBody></p:sp>
<p:sp><p:nvSpPr><p:cNvPr id="3" name="Espace réservé du contenu 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr><p:spPr/>
<p:txBody><a:bodyPr><a:normAutofit fontScale="92500" lnSpcReduction="10000"/></a:bodyPr><a:lstStyle/>
<a:p><a:r><a:rPr lang="fr-FR" b="1"/><a:t>Premier</a:t></a:r><a:br><a:rPr lang="fr-FR"/></a:br><a:r><a:rPr lang="fr-FR"/><a:t>suite</a:t></a:r></a:p>
<a:p><a:pPr lvl="1"/><a:r><a:rPr lang="fr-FR"/><a:t>Sous-point</a:t></a:r></a:p>
<a:p><a:pPr marL="0" indent="0"><a:buNone/></a:pPr><a:r><a:rPr lang="fr-FR"/><a:t>Sans puce</a:t></a:r></a:p>
<a:p><a:r><a:rPr lang="fr-FR"/><a:t>Page </a:t></a:r><a:fld id="{B6F15528-21DE-4FAA-801E-634DDDAF4B2B}" type="slidenum"><a:rPr lang="fr-FR"/><a:t>2</a:t></a:fld></a:p>
</p:txBody></p:sp>
<p:sp><p:nvSpPr><p:cNvPr id="4" name="Rectangle 3"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
<p:spPr><a:xfrm><a:off x="6096000" y="3429000"/><a:ext cx="3048000" cy="1714500"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
<a:solidFill><a:schemeClr val="accent1"><a:lumMod val="75000"/></a:schemeClr></a:solidFill><a:ln w="12700"><a:solidFill><a:schemeClr val="bg1"/></a:solidFill></a:ln></p:spPr>
<p:style><a:lnRef idx="2"><a:schemeClr val="accent1"><a:shade val="50000"/></a:schemeClr></a:lnRef><a:fillRef idx="1"><a:schemeClr val="accent1"/></a:fillRef><a:effectRef idx="0"><a:schemeClr val="accent1"/></a:effectRef><a:fontRef idx="minor"><a:schemeClr val="lt1"/></a:fontRef></p:style>
<p:txBody><a:bodyPr rtlCol="0" anchor="ctr"/><a:lstStyle/><a:p><a:pPr algn="ctr"/><a:r><a:rPr lang="fr-FR" sz="2000"><a:solidFill><a:schemeClr val="bg1"/></a:solidFill></a:rPr><a:t>Forme</a:t></a:r></a:p></p:txBody></p:sp>
<p:grpSp><p:nvGrpSpPr><p:cNvPr id="5" name="Groupe 4"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
<p:grpSpPr><a:xfrm><a:off x="1219200" y="4572000"/><a:ext cx="2438400" cy="1219200"/><a:chOff x="0" y="0"/><a:chExt cx="1219200" cy="609600"/></a:xfrm></p:grpSpPr>
<p:sp><p:nvSpPr><p:cNvPr id="6" name="Ovale"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="609600" y="0"/><a:ext cx="609600" cy="609600"/></a:xfrm><a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></p:spPr></p:sp>
</p:grpSp>
<mc:AlternateContent><mc:Choice Requires="p14"><p:sp><p:nvSpPr><p:cNvPr id="7" name="Choix"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1219200" cy="609600"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="00FF00"/></a:solidFill></p:spPr></p:sp></mc:Choice>
<mc:Fallback><p:sp><p:nvSpPr><p:cNvPr id="8" name="Repli"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1219200" cy="609600"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="0000FF"/></a:solidFill></p:spPr></p:sp></mc:Fallback></mc:AlternateContent>
</p:spTree></p:cSld></p:sld>`;

const notes2 = `<?xml version="1.0"?><p:notes ${NS}><p:cSld><p:spTree>${grp}
<p:sp><p:nvSpPr><p:cNvPr id="2" name="Image de diapositive 1"/><p:cNvSpPr/><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp>
<p:sp><p:nvSpPr><p:cNvPr id="3" name="Espace réservé des notes 2"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/>
<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="fr-FR"/><a:t>Penser à citer la source.</a:t></a:r></a:p><a:p><a:r><a:rPr lang="fr-FR"/><a:t>Deuxième ligne</a:t></a:r></a:p></p:txBody></p:sp>
<p:sp><p:nvSpPr><p:cNvPr id="4" name="Numéro"/><p:cNvSpPr/><p:nvPr><p:ph type="sldNum" sz="quarter" idx="5"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:fld id="{1}" type="slidenum"><a:t>2</a:t></a:fld></a:p></p:txBody></p:sp>
</p:spTree></p:cSld></p:notes>`;

function build(): Uint8Array {
  const f: Record<string, string> = {
    "[Content_Types].xml": `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`,
    "_rels/.rels": rels([["rId1", "officeDocument", "ppt/presentation.xml"]]),
    "ppt/presentation.xml": `<?xml version="1.0"?><p:presentation ${NS}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId3"/></p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/></p:presentation>`,
    "ppt/_rels/presentation.xml.rels": rels([
      ["rId1", "slideMaster", "slideMasters/slideMaster1.xml"],
      ["rId2", "slide", "slides/slide1.xml"],
      ["rId3", "slide", "slides/slide2.xml"],
      ["rId4", "theme", "theme/theme1.xml"],
    ]),
    "ppt/slideMasters/slideMaster1.xml": master,
    "ppt/slideMasters/_rels/slideMaster1.xml.rels": rels([
      ["rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"],
      ["rId2", "slideLayout", "../slideLayouts/slideLayout2.xml"],
      ["rId3", "theme", "../theme/theme1.xml"],
    ]),
    "ppt/slideLayouts/slideLayout1.xml": layoutTitle,
    "ppt/slideLayouts/_rels/slideLayout1.xml.rels": rels([["rId1", "slideMaster", "../slideMasters/slideMaster1.xml"]]),
    "ppt/slideLayouts/slideLayout2.xml": layoutContent,
    "ppt/slideLayouts/_rels/slideLayout2.xml.rels": rels([["rId1", "slideMaster", "../slideMasters/slideMaster1.xml"]]),
    "ppt/theme/theme1.xml": theme,
    "ppt/slides/slide1.xml": slide1,
    "ppt/slides/_rels/slide1.xml.rels": rels([["rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"]]),
    "ppt/slides/slide2.xml": slide2,
    "ppt/slides/_rels/slide2.xml.rels": rels([
      ["rId1", "slideLayout", "../slideLayouts/slideLayout2.xml"],
      ["rId2", "notesSlide", "../notesSlides/notesSlide1.xml"],
    ]),
    "ppt/notesSlides/notesSlide1.xml": notes2,
  };
  const out: Record<string, Uint8Array> = {};
  for (const [k, v] of Object.entries(f)) out[k] = strToU8(v);
  return zipSync(out, { level: 0 });
}

describe("PPTX réel — placeholders hérités de la disposition / du masque", () => {
  const deck = importPptx(build());
  const [s1, s2] = deck.slides;
  it("importe les deux diapositives", () => {
    expect(deck.slides).toHaveLength(2);
  });
  it("le titre centré hérite de la géométrie de la disposition (et non 0×0)", () => {
    const t = s1!.elements!.find((e) => e.type === "text")!;
    expect(t.w).toBeCloseTo(75, 0);
    expect(t.x).toBeCloseTo(12.5, 0);
    expect(t.h).toBeGreaterThan(30);
    expect(t.align).toBe("center");
    expect(t.valign).toBe("bottom");
    expect(t.fontSize).toBe(80); // 60 pt de la disposition → 80 px
  });
  it("le sous-titre n'a pas de puce et hérite de sa taille", () => {
    const sub = s1!.elements![1]!;
    expect(sub.html).not.toContain("<li>");
    expect(sub.html).toContain("Direction financière");
    expect(sub.fontSize).toBe(32);
  });
  it("le titre de la diapositive 2 hérite du masque, la diapo expose son titre", () => {
    const t = s2!.elements![0]!;
    expect(t.x).toBeCloseTo(6.9, 0);
    expect(t.w).toBeCloseTo(86.2, 0);
    expect(t.fontSize).toBe(59); // 44 pt
    expect(s2!.title).toBe("Points clés");
    expect(s1!.title).toBe("Bilan annuel");
  });
  it("le corps hérite de la géométrie, applique fontScale et rend puces/niveaux/sauts de ligne/champs", () => {
    const b = s2!.elements![1]!;
    expect(b.w).toBeCloseTo(86.2, 0);
    expect(b.y).toBeCloseTo(26.6, 0);
    expect(b.fontSize).toBe(Math.round(37.33 * 0.925)); // 28 pt × 92,5 %
    expect(b.html).toContain("<ul>");
    // le niveau 2 (24 pt) est plus petit que la base (28 pt) : taille relative en em
    expect(b.html).toMatch(
      /<li><b>Premier<\/b><br>suite<ul><li><span style="font-size:0\.857em">Sous-point<\/span><\/li><\/ul><\/li>/,
    );
    expect(b.html).toContain("<p>Sans puce</p>");
    expect(b.html).toContain("Page 2");
  });
});

describe("PPTX réel — couleurs de thème, groupes, AlternateContent, notes, masquage", () => {
  const deck = importPptx(build());
  const s2 = deck.slides[1]!;
  it("résout schemeClr + lumMod (accent1 à 75 %)", () => {
    const rect = s2.elements!.find((e) => e.type === "shape" && e.text === "Forme")!;
    expect(rect.fill).toBe("#2f5597");
    expect(rect.x).toBeCloseTo(50, 0);
  });
  it("applique la transformation du groupe (chOff/chExt) aux enfants", () => {
    const oval = s2.elements!.find((e) => e.shape === "ellipse")!;
    // enfant à x=609600 dans un repère 1219200 large → moitié du groupe (x 10% + 10%) ; ext ×2
    expect(oval.x).toBeCloseTo(((1219200 + 609600 * 2) / 12192000) * 100, 1);
    expect(oval.w).toBeCloseTo(((609600 * 2) / 12192000) * 100, 1);
    expect(oval.fill).toBe("#ff0000");
  });
  it("ne garde que mc:Choice (pas le repli en double)", () => {
    expect(s2.elements!.some((e) => e.fill === "#00ff00")).toBe(true);
    expect(s2.elements!.some((e) => e.fill === "#0000ff")).toBe(false);
  });
  it("importe les notes du présentateur (sans l'image ni le numéro)", () => {
    expect(s2.notes).toBe("Penser à citer la source.\nDeuxième ligne");
  });
  it('importe l\'état masqué (show="0")', () => {
    expect(s2.hidden).toBe(true);
    expect(deck.slides[0]!.hidden).toBeFalsy();
  });
});
