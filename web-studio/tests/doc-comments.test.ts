// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Comment, type CommentAttrs, type CommentReply } from "../src/editor/customExtensions";
import { unzipSync, strFromU8 } from "fflate";
import { docToDocx, docxToDoc } from "../src/format/docx";
import { createEliumFile } from "../src/format/document";
import type { ProseMirrorNode } from "../src/format/types";

function makeEditor(content = "<p>Le contrat prend effet lundi.</p>") {
  return new Editor({
    extensions: [StarterKit.configure({ codeBlock: false }), Comment],
    content,
  });
}

function baseAttrs(over: Partial<CommentAttrs> = {}): CommentAttrs {
  return {
    id: "c1",
    author: "Alice",
    text: "à vérifier",
    resolved: false,
    createdAt: "2026-01-01T00:00:00Z",
    replies: [],
    ...over,
  };
}

/** Every comment mark instance carrying `id`, doc-order — a thread split
 *  across formatting runs (bold mid-comment, etc.) can legitimately carry more
 *  than one, and each must agree once a command has run. */
function commentMarks(editor: Editor, id: string): CommentAttrs[] {
  const out: CommentAttrs[] = [];
  editor.state.doc.descendants((node) => {
    if (!node.isText) return;
    for (const m of node.marks) {
      if (m.type.name === "comment" && m.attrs.id === id) out.push(m.attrs as CommentAttrs);
    }
  });
  return out;
}

let editor: Editor | null = null;
afterEach(() => {
  editor?.destroy();
  editor = null;
});

describe("Comment — pose, résolution, suppression", () => {
  it("setComment ancre un commentaire sur la plage sélectionnée", () => {
    editor = makeEditor();
    editor.commands.setTextSelection({ from: 1, to: 8 }); // "Le contrat"[1..8] ~ "Le conт"
    editor.commands.setComment(baseAttrs());
    expect(editor.getHTML()).toContain('data-comment-id="c1"');
    expect(commentMarks(editor, "c1")).toHaveLength(1);
  });

  it("resolveComment bascule resolved SANS dupliquer la marque", () => {
    editor = makeEditor();
    editor.commands.setTextSelection({ from: 1, to: 8 });
    editor.commands.setComment(baseAttrs());
    editor.commands.resolveComment("c1", true);
    const marks = commentMarks(editor, "c1");
    expect(marks).toHaveLength(1); // pas deux marques "comment" empilées sur le même texte
    expect(marks[0]!.resolved).toBe(true);
    expect(editor.getHTML()).toContain("elium-comment--resolved");
  });

  it("removeComment retire la marque", () => {
    editor = makeEditor();
    editor.commands.setTextSelection({ from: 1, to: 8 });
    editor.commands.setComment(baseAttrs());
    editor.commands.removeComment("c1");
    expect(commentMarks(editor, "c1")).toHaveLength(0);
    expect(editor.getHTML()).not.toContain("data-comment-id");
  });

  it("removeComment(id) ne touche pas un AUTRE fil qui chevauche la même plage", () => {
    // Le mark Comment déclare excludes:"" pour permettre ce chevauchement —
    // c'est exactement le cas que le removeMark(type) d'origine cassait.
    editor = makeEditor();
    editor.commands.setTextSelection({ from: 1, to: 12 });
    editor.commands.setComment(baseAttrs({ id: "c1", text: "premier fil" }));
    editor.commands.setTextSelection({ from: 4, to: 15 });
    editor.commands.setComment(baseAttrs({ id: "c2", text: "second fil" }));
    editor.commands.removeComment("c1");
    expect(commentMarks(editor, "c1")).toHaveLength(0);
    expect(commentMarks(editor, "c2").length).toBeGreaterThan(0); // c2 doit survivre
  });
});

describe("Comment — fil de réponses", () => {
  const reply = (over: Partial<CommentReply> = {}): CommentReply => ({
    id: "r1",
    author: "Bob",
    text: "réponse",
    createdAt: "2026-01-02T00:00:00Z",
    ...over,
  });

  it("addCommentReply ajoute une réponse sans dupliquer la marque", () => {
    editor = makeEditor();
    editor.commands.setTextSelection({ from: 1, to: 8 });
    editor.commands.setComment(baseAttrs());
    editor.commands.addCommentReply("c1", reply());
    const marks = commentMarks(editor, "c1");
    expect(marks).toHaveLength(1);
    expect(marks[0]!.replies).toEqual([reply()]);
  });

  it("plusieurs réponses s'accumulent dans l'ordre", () => {
    editor = makeEditor();
    editor.commands.setTextSelection({ from: 1, to: 8 });
    editor.commands.setComment(baseAttrs());
    editor.commands.addCommentReply("c1", reply({ id: "r1", text: "premier" }));
    editor.commands.addCommentReply("c1", reply({ id: "r2", text: "second" }));
    const marks = commentMarks(editor, "c1");
    expect(marks[0]!.replies.map((r) => r.text)).toEqual(["premier", "second"]);
  });

  it("removeCommentReply retire une réponse précise, garde les autres", () => {
    editor = makeEditor();
    editor.commands.setTextSelection({ from: 1, to: 8 });
    editor.commands.setComment(baseAttrs());
    editor.commands.addCommentReply("c1", reply({ id: "r1", text: "premier" }));
    editor.commands.addCommentReply("c1", reply({ id: "r2", text: "second" }));
    editor.commands.removeCommentReply("c1", "r1");
    const marks = commentMarks(editor, "c1");
    expect(marks[0]!.replies.map((r) => r.id)).toEqual(["r2"]);
  });

  it("addCommentReply sur un id inconnu est un no-op", () => {
    editor = makeEditor();
    editor.commands.setTextSelection({ from: 1, to: 8 });
    editor.commands.setComment(baseAttrs());
    const before = editor.getJSON();
    editor.commands.addCommentReply("inconnu", reply());
    expect(editor.getJSON()).toEqual(before);
  });
});

