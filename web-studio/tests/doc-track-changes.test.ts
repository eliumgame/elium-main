// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Insertion, Deletion, TrackChanges, isSuggesting } from "../src/editor/TrackChanges";

/**
 * A minimal but real TipTap editor — StarterKit (Document/Paragraph/Text/
 * Heading/lists/history) plus the three pieces under test. Deliberately
 * leaves out the rest of Elium's extension set (Placeholder, Table, Image…):
 * those pull in browser APIs jsdom doesn't implement (`elementFromPoint`) and
 * have nothing to do with track changes.
 */
function makeEditor(author = "Alice", content = "<p>Bonjour le monde</p>") {
  return new Editor({
    extensions: [StarterKit.configure({ codeBlock: false }), Insertion, Deletion, TrackChanges.configure({ author })],
    content,
  });
}

/** Suggestion mode is opt-in — every test that exercises tracking turns it on. */
function makeSuggestingEditor(author = "Alice", content = "<p>Bonjour le monde</p>") {
  const editor = makeEditor(author, content);
  editor.commands.toggleSuggesting();
  return editor;
}

/** Invokes the SAME plugin prop ProseMirror's own DOM input reader calls —
 *  see TrackChanges.ts's `handleTextInput` — without needing a real browser
 *  `beforeinput`/composition pipeline, which jsdom does not implement for
 *  contenteditable. */
function typeText(editor: Editor, from: number, to: number, text: string): boolean {
  return !!editor.view.someProp("handleTextInput", (f) => f(editor.view, from, to, text));
}

/** Real keydown, dispatched on the view's own DOM node — exercises the exact
 *  same keymap plugin a real Backspace/Delete/Enter press would. */
function pressKey(editor: Editor, key: string): boolean {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  editor.view.dom.dispatchEvent(event);
  return event.defaultPrevented;
}

function marksOf(editor: Editor, markName: "insertion" | "deletion"): { id: string; text: string }[] {
  const out: { id: string; text: string }[] = [];
  editor.state.doc.descendants((node) => {
    if (!node.isText) return;
    const m = node.marks.find((mm) => mm.type.name === markName);
    if (m) out.push({ id: String(m.attrs.id), text: node.text ?? "" });
  });
  return out;
}

function breaksOf(editor: Editor): { pos: number; kind: string }[] {
  const out: { pos: number; kind: string }[] = [];
  editor.state.doc.descendants((node, pos) => {
    const tb = (node.attrs as { trackBreak?: { kind: string } | null }).trackBreak;
    if (tb) out.push({ pos, kind: tb.kind });
  });
  return out;
}

let editor: Editor | null = null;
afterEach(() => {
  editor?.destroy();
  editor = null;
});

describe("TrackChanges — mode suggestion opt-in", () => {
  it("est désactivé par défaut : aucune marque n'apparaît, la frappe insère normalement", () => {
    editor = makeEditor();
    expect(isSuggesting(editor.state)).toBe(false);
    expect(typeText(editor, 1, 1, "X")).toBe(false); // handler declines: plain contenteditable typing takes over
  });

  it("se bascule via toggleSuggesting", () => {
    editor = makeEditor();
    editor.commands.toggleSuggesting();
    expect(isSuggesting(editor.state)).toBe(true);
    editor.commands.toggleSuggesting();
    expect(isSuggesting(editor.state)).toBe(false);
  });
});

