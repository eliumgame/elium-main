/**
 * Le correcteur côté TipTap : soulignement des problèmes et correcteur natif.
 *
 * Les problèmes sont des **décorations** recalculées à chaque transaction, jamais
 * stockées dans le document : un texte corrigé ailleurs ne doit pas garder un
 * soulignement fantôme, et le document ne doit pas grossir de marques de
 * correction.
 *
 * Le calcul se fait **par bloc de texte** et non sur tout le document d'un coup :
 * les positions ProseMirror sont locales au bloc, et surtout un document long
 * resterait fluide puisque seul le bloc visité est réanalysé.
 */
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { checkText, type IssueKind, type ProofIssue } from "./proofing";

/** Un problème replacé dans les coordonnées du document. */
export interface DocIssue extends ProofIssue {
  /** Position absolue du début dans le document. */
  docFrom: number;
  docTo: number;
}

/** État partagé du correcteur, hors document (donc hors historique d'annulation). */
interface ProofState {
  enabled: boolean;
  personal: Set<string>;
  ignored: Set<string>;
  dictionary: Set<string> | null;
  disabled: Set<IssueKind>;
}

const state: ProofState = {
  enabled: true,
  personal: new Set(),
  ignored: new Set(),
  dictionary: null,
  disabled: new Set(),
};

type Listener = () => void;
const listeners = new Set<Listener>();

/** Signale un changement de réglage aux vues qui en dépendent. */
function notify(): void {
  for (const fn of listeners) fn();
}

/** S'abonne aux changements de réglage du correcteur. */
export function onProofingChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Les réglages courants, en lecture. */
export function proofingSettings(): {
  enabled: boolean;
  hasDictionary: boolean;
  personalSize: number;
  disabled: IssueKind[];
} {
  return {
    enabled: state.enabled,
    hasDictionary: Boolean(state.dictionary?.size),
    personalSize: state.personal.size,
    disabled: [...state.disabled],
  };
}

/** Active ou coupe la correction. */
export function setProofingEnabled(on: boolean): void {
  state.enabled = Boolean(on);
  notify();
}

/** Active ou coupe une règle. */
export function setRuleEnabled(kind: IssueKind, on: boolean): void {
  if (on) state.disabled.delete(kind);
  else state.disabled.add(kind);
  notify();
}

/** Charge le dictionnaire de référence (voir `parseDictionary`). */
export function setDictionary(wordsList: Iterable<string> | null): void {
  state.dictionary = wordsList ? new Set(wordsList) : null;
  notify();
}

/** Ajoute un mot au dictionnaire personnel. */
export function addToPersonal(word: string): void {
  const w = String(word ?? "").trim();
  if (w) state.personal.add(w);
  notify();
}

/** Ignore un mot pour la session. */
export function ignoreWord(word: string): void {
  const w = String(word ?? "").trim();
  if (w) state.ignored.add(w);
  notify();
}

/** Le dictionnaire personnel, pour le persister. */
export function personalWords(): string[] {
  return [...state.personal].sort((a, b) => a.localeCompare(b, "fr"));
}

/** Recharge un dictionnaire personnel persisté. */
export function loadPersonal(wordsList: Iterable<string>): void {
  state.personal = new Set([...wordsList].map((w) => String(w).trim()).filter(Boolean));
  notify();
}

/** Les blocs de texte qui valent la peine d'être analysés. */
const SKIP_BLOCKS = new Set(["codeBlock", "mergeField", "tableOfContents", "indexBlock"]);

/**
 * Tous les problèmes d'un document, en coordonnées absolues.
 *
 * Exporté pour le volet : il doit lister exactement ce qui est souligné, donc il
 * lit la même fonction plutôt que d'en dériver une seconde.
 */
export function collectIssues(doc: {
  descendants: (fn: (node: {
    type: { name: string };
    isTextblock: boolean;
    textContent: string;
  }, pos: number) => boolean | void) => void;
}): DocIssue[] {
  if (!state.enabled) return [];
  const out: DocIssue[] = [];
  doc.descendants((node, pos) => {
    if (SKIP_BLOCKS.has(node.type.name)) return false;
    if (!node.isTextblock) return true;
    const text = node.textContent;
    if (!text) return false;
    const issues = checkText(text, {
      personal: state.personal,
      ignored: state.ignored,
      dictionary: state.dictionary,
      disabled: state.disabled,
    });
    for (const issue of issues) {
      // +1 : la position du bloc désigne son ouverture, son contenu commence
      // juste après. Oublier ce décalage souligne un caractère trop à gauche.
      out.push({ ...issue, docFrom: pos + 1 + issue.from, docTo: pos + 1 + issue.to });
    }
    return false;
  });
  return out;
}

const proofingKey = new PluginKey("eliumProofing");

export const Proofing = Extension.create({
  name: "eliumProofing",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: proofingKey,
        // Les décorations ne sont recalculées que lorsqu'un nouvel état apparaît.
        // Charger un dictionnaire, ignorer un mot ou couper une règle ne modifie
        // QUE de l'état externe : sans cette transaction vide, le volet listerait
        // des problèmes que le texte ne souligne pas.
        view: (view) => {
          const stop = onProofingChange(() => {
            if (view.isDestroyed) return;
            view.dispatch(view.state.tr.setMeta(proofingKey, "settings"));
          });
          return { destroy: stop };
        },
        props: {
          attributes: () => ({
            // Le correcteur NATIF du navigateur reste chargé de l'orthographe :
            // il utilise les dictionnaires du système, donc hors ligne et sans
            // embarquer plusieurs mégaoctets. `lang` est ce qui le fait vérifier
            // en français plutôt que dans la langue de l'interface.
            lang: "fr",
            spellcheck: state.enabled ? "true" : "false",
          }),
          decorations: (editorState) => {
            const decos = collectIssues(editorState.doc as never).map((issue) =>
              Decoration.inline(issue.docFrom, issue.docTo, {
                class: `elium-proof elium-proof--${issue.kind}`,
                title: issue.message,
              }),
            );
            return DecorationSet.create(editorState.doc, decos);
          },
        },
      }),
    ];
  },
});

/** Le CSS des soulignements, généré depuis les familles de problèmes. */
export function proofingCss(scope = ".elium-prose"): string {
  // Un soulignement ondulé plutôt qu'un fond : il se superpose au surlignage et
  // aux marques de révision sans les masquer.
  const wavy = (color: string) =>
    `text-decoration:underline;text-decoration-style:wavy;text-decoration-color:${color};` +
    "text-decoration-skip-ink:none;text-underline-offset:2px;";
  return [
    `${scope} .elium-proof{${wavy("var(--warning, #b45309)")}}`,
    `${scope} .elium-proof--unknown-word{${wavy("var(--danger, #dc2626)")}}`,
    `${scope} .elium-proof--repeated{${wavy("var(--danger, #dc2626)")}}`,
    // Les fautes de typographie sont moins graves : teinte plus douce.
    `${scope} .elium-proof--double-space,${scope} .elium-proof--space-before-punct,` +
      `${scope} .elium-proof--space-after-punct{${wavy("var(--accent, #7c3aed)")}}`,
  ].join("\n");
}