describe("Comment — export/import DOCX (word/comments.xml)", () => {
  const t = (text: string, marks?: Record<string, unknown>[]): ProseMirrorNode => ({
    type: "text",
    text,
    ...(marks ? { marks } : {}),
  });
  const para = (...content: ProseMirrorNode[]): ProseMirrorNode => ({ type: "paragraph", content });
  const doc = (...content: ProseMirrorNode[]): ProseMirrorNode => ({ type: "doc", content });
  const partOf = (bytes: Uint8Array, name: string): string => strFromU8(unzipSync(bytes)[name]!);
  const flat = (node: ProseMirrorNode): string => node.text ?? (node.content ?? []).map(flat).join("");

  it("écrit une vraie word/comments.xml avec commentRangeStart/End + commentReference", async () => {
    const node = doc(
      para(
        t("Le "),
        t("contrat", [{ type: "comment", attrs: baseAttrs({ text: "à vérifier — délai ?" }) }]),
        t(" est signé."),
      ),
    );
    const file = await createEliumFile({ title: "Doc", profile: "standard", doc: node });
    const bytes = docToDocx(file);
    const unzipped = unzipSync(bytes);
    expect(unzipped["word/comments.xml"]).toBeDefined();

    const commentsXml = partOf(bytes, "word/comments.xml");
    expect(commentsXml).toContain('w:author="Alice"');
    expect(commentsXml).toContain("à vérifier — délai ?");

    const docXml = partOf(bytes, "word/document.xml");
    expect(docXml).toContain("<w:commentRangeStart");
    expect(docXml).toContain("<w:commentRangeEnd");
    expect(docXml).toContain("<w:commentReference");

    // Le relationship + content-type déclarés doivent pointer vers une partie
    // qui existe réellement dans le paquet (sans quoi Word rejette le .docx).
    const rels = partOf(bytes, "word/_rels/document.xml.rels");
    expect(rels).toContain("comments.xml");
    const types = partOf(bytes, "[Content_Types].xml");
    expect(types).toContain("wordprocessingml.comments+xml");
  });

  it("round-trip : la racine du commentaire (auteur/date/texte) survit à l'aller-retour", async () => {
    const node = doc(para(t("avant "), t("contrat", [{ type: "comment", attrs: baseAttrs() }]), t(" après")));
    const file = await createEliumFile({ title: "Doc", profile: "standard", doc: node });
    const back = docxToDoc(docToDocx(file));
    const withMark = (function walk(n: ProseMirrorNode): ProseMirrorNode | undefined {
      if (n.marks?.some((m) => m.type === "comment")) return n;
      for (const c of n.content ?? []) {
        const hit = walk(c);
        if (hit) return hit;
      }
      return undefined;
    })(back.doc);
    expect(withMark).toBeDefined();
    const mark = withMark!.marks!.find((m) => m.type === "comment")!;
    expect(mark.attrs?.author).toBe("Alice");
    expect(mark.attrs?.text).toBe("à vérifier");
    expect(flat(back.doc)).toContain("contrat");
  });

  it("réponses et resolved n'ont pas d'équivalent OOXML : ils sont ignorés à l'export, pas de crash", async () => {
    const node = doc(
      para(
        t("contrat", [
          {
            type: "comment",
            attrs: baseAttrs({
              resolved: true,
              replies: [{ id: "r1", author: "Bob", text: "réponse", createdAt: "2026-01-02T00:00:00Z" }],
            }),
          },
        ]),
      ),
    );
    const file = await createEliumFile({ title: "Doc", profile: "standard", doc: node });
    const bytes = docToDocx(file);
    const commentsXml = partOf(bytes, "word/comments.xml");
    expect(commentsXml).not.toContain("réponse");
    const back = docxToDoc(bytes);
    const withMark = (function walk(n: ProseMirrorNode): ProseMirrorNode | undefined {
      if (n.marks?.some((m) => m.type === "comment")) return n;
      for (const c of n.content ?? []) {
        const hit = walk(c);
        if (hit) return hit;
      }
      return undefined;
    })(back.doc);
    const m = withMark!.marks!.find((mm) => mm.type === "comment")!;
    expect(m.attrs?.resolved).toBe(false); // relu comme un commentaire frais, pas résolu
    expect(m.attrs?.replies).toEqual([]);
  });

  it("un document sans commentaire n'écrit pas word/comments.xml", async () => {
    const node = doc(para(t("rien de spécial ici")));
    const file = await createEliumFile({ title: "Doc", profile: "standard", doc: node });
    const bytes = docToDocx(file);
    expect(unzipSync(bytes)["word/comments.xml"]).toBeUndefined();
  });
});
