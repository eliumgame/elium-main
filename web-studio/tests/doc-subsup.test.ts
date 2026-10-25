// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import Document from "@tiptap/extension-document";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import { TextStyle } from "@tiptap/extension-text-style";
import { CharFormat, Subscript, Superscript } from "../src/editor/charFormat";

function make() {
  return new Editor({
    extensions: [Document, Paragraph, Text, TextStyle, CharFormat, Subscript, Superscript],
    content: "<p>H2O</p>",
  });
}

describe("indice / exposant", () => {
  it("l'exposant remplace l'indice sur le même texte (et inversement), au lieu de ne rien faire", () => {
    const ed = make();
    ed.commands.setTextSelection({ from: 2, to: 3 });
    ed.commands.toggleSubscript();
    expect(ed.getHTML()).toContain("<sub>2</sub>");
    ed.commands.toggleSuperscript();
    expect(ed.getHTML()).toContain("<sup>2</sup>");
    expect(ed.getHTML()).not.toContain("<sub>");
    ed.commands.toggleSubscript();
    expect(ed.getHTML()).toContain("<sub>2</sub>");
    expect(ed.getHTML()).not.toContain("<sup>");
    ed.commands.toggleSubscript();
    expect(ed.getHTML()).toBe("<p>H2O</p>");
    ed.destroy();
  });
});