describe("TrackChanges — frappe et suppression suivies", () => {
  it("la frappe insère du texte porteur de la marque insertion, avec auteur", () => {
    editor = makeSuggestingEditor("Alice");
    editor.commands.setTextSelection(1);
    expect(typeText(editor, 1, 1, "Salut, ")).toBe(true);
    const [mark] = marksOf(editor, "insertion");
    expect(mark).toBeDefined();
    expect(editor.getText()).toBe("Salut, Bonjour le monde");
    editor.state.doc.descendants((node) => {
      if (node.isText && node.marks.some((m) => m.type.name === "insertion")) {
        expect(node.marks[0]!.attrs.author).toBe("Alice");
      }
    });
  });

  it("des frappes consécutives au même endroit partagent UN id (un seul changement logique)", () => {
    editor = makeSuggestingEditor();
    editor.commands.setTextSelection(1);
    typeText(editor, 1, 1, "A");
    typeText(editor, 2, 2, "B");
    typeText(editor, 3, 3, "C");
    const insIds = new Set(marksOf(editor, "insertion").map((m) => m.id));
    expect(insIds.size).toBe(1);
  });

  it("deux frappes à des endroits séparés obtiennent des ids distincts", () => {
    editor = makeSuggestingEditor();
    editor.commands.setTextSelection(1);
    typeText(editor, 1, 1, "X");
    const end = editor.state.doc.content.size - 1;
    editor.commands.setTextSelection(end);
    typeText(editor, end, end, "Y");
    const insIds = new Set(marksOf(editor, "insertion").map((m) => m.id));
    expect(insIds.size).toBe(2);
  });

  it("Backspace marque le caractère précédent au lieu de le supprimer", () => {
    editor = makeSuggestingEditor();
    editor.commands.setTextSelection(9); // juste après "Bonjour "
    expect(pressKey(editor, "Backspace")).toBe(true);
    expect(editor.getText()).toBe("Bonjour le monde"); // le texte reste, juste marqué
    const del = marksOf(editor, "deletion");
    expect(del).toHaveLength(1);
    expect(del[0]!.text).toBe(" ");
  });

  it("Delete marque le caractère suivant au lieu de le supprimer", () => {
    editor = makeSuggestingEditor();
    editor.commands.setTextSelection(1); // avant "Bonjour"
    expect(pressKey(editor, "Delete")).toBe(true);
    expect(editor.getText()).toBe("Bonjour le monde");
    expect(marksOf(editor, "deletion")[0]!.text).toBe("B");
  });

  it("Backspace répété étend UNE seule marque de suppression contiguë", () => {
    editor = makeSuggestingEditor();
    editor.commands.setTextSelection(9);
    pressKey(editor, "Backspace");
    pressKey(editor, "Backspace");
    pressKey(editor, "Backspace");
    const del = marksOf(editor, "deletion");
    const ids = new Set(del.map((m) => m.id));
    expect(ids.size).toBe(1);
    expect(del.map((m) => m.text).join("")).toBe("ur "); // depuis la position 9 : espace, puis "r", puis "u"
  });

  it("Backspace sur sa propre insertion en attente la retire (pas de double marque)", () => {
    editor = makeSuggestingEditor();
    editor.commands.setTextSelection(1);
    typeText(editor, 1, 1, "Z");
    editor.commands.setTextSelection(2); // juste après le Z inséré
    pressKey(editor, "Backspace");
    expect(editor.getText()).toBe("Bonjour le monde");
    expect(marksOf(editor, "insertion")).toHaveLength(0);
    expect(marksOf(editor, "deletion")).toHaveLength(0);
  });

  it("taper sur une sélection marque le texte remplacé en suppression et insère la frappe", () => {
    editor = makeSuggestingEditor();
    expect(typeText(editor, 1, 8, "Salut")).toBe(true); // remplace "Bonjour"
    expect(marksOf(editor, "deletion").map((m) => m.text).join("")).toBe("Bonjour");
    expect(marksOf(editor, "insertion").map((m) => m.text).join("")).toBe("Salut");
    // rien n'est réellement retiré tant que rien n'est accepté/refusé
    expect(editor.getText()).toBe("BonjourSalut le monde");
  });
});

describe("TrackChanges — accepter/refuser UNE modification", () => {
  it("acceptChange ne résout que le changement visé, laisse les autres intacts", () => {
    editor = makeSuggestingEditor();
    editor.commands.setTextSelection(1);
    typeText(editor, 1, 1, "X");
    const end = editor.state.doc.content.size - 1;
    editor.commands.setTextSelection(end);
    typeText(editor, end, end, "Y");
    const xPos = editor.state.doc.textContent.indexOf("X") + 1;
    editor.commands.acceptChange(xPos);
    expect(marksOf(editor, "insertion").map((m) => m.text)).toEqual(["Y"]); // X accepté (démarqué), Y encore en attente
    expect(editor.getText()).toContain("X");
  });

  it("rejectChange sur une insertion retire exactement ce texte-là", () => {
    editor = makeSuggestingEditor();
    editor.commands.setTextSelection(1);
    typeText(editor, 1, 1, "X");
    const end = editor.state.doc.content.size - 1;
    editor.commands.setTextSelection(end);
    typeText(editor, end, end, "Y");
    const xPos = editor.state.doc.textContent.indexOf("X") + 1;
    editor.commands.rejectChange(xPos);
    expect(editor.getText()).not.toContain("X");
    expect(editor.getText()).toContain("Y");
  });

  it("acceptChange sur une suppression retire vraiment le texte", () => {
    editor = makeSuggestingEditor();
    editor.commands.setTextSelection(9);
    pressKey(editor, "Backspace"); // marque " " en suppression
    const delPos = editor.state.doc.textContent.indexOf(" ") + 1;
    editor.commands.acceptChange(delPos);
    expect(editor.getText()).toBe("Bonjourle monde");
  });

  it("rejectChange sur une suppression restaure le texte (démarque)", () => {
    editor = makeSuggestingEditor();
    editor.commands.setTextSelection(9);
    pressKey(editor, "Backspace");
    const delPos = editor.state.doc.textContent.indexOf(" ") + 1;
    editor.commands.rejectChange(delPos);
    expect(editor.getText()).toBe("Bonjour le monde");
    expect(marksOf(editor, "deletion")).toHaveLength(0);
  });

  it("acceptChange/rejectChange à une position sans marque est un no-op", () => {
    editor = makeSuggestingEditor();
    const before = editor.getJSON();
    editor.commands.acceptChange(3);
    expect(editor.getJSON()).toEqual(before);
  });
});

