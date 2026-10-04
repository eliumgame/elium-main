import "./datatools.css";
/** Outils de données : doublons, texte en colonnes, rechercher/remplacer (regex, toutes feuilles). */
import { useState } from "react";
import SheetModal from "./SheetModal";
import { findAll, removeDuplicates, replaceAll, textToColumns, type FindMatch, type Rect } from "./datatools";
import type { SheetStore } from "./store";

type Tab = "dedupe" | "split" | "find";

const DELIMS: { id: string; label: string; ch: string }[] = [
  { id: "comma", label: "Virgule", ch: "," },
  { id: "semi", label: "Point-virgule", ch: ";" },
  { id: "tab", label: "Tabulation", ch: "\t" },
  { id: "space", label: "Espace", ch: " " },
  { id: "pipe", label: "Barre verticale", ch: "|" },
];

export default function DataToolsModal({
  store,
  active,
  rect,
  rangeLabel,
  initialTab = "find",
  onClose,
}: {
  store: SheetStore;
  active: number;
  rect: Rect;
  rangeLabel: string;
  initialTab?: Tab;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const say = (m: string) => {
    setErr("");
    setMsg(m);
  };
  const fail = (m: string) => {
    setMsg("");
    setErr(m);
  };
  const writable = store.canWrite;

  // doublons
  const [header, setHeader] = useState(true);
  const [cs, setCs] = useState(false);
  const colCount = rect.c1 - rect.c0 + 1;
  const [keyCols, setKeyCols] = useState<boolean[]>(() => Array.from({ length: colCount }, () => true));

  // texte en colonnes
  const [delims, setDelims] = useState<string[]>(["comma"]);
  const [custom, setCustom] = useState("");
  const [merge, setMerge] = useState(false);
  const [fixed, setFixed] = useState(false);
  const [widths, setWidths] = useState("");

  // rechercher / remplacer
  const [find, setFind] = useState("");
  const [repl, setRepl] = useState("");
  const [regex, setRegex] = useState(false);
  const [caseS, setCaseS] = useState(false);
  const [whole, setWhole] = useState(false);
  const [formulas, setFormulas] = useState(false);
  const [allSheets, setAllSheets] = useState(true);
  const [matches, setMatches] = useState<FindMatch[]>([]);

  const runDedupe = () => {
    const cols = keyCols.map((on, i) => (on ? rect.c0 + i : -1)).filter((c) => c >= 0);
    if (!cols.length) return fail("Cochez au moins une colonne.");
    let removed = 0;
    store.transformSheet(active, (sh) => {
      const r = removeDuplicates(sh, rect, { hasHeader: header, cols, caseSensitive: cs });
      removed = r.removed;
      return r.sheet;
    });
    say(
      removed
        ? `${removed} ligne${removed > 1 ? "s" : ""} en double supprimée${removed > 1 ? "s" : ""}.`
        : "Aucun doublon trouvé.",
    );
  };
  const runSplit = () => {
    const d = DELIMS.filter((x) => delims.includes(x.id)).map((x) => x.ch);
    if (custom) d.push(custom);
    const w = fixed
      ? widths
          .split(/[,;\s]+/)
          .map(Number)
          .filter((n) => Number.isInteger(n) && n > 0)
      : undefined;
    if (fixed && !w?.length) return fail("Saisissez des largeurs de colonnes, par exemple « 4, 10 ».");
    if (!fixed && !d.length) return fail("Choisissez au moins un séparateur.");
    let parts = 1;
    store.transformSheet(active, (sh) => {
      const r = textToColumns(sh, rect, fixed ? { widths: w } : { delimiters: d, mergeConsecutive: merge });
      parts = r.maxParts;
      return r.sheet;
    });
    say(`Texte réparti sur ${parts} colonne${parts > 1 ? "s" : ""}.`);
  };
  const opts = () => ({
    find,
    replace: repl,
    regex,
    caseSensitive: caseS,
    wholeCell: whole,
    inFormulas: formulas,
    sheet: allSheets ? null : active,
  });
  const runFind = () => {
    const r = findAll(store.wb, opts());
    if ("error" in r) {
      setMatches([]);
      return fail(r.error);
    }
    setMatches(r.matches);
    say(
      r.matches.length
        ? `${r.matches.length} cellule${r.matches.length > 1 ? "s" : ""} trouvée${r.matches.length > 1 ? "s" : ""}.`
        : "Aucune correspondance.",
    );
  };
  const runReplace = () => {
    const probe = replaceAll(store.wb, opts());
    if ("error" in probe) return fail(probe.error);
    store.transformWorkbook((w) => {
      const r = replaceAll(w, opts());
      return "error" in r ? w : r.wb;
    });
    setMatches([]);
    say(
      probe.count
        ? `${probe.count} remplacement${probe.count > 1 ? "s" : ""} effectué${probe.count > 1 ? "s" : ""}.`
        : "Aucune correspondance.",
    );
  };

  return (
    <SheetModal
      title="Outils de données"
      onClose={onClose}
      wide
      footer={
        <button className="elx-mini elx-mini--primary" onClick={onClose}>
          Fermer
        </button>
      }
    >
      <div role="tablist" className="dtools__tabs" aria-label="Outils">
        {(
          [
            ["find", "Rechercher / remplacer"],
            ["dedupe", "Supprimer les doublons"],
            ["split", "Texte en colonnes"],
          ] as [Tab, string][]
        ).map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            className={`elx-mini ${tab === id ? "elx-mini--primary" : ""}`}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      {(msg || err) && (
        <p role={err ? "alert" : "status"} className={err ? "elx-empty dtools__err" : "elx-empty"}>
          {err || msg}
        </p>
      )}

      {tab === "find" && (
        <section className="dcx-modal__section">
          <label className="dcx-field">
            <span>Rechercher</span>
            <input value={find} onChange={(e) => setFind(e.target.value)} />
          </label>
          <label className="dcx-field">
            <span>Remplacer par</span>
            <input value={repl} onChange={(e) => setRepl(e.target.value)} />
          </label>
          <div className="dtools__opts">
            <label>
              <input type="checkbox" checked={regex} onChange={(e) => setRegex(e.target.checked)} /> Expression
              régulière ($1, $&amp; dans le remplacement)
            </label>
            <label>
              <input type="checkbox" checked={caseS} onChange={(e) => setCaseS(e.target.checked)} /> Respecter la casse
            </label>
            <label>
              <input type="checkbox" checked={whole} onChange={(e) => setWhole(e.target.checked)} /> Cellule entière
            </label>
            <label>
              <input type="checkbox" checked={formulas} onChange={(e) => setFormulas(e.target.checked)} /> Inclure les
              formules
            </label>
            <label>
              <input type="checkbox" checked={allSheets} onChange={(e) => setAllSheets(e.target.checked)} /> Toutes les
              feuilles
            </label>
          </div>
          <div className="dtools__actions">
            <button className="elx-mini" onClick={runFind} disabled={!find}>
              Tout rechercher
            </button>
            <button className="elx-mini elx-mini--primary" onClick={runReplace} disabled={!find || !writable}>
              Tout remplacer
            </button>
          </div>
          {matches.length > 0 && (
            <ul className="dtools__list" aria-label="Cellules trouvées">
              {matches.slice(0, 200).map((m) => (
                <li key={`${m.sheet}-${m.ref}`}>
                  <button
                    className="elx-mini"
                    onClick={() => {
                      store.setActive(m.sheet);
                      onClose();
                    }}
                  >
                    {store.wb.sheets[m.sheet]?.name} !{m.ref}
                  </button>{" "}
                  <span className="dtools__txt">{m.text.length > 60 ? `${m.text.slice(0, 59)}…` : m.text}</span>
                </li>
              ))}
              {matches.length > 200 && <li className="elx-empty">… et {matches.length - 200} autres</li>}
            </ul>
          )}
        </section>
      )}

      {tab === "dedupe" && (
        <section className="dcx-modal__section">
          <p className="elx-empty">
            Plage {rangeLabel}. Les lignes suivantes identiques à une ligne précédente sont supprimées ; la plage se
            referme vers le haut.
          </p>
          <label>
            <input type="checkbox" checked={header} onChange={(e) => setHeader(e.target.checked)} /> La première ligne
            est un en-tête
          </label>
          <label>
            <input type="checkbox" checked={cs} onChange={(e) => setCs(e.target.checked)} /> Respecter la casse
          </label>
          <fieldset className="dtools__cols">
            <legend>Colonnes à comparer</legend>
            {Array.from({ length: colCount }, (_, i) => (
              <label key={i}>
                <input
                  type="checkbox"
                  checked={keyCols[i] ?? true}
                  onChange={(e) => setKeyCols((k) => k.map((v, j) => (j === i ? e.target.checked : v)))}
                />{" "}
                Colonne {i + 1}
              </label>
            ))}
          </fieldset>
          <div className="dtools__actions">
            <button className="elx-mini elx-mini--primary" onClick={runDedupe} disabled={!writable}>
              Supprimer les doublons
            </button>
          </div>
        </section>
      )}

      {tab === "split" && (
        <section className="dcx-modal__section">
          <p className="elx-empty">
            Colonne de la plage {rangeLabel} : le texte est réparti sur les colonnes à sa droite (les cellules
            existantes sont remplacées).
          </p>
          <label>
            <input type="checkbox" checked={fixed} onChange={(e) => setFixed(e.target.checked)} /> Largeur fixe
          </label>
          {fixed ? (
            <label className="dcx-field">
              <span>Largeurs (caractères, séparées par des virgules)</span>
              <input value={widths} onChange={(e) => setWidths(e.target.value)} placeholder="4, 2, 2" />
            </label>
          ) : (
            <>
              <div className="dtools__opts">
                {DELIMS.map((d) => (
                  <label key={d.id}>
                    <input
                      type="checkbox"
                      checked={delims.includes(d.id)}
                      onChange={(e) =>
                        setDelims((x) => (e.target.checked ? [...x, d.id] : x.filter((y) => y !== d.id)))
                      }
                    />{" "}
                    {d.label}
                  </label>
                ))}
                <label className="dcx-field">
                  <span>Autre</span>
                  <input value={custom} maxLength={3} onChange={(e) => setCustom(e.target.value)} />
                </label>
                <label>
                  <input type="checkbox" checked={merge} onChange={(e) => setMerge(e.target.checked)} /> Séparateurs
                  consécutifs = un seul
                </label>
              </div>
            </>
          )}
          <div className="dtools__actions">
            <button className="elx-mini elx-mini--primary" onClick={runSplit} disabled={!writable}>
              Répartir
            </button>
          </div>
        </section>
      )}
    </SheetModal>
  );
}
