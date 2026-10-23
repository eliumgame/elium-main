import { describe, expect, it } from "vitest";
import { Schema } from "@tiptap/pm/model";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { Proofing, collectIssues } from "../src/editor/proofingExtension";
import { touchedTextblocks, MAX_INCREMENTAL_BLOCKS } from "../src/editor/incremental-decos";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "text*", toDOM: () => ["p", 0] },
    text: { group: "inline" },
  },
});

const plugins = () => (Proofing.config.addProseMirrorPlugins as () => never[]).call({} as never);

function decorated(state: EditorState) {
  const found: string[] = [];
  const set = plugins; // eslint-disable-line @typescript-eslint/no-unused-vars
  for (const p of state.plugins) {
    const d = p.props.decorations?.call(p, state);
    d?.find().forEach((x) => found.push(`${x.from}-${x.to}`));
  }
  return found.sort();
}
const expected = (state: EditorState) =>
  collectIssues(state.doc as never)
    .map((i) => `${i.docFrom}-${i.docTo}`)
    .sort();

const para = (t: string) => schema.node("paragraph", null, t ? [schema.text(t)] : []);

describe("Correcteur — décorations incrémentales", () => {
  it("restent identiques à une reconstruction complète après des éditions variées", () => {
    const doc = schema.node(
      "doc",
      null,
      Array.from({ length: 120 }, (_, i) => para(`le le mot${i}  et  fin ${i}`)),
    );
    let state = EditorState.create({ doc, plugins: plugins() });
    expect(decorated(state)).toEqual(expected(state));
    let seed = 7;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let step = 0; step < 150; step++) {
      const size = state.doc.content.size;
      const pos = Math.max(1, Math.min(size - 1, rnd(size)));
      let tr = state.tr;
      const kind = rnd(5);
      try {
        if (kind === 0) tr = tr.insertText("  zz zz ", pos);
        else if (kind === 1) tr = tr.delete(pos, Math.min(size - 1, pos + 1 + rnd(30)));
        else if (kind === 2) tr = tr.split(pos);
        else if (kind === 3)
          tr = tr.insertText("x", pos).insertText(" y y", Math.min(tr.doc.content.size - 1, pos + 3));
        else tr = tr.setSelection(TextSelection.near(tr.doc.resolve(pos)));
        state = state.apply(tr);
      } catch {
        continue; // position invalide pour ce schéma : on passe
      }
      expect(decorated(state), `étape ${step} (type ${kind})`).toEqual(expected(state));
    }
  });

  it("une frappe ne touche qu'un bloc", () => {
    const doc = schema.node(
      "doc",
      null,
      Array.from({ length: 500 }, (_, i) => para(`texte ${i}`)),
    );
    const state = EditorState.create({ doc, plugins: [] });
    const mid = state.doc.resolve(800).start() + 3; // au milieu d'un bloc
    const tr = state.tr.insertText("a", mid);
    expect(touchedTextblocks(tr)).toHaveLength(1);
  });

  it("un changement massif demande une reconstruction complète", () => {
    const doc = schema.node(
      "doc",
      null,
      Array.from({ length: MAX_INCREMENTAL_BLOCKS * 3 }, (_, i) => para(`texte ${i}`)),
    );
    const state = EditorState.create({ doc, plugins: [] });
    let tr = state.tr;
    for (let i = 0; i < MAX_INCREMENTAL_BLOCKS * 3; i++) tr = tr.insertText("z", tr.mapping.map(1 + i * 9) + 1);
    expect(touchedTextblocks(tr)).toBeNull();
  });
});