describe("TrackChanges — Entrée suivie (saut de paragraphe)", () => {
  it("Entrée dans un paragraphe simple crée un trackBreak 'split' sur le nouveau bloc", () => {
    editor = makeSuggestingEditor();
    editor.commands.setTextSelection(9); // après "Bonjour "
    expect(pressKey(editor, "Enter")).toBe(true);
    const json = editor.getJSON();
    expect(json.content).toHaveLength(2);
    expect(json.content![0]!.content?.map((n) => n.text).join("")).toBe("Bonjour ");
    expect(json.content![1]!.content?.map((n) => n.text).join("")).toBe("le monde");
    const breaks = breaksOf(editor);
    expect(breaks).toHaveLength(1);
    expect(breaks[0]!.kind).toBe("split");
  });

  it("rejectBreak sur un split rejoint les deux blocs", () => {
    editor = makeSuggestingEditor();
    editor.commands.setTextSelection(9);
    pressKey(editor, "Enter");
    const [b] = breaksOf(editor);
    editor.commands.rejectBreak(b!.pos);
    expect(editor.getJSON().content).toHaveLength(1);
    expect(editor.getText()).toBe("Bonjour le monde");
  });

  it("acceptBreak sur un split garde les deux blocs et efface juste le marqueur", () => {
    editor = makeSuggestingEditor();
    editor.commands.setTextSelection(9);
    pressKey(editor, "Enter");
    const [b] = breaksOf(editor);
    editor.commands.acceptBreak(b!.pos);
    expect(editor.getJSON().content).toHaveLength(2);
    expect(breaksOf(editor)).toHaveLength(0);
  });

  it("Entrée dans un item de liste n'est PAS suivie : le comportement natif s'applique", () => {
    editor = makeSuggestingEditor("Alice", "<ul><li><p>abcdef</p></li></ul>");
    let pos = -1;
    editor.state.doc.descendants((node, p) => {
      if (node.isText) pos = p + 3;
    });
    editor.commands.setTextSelection(pos);
    pressKey(editor, "Enter");
    const listItems = editor.getJSON().content![0]!.content ?? [];
    expect(listItems).toHaveLength(2); // la liste s'est bien scindée nativement...
    expect(breaksOf(editor)).toHaveLength(0); // ...mais rien n'a été marqué comme changement suivi
  });
});

