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
import {
  embeddedDictionary, listDictionary, mergeDictionaries, type DictLang, type SpellChecker,
} from "./dict";

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
  /** Langue du dictionnaire embarqué. */
  lang: DictLang;
  /** Dictionnaire embarqué actif (coupé = pas de détection de mots inconnus). */
  embedded: boolean;
  /** Liste de mots importée, qui complète l'embarqué. */
  imported: string[] | null;
  /** Signaler TOUT mot inconnu, et non les seuls corrigibles. */
  strict: boolean;
  /** Laisser AUSSI le correcteur du navigateur souligner. */
  native: boolean;
  disabled: Set<IssueKind>;
}

const state: ProofState = {
  enabled: true,
  personal: new Set(),
  ignored: new Set(),
  lang: "fr",
  // Actif par défaut : un correcteur qu'il faut allumer ne corrige personne. Le
  // dictionnaire ne se construit qu'à la première analyse (voir `dict/index.ts`).
  embedded: true,
  imported: null,
  strict: false,
  // Coupé par défaut : notre dictionnaire souligne déjà les mots inconnus, et deux
  // soulignements ondulés sous le même mot n'aident personne.
  native: false,
  disabled: new Set(),
};

/**
 * Le dictionnaire courant, mis en cache.
 *
 * Reconstruit uniquement quand un réglage de dictionnaire change : la fusion et la
 * construction paresseuse ne doivent pas être refaites à chaque bloc analysé.
 */
let checker: SpellChecker | null = null;
let checkerKey = "";

function currentChecker(): SpellChecker | null {
  const key = `${state.embedded ? state.lang : ""}|${state.imported?.length ?? 0}`;
  if (checker && checkerKey === key) return checker;
  const embedded = state.embedded ? embeddedDictionary(state.lang) : null;
  const imported = state.imported?.length ? listDictionary(state.imported) : null;
  checker =
    embedded && imported
      ? mergeDictionaries(embedded, imported)
      : embedded ?? imported ?? null;
  checkerKey = key;
  return checker;
}

type Listener = () => void;
const listeners = new Set<Listener>();

/** Signale un changement de réglage aux vues qui en dépendent. */
function notify(): void {
  // Tout changement de réglage périme le cache d'analyse.
  bumpEpoch();
  savePrefs();
  for (const fn of listeners) fn();
}

// --- Persistance des préférences ------------------------------------------

/**
 * Les réglages du correcteur sont des préférences d'APPLICATION, pas du contenu de
 * document : ils vivent donc sur l'appareil, pas dans le fichier `.elium`. Sans
 * cela, le dictionnaire personnel serait à reconstituer à chaque ouverture — le
 * genre de détail qui fait abandonner un correcteur.
 *
 * Le dictionnaire personnel peut contenir des noms propres : il reste local, n'est
 * jamais envoyé, et le volet permet de le vider.
 */
const PREFS_KEY = "elium.proofing.v1";

function savePrefs(): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(
      PREFS_KEY,
      JSON.stringify({
        enabled: state.enabled,
        lang: state.lang,
        embedded: state.embedded,
        strict: state.strict,
        native: state.native,
        personal: [...state.personal],
        disabled: [...state.disabled],
      }),
    );
  } catch {
    // Un stockage indisponible (mode privé, quota) ne doit pas casser la frappe.
  }
}

