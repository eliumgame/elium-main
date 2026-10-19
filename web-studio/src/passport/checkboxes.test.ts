import { strToU8, zipSync, unzipSync, strFromU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { withReadableCheckboxes } from "./ficheImport";

const docx = (body: string) =>
  new File(
    [
      zipSync({
        "word/document.xml": strToU8(`<w:document xmlns:w="w" xmlns:w14="w14"><w:body>${body}</w:body></w:document>`),
      }) as BlobPart,
    ],
    "f.docx",
  );
const xml = async (f: File) => strFromU8(unzipSync(new Uint8Array(await f.arrayBuffer()))["word/document.xml"]);

describe("cases Word lisibles à l'import", () => {
  it("contrôles w14, champs hérités et symboles Wingdings", async () => {
    const out = await xml(
      await withReadableCheckboxes(
        docx(
          `<w:p><w:sdt><w:sdtPr><w14:checkbox><w14:checked w14:val="1"/></w14:checkbox></w:sdtPr><w:sdtContent><w:r><w:t>x</w:t></w:r></w:sdtContent></w:sdt>` +
            `<w:sdt><w:sdtPr><w14:checkbox><w14:checked w14:val="0"/></w14:checkbox></w:sdtPr><w:sdtContent><w:r><w:t>y</w:t></w:r></w:sdtContent></w:sdt>` +
            `<w:r><w:fldChar w:fldCharType="begin"><w:ffData><w:checkBox><w:default w:val="0"/><w:checked/></w:checkBox></w:ffData></w:fldChar></w:r>` +
            `<w:r><w:sym w:font="Wingdings" w:char="F0FE"/></w:r><w:r><w:sym w:font="Wingdings" w:char="F0A8"/></w:r></w:p>`,
        ),
      ),
    );
    expect(out.match(/[☒☐]/g)?.join("")).toBe("☒☐☒☒☐");
  });
});