describe("TrackChanges — fusion de paragraphes suivie (Backspace/Delete en bordure)", () => {
  function twoParas(author = "Alice") {
    return makeSuggestingEditor(author, "<p>Bonjour</p><p>le monde</p>");
  }

  it("Backspace en tout début du second paragraphe propose une fusion sans rien joindre encore", () => {
    editor = twoParas();
    let pos = -1;
    editor.state.doc.descendants((node, p) => {
      if (node.isText && node.text === "le monde") pos = p;
    });
    editor.commands.setTextSelection(pos);
    expect(pressKey(editor, "Backspace")).toBe(true);
    expect(editor.getJSON().content).toHaveLength(2); // toujours deux blocs
    const breaks = breaksOf(editor);
    expect(breaks).toHaveLength(1);
    expect(breaks[0]!.kind).toBe("merge");
  });

  it("Delete en toute fin du premier paragraphe propose la même fusion", () => {
    editor = twoParas();
    editor.commands.setTextSelection(8); // fin de "Bonjour" (1..8)
    expect(pressKey(editor, "Delete")).toBe(true);
    expect(breaksOf(editor)).toHaveLength(1);
    expect(breaksOf(editor)[0]!.kind).toBe("merge");
  });

  it("acceptBreak sur une fusion joint réellement les deux paragraphes", () => {
    editor = twoParas();
    let pos = -1;
    editor.state.doc.descendants((node, p) => {
      if (node.isText && node.text === "le monde") pos = p;
    });
    editor.commands.setTextSelection(pos);
    pressKey(editor, "Backspace");
    const [b] = breaksOf(editor);
    editor.commands.acceptBreak(b!.pos);
    expect(editor.getJSON().content).toHaveLength(1);
    expect(editor.getText()).toBe("Bonjourle monde");
  });

  it("rejectBreak sur une fusion annule juste la proposition, les blocs restent séparés", () => {
    editor = twoParas();
    let pos = -1;
    editor.state.doc.descendants((node, p) => {
      if (node.isText && node.text === "le monde") pos = p;
    });
    editor.commands.setTextSelection(pos);
    pressKey(editor, "Backspace");
    const [b] = breaksOf(editor);
    editor.commands.rejectBreak(b!.pos);
    expect(editor.getJSON().content).toHaveLength(2);
    expect(breaksOf(editor)).toHaveLength(0);
    expect(editor.getText()).toBe("Bonjour\n\nle monde"); // toujours deux paragraphes -> séparateur de bloc
  });
});

describe("TrackChanges — tout accepter / tout refuser", () => {
  /** Un peu de tout à la fois : une insertion, une suppression, un split ET
   *  une fusion en attente dans le même document. */
  function mixedEditor() {
    const ed = makeSuggestingEditor("Alice", "<p>Bonjour le monde</p><p>Suite</p>");
    ed.commands.setTextSelection(1);
    typeText(ed, 1, 1, "X"); // insertion en tête du 1er paragraphe
    ed.commands.setTextSelection(ed.state.doc.textContent.indexOf("monde") + 1);
    pressKey(ed, "Backspace"); // marque l'espace avant "monde" en suppression
    let suitePos = -1;
    ed.state.doc.descendants((node, p) => {
      if (node.isText && node.text === "Suite") suitePos = p;
    });
    ed.commands.setTextSelection(suitePos);
    pressKey(ed, "Backspace"); // propose de fusionner "Suite" dans le 1er paragraphe
    expect(marksOf(ed, "insertion")).toHaveLength(1);
    expect(marksOf(ed, "deletion")).toHaveLength(1);
    expect(breaksOf(ed)).toHaveLength(1);
    return ed;
  }

  it("acceptAllChanges garde les insertions, applique les suppressions et les sauts/fusions", () => {
    editor = mixedEditor();
    editor.commands.acceptAllChanges();
    expect(marksOf(editor, "insertion")).toHaveLength(0);
    expect(marksOf(editor, "deletion")).toHaveLength(0);
    expect(breaksOf(editor)).toHaveLength(0);
    expect(editor.getJSON().content).toHaveLength(1); // la fusion en attente a bien été jointe
    expect(editor.getText()).toBe("XBonjour lemondeSuite"); // X gardé, l'espace "le|monde" retiré, tout joint
  });

  it("rejectAllChanges retire les insertions, restaure les suppressions, annule sauts/fusions", () => {
    editor = mixedEditor();
    editor.commands.rejectAllChanges();
    expect(marksOf(editor, "insertion")).toHaveLength(0);
    expect(marksOf(editor, "deletion")).toHaveLength(0);
    expect(breaksOf(editor)).toHaveLength(0);
    expect(editor.getJSON().content).toHaveLength(2); // la fusion proposée est annulée : toujours 2 blocs
    expect(editor.getText()).not.toContain("X"); // l'insertion est retirée
    expect(editor.getText()).toContain("Bonjour le monde"); // la suppression est restaurée
  });
});

describe("TrackChanges — comparaison (compare.ts) produit des ids exploitables individuellement", () => {
  it("assigne un id par marque, ré-utilisable par acceptChange", async () => {
    const { compareDocuments } = await import("../src/editor/compare");
    const a = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "alpha beta" }] }] };
    const b = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "alpha BETA" }] }] };
    const { doc: merged } = compareDocuments(a, b, { author: "Comparaison" });
    const marks = (merged.content![0]!.content ?? []).flatMap((n) => n.marks ?? []);
    const ids = marks.map((m) => m.attrs?.id);
    expect(ids.every((id) => typeof id === "string" && id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length); // deletion and insertion here are two separate edits -> distinct ids
  });
});
