/**
 * Le volet du correcteur : la liste des problèmes, avec correction en un clic.
 *
 * Chaque entrée applique sa suggestion **par position dans le document**, pas par
 * recherche-remplacement du texte : deux fautes identiques dans deux paragraphes
 * doivent se corriger séparément, et un remplacement global corrigerait les deux.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Editor } from "@tiptap/react";
import { Check, EyeOff, BookPlus, X, Upload, Trash2, BookOpen } from "lucide-react";
import { Button } from "../ui/components";
import { ISSUE_LABELS, parseDictionary, summarize, type IssueKind } from "./proofing";
import { DICT_LANGS, type DictLang } from "./dict";
import {
  addToPersonal,
  clearIgnored,
  collectIssues,
  ignoreWord,
  ignoredWords,
  onProofingChange,
  personalWords,
  proofingSettings,
  removeFromPersonal,
  setDictionary,
  setDictionaryLang,
  setEmbeddedDictionary,
  setNativeSpelling,
  setProofingEnabled,
  setStrictSpelling,
  type DocIssue,
} from "./proofingExtension";

/** Problèmes montrés par famille avant de devoir cliquer « Afficher plus ». */
const PAGE = 25;

export default function ProofingPanel({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const [issues, setIssues] = useState<DocIssue[]>([]);
  const [settings, setSettings] = useState(() => proofingSettings());
  const [personal, setPersonal] = useState<string[]>(() => personalWords());
  const [ignored, setIgnored] = useState<string[]>(() => ignoredWords());
  // Nombre de problèmes montrés PAR FAMILLE ; « Afficher plus » l'augmente.
  const [limit, setLimit] = useState(PAGE);

  const refresh = useCallback(() => {
    if (editor.isDestroyed) return;
    setIssues(collectIssues(editor.state.doc as never));
    setSettings(proofingSettings());
    setPersonal(personalWords());
    setIgnored(ignoredWords());
  }, [editor]);

  useEffect(() => {
    refresh();
    editor.on("update", refresh);
    // Les réglages vivent hors du document : sans cet abonnement, charger un
    // dictionnaire ne rafraîchirait la liste qu'à la frappe suivante.
    const stop = onProofingChange(refresh);
    return () => {
      editor.off("update", refresh);
      stop();
    };
  }, [editor, refresh]);

  /** Applique une suggestion à la position exacte du problème. */
  const apply = useCallback(
    (issue: DocIssue, suggestion: string) => {
      editor.chain().focus().insertContentAt({ from: issue.docFrom, to: issue.docTo }, suggestion).run();
    },
    [editor],
  );

  const jump = useCallback(
    (issue: DocIssue) => {
      editor.chain().focus().setTextSelection({ from: issue.docFrom, to: issue.docTo }).scrollIntoView().run();
    },
    [editor],
  );

  const importDictionary = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const raw = await file.text();
    setDictionary(parseDictionary(raw));
  }, []);

  /**
   * Les problèmes affichés, bornés par famille.
   *
   * Un document long produit des milliers de problèmes : les rendre tous a figé
   * le navigateur (4807 nœuds DOM mesurés sur 200 paragraphes). On en montre donc
   * un nombre borné et on DIT combien restent — une troncature silencieuse
   * laisserait croire que tout est listé.
   */
  const grouped = useMemo(() => {
    const by = new Map<IssueKind, DocIssue[]>();
    for (const i of issues) {
      const list = by.get(i.kind) ?? [];
      list.push(i);
      by.set(i.kind, list);
    }
    return [...by.entries()].map(([kind, list]) => ({
      kind,
      total: list.length,
      shown: list.slice(0, limit),
    }));
  }, [issues, limit]);

  return (
    <div className="proof">
      <div className="proof__head">
        <span className="proof__title">Correcteur</span>
        <button type="button" className="inspector__close" onClick={onClose} title="Fermer" aria-label="Fermer">
          <X size={14} />
        </button>
      </div>

      <div className="proof__bar">
        <label className="proof__toggle">
          <input type="checkbox" checked={settings.enabled} onChange={(e) => setProofingEnabled(e.target.checked)} />
          Correction active
        </label>
        {/* La langue décide du dictionnaire embarqué : un texte anglais vérifié en
            français serait souligné de bout en bout. */}
        <select
          className="proof__select"
          title="Langue du dictionnaire"
          value={settings.lang}
          onChange={(e) => setDictionaryLang(e.target.value as DictLang)}
        >
          {DICT_LANGS.map((l) => (
            <option key={l.id} value={l.id}>
              {l.label}
            </option>
          ))}
        </select>
        <label className="proof__import" title="Compléter avec une liste de mots ou un fichier .dic">
          <Upload size={13} />
          Importer
          <input type="file" accept=".dic,.txt,.lst,text/plain" onChange={importDictionary} hidden />
        </label>
      </div>

      <div className="proof__bar proof__bar--options">
        <label className="proof__toggle" title="Dictionnaire orthographique embarqué (hors ligne)">
          <input
            type="checkbox"
            checked={settings.embedded}
            onChange={(e) => setEmbeddedDictionary(e.target.checked)}
          />
          Dictionnaire embarqué
        </label>
        {/* Prudent = ne signaler que ce qui est corrigeable. C'est le défaut : un
            lexique embarqué ne couvre pas tout le vocabulaire d'un auteur. */}
        <label
          className="proof__toggle"
          title="Signaler tout mot absent du dictionnaire, même sans correction plausible"
        >
          <input type="checkbox" checked={settings.strict} onChange={(e) => setStrictSpelling(e.target.checked)} />
          Relecture exhaustive
        </label>
        <label className="proof__toggle" title="Laisser aussi le correcteur du navigateur souligner">
          <input type="checkbox" checked={settings.native} onChange={(e) => setNativeSpelling(e.target.checked)} />
          Correcteur du navigateur
        </label>
      </div>

      {settings.hasDictionary ? (
        <p className="proof__hint">
          <BookOpen size={12} /> {settings.dictionaryLabel} — {settings.dictionarySize.toLocaleString("fr-FR")} formes
          {settings.imported > 0 && `, dont ${settings.imported.toLocaleString("fr-FR")} importées`}.
          {!settings.strict && " Mode prudent : seuls les mots corrigeables sont signalés."}
        </p>
      ) : (
        <p className="proof__hint">
          Aucun dictionnaire actif : seules la typographie, les répétitions et les capitales sont vérifiées. Réactivez
          le dictionnaire embarqué pour signaler les mots inconnus.
        </p>
      )}

      <div className="proof__count">{summarize(issues)}</div>

      {!issues.length && <div className="proof__empty">Rien à signaler dans ce document.</div>}

      {grouped.map(({ kind, total, shown }) => (
        <section key={kind} className="proof__group">
          <div className="proof__group-title">
            {ISSUE_LABELS[kind]} <span className="proof__badge">{total}</span>
          </div>
          {shown.map((issue) => (
            <div key={`${issue.docFrom}-${issue.kind}`} className="proof__item">
              <button type="button" className="proof__snippet" onClick={() => jump(issue)} title={issue.message}>
                {issue.text.replace(/\s+/g, "␣")}
              </button>
              <div className="proof__actions">
                {issue.suggestions.slice(0, 3).map((s) => (
                  <button
                    key={s}
                    type="button"
                    className="proof__fix"
                    onClick={() => apply(issue, s)}
                    title={`Remplacer par « ${s.replace(/\s+/g, "␣")} »`}
                  >
                    <Check size={12} /> {s.replace(/\s+/g, "␣")}
                  </button>
                ))}
                {issue.kind === "unknown-word" && (
                  <>
                    <button
                      type="button"
                      className="proof__ghost"
                      onClick={() => addToPersonal(issue.text)}
                      title="Ajouter au dictionnaire personnel"
                    >
                      <BookPlus size={12} /> Ajouter
                    </button>
                    <button
                      type="button"
                      className="proof__ghost"
                      onClick={() => ignoreWord(issue.text)}
                      title="Ignorer ce mot pour cette session"
                    >
                      <EyeOff size={12} /> Ignorer
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
          {total > shown.length && <div className="proof__more">{total - shown.length} de plus dans cette famille</div>}
        </section>
      ))}

      {issues.length > limit && (
        <button type="button" className="proof__showmore" onClick={() => setLimit((l) => l + PAGE)}>
          Afficher plus de problèmes
        </button>
      )}

      {/* Dictionnaire personnel et mots ignorés : deux listes que l'auteur remplit
          en corrigeant, et qu'il doit pouvoir revoir et défaire — un mot ajouté
          par erreur ne doit pas rester accepté pour toujours. */}
      {(personal.length > 0 || ignored.length > 0) && (
        <section className="proof__group proof__lexicon">
          {personal.length > 0 && (
            <>
              <div className="proof__group-title">
                Dictionnaire personnel <span className="proof__badge">{personal.length}</span>
              </div>
              <div className="proof__chips">
                {personal.map((w) => (
                  <button
                    key={w}
                    type="button"
                    className="proof__chip"
                    title={`Retirer « ${w} » du dictionnaire personnel`}
                    onClick={() => removeFromPersonal(w)}
                  >
                    {w} <Trash2 size={11} />
                  </button>
                ))}
              </div>
            </>
          )}
          {ignored.length > 0 && (
            <>
              <div className="proof__group-title">
                Mots ignorés <span className="proof__badge">{ignored.length}</span>
                <button type="button" className="proof__link" onClick={clearIgnored}>
                  Tout réafficher
                </button>
              </div>
              <div className="proof__chips">
                {ignored.map((w) => (
                  <span key={w} className="proof__chip proof__chip--muted">
                    {w}
                  </span>
                ))}
              </div>
            </>
          )}
        </section>
      )}

      <div className="proof__foot">
        <Button variant="ghost" onClick={refresh}>
          Réanalyser
        </Button>
      </div>
    </div>
  );
}