/** Recharge les réglages persistés. À appeler une fois au démarrage de l'éditeur. */
export function loadProofingPrefs(): void {
  try {
    if (typeof localStorage === "undefined") return;
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return;
    const p = JSON.parse(raw) as Record<string, unknown>;
    if (typeof p.enabled === "boolean") state.enabled = p.enabled;
    if (p.lang === "fr" || p.lang === "en") state.lang = p.lang;
    if (typeof p.embedded === "boolean") state.embedded = p.embedded;
    if (typeof p.strict === "boolean") state.strict = p.strict;
    if (typeof p.native === "boolean") state.native = p.native;
    if (Array.isArray(p.personal)) {
      state.personal = new Set(p.personal.map((w) => String(w).trim()).filter(Boolean));
    }
    if (Array.isArray(p.disabled)) state.disabled = new Set(p.disabled as IssueKind[]);
    bumpEpoch();
    for (const fn of listeners) fn();
  } catch {
    // Des préférences illisibles valent mieux ignorées que fatales.
  }
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
  /** Étiquette du dictionnaire actif (« Français (embarqué) + … »). */
  dictionaryLabel: string;
  /** Nombre de formes couvertes. */
  dictionarySize: number;
  lang: DictLang;
  embedded: boolean;
  imported: number;
  strict: boolean;
  native: boolean;
  personalSize: number;
  ignoredSize: number;
  disabled: IssueKind[];
} {
  const d = currentChecker();
  return {
    enabled: state.enabled,
    hasDictionary: Boolean(d),
    dictionaryLabel: d?.label ?? "Aucun",
    dictionarySize: d?.size ?? 0,
    lang: state.lang,
    embedded: state.embedded,
    imported: state.imported?.length ?? 0,
    strict: state.strict,
    native: state.native,
    personalSize: state.personal.size,
    ignoredSize: state.ignored.size,
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

/**
 * Charge une liste de mots importée (voir `parseDictionary`).
 *
 * Elle **complète** le dictionnaire embarqué au lieu de le remplacer : un fichier
 * de vocabulaire métier n'a aucune raison de faire perdre le français.
 */
export function setDictionary(wordsList: Iterable<string> | null): void {
  state.imported = wordsList ? [...wordsList] : null;
  notify();
}

/** Change la langue du dictionnaire embarqué. */
export function setDictionaryLang(lang: DictLang): void {
  state.lang = lang;
  notify();
}

/** Active ou coupe le dictionnaire embarqué (la détection de mots inconnus). */
export function setEmbeddedDictionary(on: boolean): void {
  state.embedded = Boolean(on);
  notify();
}

/** Bascule entre relecture prudente (par défaut) et relecture exhaustive. */
export function setStrictSpelling(on: boolean): void {
  state.strict = Boolean(on);
  notify();
}

/** Laisse aussi le correcteur du navigateur souligner (double soulignement). */
export function setNativeSpelling(on: boolean): void {
  state.native = Boolean(on);
  notify();
}

/** Les mots ignorés pour la session, pour les afficher ou les vider. */
export function ignoredWords(): string[] {
  return [...state.ignored].sort((a, b) => a.localeCompare(b, "fr"));
}

/** Oublie les mots ignorés (ils redeviennent signalables). */
export function clearIgnored(): void {
  state.ignored = new Set();
  notify();
}

/** Retire un mot du dictionnaire personnel. */
export function removeFromPersonal(word: string): void {
  state.personal.delete(String(word ?? "").trim());
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
 * Cache d'analyse, par nœud de bloc.
 *
 * Les nœuds ProseMirror sont **immuables et partagés** d'un état au suivant :
 * après une frappe, tous les paragraphes sauf un sont littéralement le même objet.
 * Sans ce cache, chaque frappe relançait toutes les expressions régulières sur
 * tout le document — mesuré à 63 ms par touche sur 200 blocs, soit quatre fois le
 * budget d'une image à 60 Hz. Avec, seul le bloc modifié est réanalysé.
 *
 * `epoch` invalide tout quand un réglage change (dictionnaire chargé, mot ignoré,
 * règle coupée) : le cache est indexé sur le nœud, pas sur les réglages.
 */
let epoch = 0;
let cache = new WeakMap<object, { epoch: number; issues: ProofIssue[] }>();

function bumpEpoch(): void {
  epoch += 1;
  // Une nouvelle carte plutôt qu'un vidage : un WeakMap ne se vide pas, et
  // garder les anciennes entrées retiendrait des nœuds morts.
  cache = new WeakMap();
}

/** L'analyse d'un bloc, mise en cache sur le nœud lui-même. */
function issuesFor(node: object, text: string): ProofIssue[] {
  const hit = cache.get(node);
  if (hit && hit.epoch === epoch) return hit.issues;
  const issues = checkText(text, {
    personal: state.personal,
    ignored: state.ignored,
    dictionary: currentChecker(),
    strict: state.strict,
    disabled: state.disabled,
  });
  cache.set(node, { epoch, issues });
  return issues;
}

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
    const issues = issuesFor(node as unknown as object, text);
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

// --- Correction au clic droit ---------------------------------------------

/** Une demande de correction : le problème visé et l'endroit où l'ouvrir. */
export interface ProofRequest {
  issue: DocIssue;
  x: number;
  y: number;
}

let requestListener: ((request: ProofRequest) => void) | null = null;

/**
 * S'abonne aux clics droits sur un mot souligné.
 *
 * Corriger une faute doit se faire là où elle est : ouvrir un volet, y retrouver la
 * ligne et cliquer la suggestion fait trois gestes pour un mot. Le clic droit est
 * le geste attendu — c'est celui de Word — et il vaut mieux le servir nous-mêmes
 * que de laisser le menu du navigateur proposer les suggestions d'un autre
 * dictionnaire que le nôtre.
 */
export function onProofRequest(fn: (request: ProofRequest) => void): () => void {
  requestListener = fn;
  return () => {
    if (requestListener === fn) requestListener = null;
  };
}

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
            // `lang` reste posé : il sert à la césure, à la synthèse vocale et aux
            // lecteurs d'écran, pas seulement au correcteur.
            lang: state.lang,
            // Le correcteur du navigateur est COUPÉ par défaut : le dictionnaire
            // embarqué souligne déjà les mots inconnus, et deux soulignements
            // ondulés sous le même mot, avec deux menus contextuels différents,
            // n'aident personne. Il reste activable pour qui préfère les
            // dictionnaires de son système.
            spellcheck: state.native ? "true" : "false",
          }),
          handleDOMEvents: {
            contextmenu: (view, event) => {
              if (!requestListener || !state.enabled) return false;
              const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
              if (!at) return false;
              // Le problème sous le curseur, s'il y en a un : sinon le menu du
              // navigateur doit garder la main (copier, coller, inspecter…).
              const hit = collectIssues(view.state.doc as never).find(
                (i) => at.pos >= i.docFrom && at.pos <= i.docTo,
              );
              if (!hit) return false;
              event.preventDefault();
              requestListener({ issue: hit, x: event.clientX, y: event.clientY });
              return true;
            },
          },
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
      `${scope} .elium-proof--space-after-punct{${wavy("var(--accent)")}}`,
  ].join("\n");
}
