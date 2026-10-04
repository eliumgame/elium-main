/**
 * Rechercher / remplacer dans tous les documents : on analyse, on VOIT chaque
 * occurrence (avec son contexte), on coche celles à remplacer, on applique, et
 * on peut annuler. Les documents signés / scellés sont décochés par défaut.
 */
import { useMemo, useState } from "react";
import { AlertTriangle, Loader2, Lock, Replace, RotateCcw, ShieldAlert } from "lucide-react";
import { useI18n } from "../../i18n";
import { useDialogs } from "../../ui/dialogs";
import { reportError } from "../../ui/crash-log";
import {
  applyReplacements,
  scanDocuments,
  undoReplacement,
  type ApplyResult,
  type DocScan,
  type ReplaceDeps,
  type ReplaceOptions,
} from "../replace";
import type { WorkItem } from "../types";

export default function ReplacePanel({
  items,
  deps,
  initialFind,
  onChanged,
}: {
  items: WorkItem[];
  deps: ReplaceDeps;
  initialFind: string;
  onChanged: () => void;
}) {
  const { t, tn } = useI18n();
  const { confirm, alert } = useDialogs();
  const [find, setFind] = useState(initialFind);
  const [replace, setReplace] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [scans, setScans] = useState<DocScan[] | null>(null);
  const [scanOpts, setScanOpts] = useState<ReplaceOptions | null>(null);
  const [selected, setSelected] = useState<Map<string, Set<string>>>(new Map());
  const [busy, setBusy] = useState<"scan" | "apply" | "undo" | null>(null);
  const [progress, setProgress] = useState<[number, number]>([0, 0]);
  const [last, setLast] = useState<{ result: ApplyResult; find: string; replace: string } | null>(null);

  const total = useMemo(() => {
    let n = 0;
    let docs = 0;
    for (const s of selected.values()) {
      n += s.size;
      if (s.size) docs++;
    }
    return { n, docs };
  }, [selected]);

  const runScan = async () => {
    if (!find) return;
    const o: ReplaceOptions = { find, replace, caseSensitive, wholeWord };
    setBusy("scan");
    setLast(null);
    try {
      const out = await scanDocuments(items, o, deps, (d, n) => setProgress([d, n]));
      setScans(out);
      setScanOpts(o);
      // Tout est coché, sauf les documents signés/scellés (le remplacement détruirait leur preuve).
      const sel = new Map<string, Set<string>>();
      for (const s of out)
        if (s.status === "ok" && !s.signed && !s.sealed) sel.set(s.itemId, new Set(s.matches.map((m) => m.id)));
      setSelected(sel);
    } catch (e) {
      reportError("replace-scan", e);
      await alert({ title: t("replace.error_title"), message: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };

  const toggleMatch = (itemId: string, matchId: string) =>
    setSelected((cur) => {
      const next = new Map(cur);
      const set = new Set(next.get(itemId) ?? []);
      if (set.has(matchId)) set.delete(matchId);
      else set.add(matchId);
      next.set(itemId, set);
      return next;
    });

  const toggleDoc = (s: DocScan, on: boolean) =>
    setSelected((cur) => {
      const next = new Map(cur);
      next.set(s.itemId, on ? new Set(s.matches.map((m) => m.id)) : new Set());
      return next;
    });

  const apply = async () => {
    if (!scans || !scanOpts) return;
    const hardChanges = scans.filter((s) => (s.signed || s.sealed) && (selected.get(s.itemId)?.size ?? 0) > 0);
    const ok = await confirm({
      title: t("replace.confirm_title"),
      message:
        tn("replace.confirm_body", total.n, { docs: total.docs }) +
        (hardChanges.length ? `\n\n${tn("replace.confirm_signed", hardChanges.length)}` : "") +
        `\n\n${t("replace.confirm_undo")}`,
      confirmLabel: t("replace.apply"),
      danger: hardChanges.length > 0,
    });
    if (!ok) return;
    setBusy("apply");
    try {
      // Les documents sont analysés avec le texte de remplacement saisi AU MOMENT d'appliquer.
      const o = { ...scanOpts, replace };
      const result = await applyReplacements(scans, selected, o, deps);
      setLast({ result, find: o.find, replace });
      setScans(null);
      onChanged();
      if (result.skipped.length) {
        await alert({
          title: t("replace.skipped_title"),
          message: result.skipped
            .map(
              (s) =>
                `• ${s.title} — ${s.reason === "changed" ? t("replace.skipped_changed") : (s.message ?? t("replace.skipped_error"))}`,
            )
            .join("\n"),
        });
      }
    } catch (e) {
      reportError("replace-apply", e);
      await alert({ title: t("replace.error_title"), message: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };

  const undo = async () => {
    if (!last?.result.batchId) return;
    setBusy("undo");
    try {
      const r = await undoReplacement(last.result.batchId, deps);
      setLast(null);
      onChanged();
      await alert({
        title: t("replace.undone_title"),
        message:
          tn("replace.undone_body", r.restored) +
          (r.skipped.length
            ? `\n\n${r.skipped.map((s) => `• ${s.title} — ${s.reason === "changed" ? t("replace.undo_changed") : (s.message ?? t("replace.skipped_error"))}`).join("\n")}`
            : ""),
      });
    } catch (e) {
      reportError("replace-undo", e);
      await alert({ title: t("replace.error_title"), message: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="ws-replace" role="region" aria-label={t("search.replace_toggle")}>
      <h3 className="ws-replace__title">
        <Replace size={16} /> {t("search.replace_toggle")}
      </h3>
      <p className="muted">{t("replace.intro")}</p>
      <div className="ws-replace__form">
        <label className="ws-field">
          <span>{t("replace.find")}</span>
          <input
            className="input"
            value={find}
            onChange={(e) => setFind(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void runScan()}
          />
        </label>
        <label className="ws-field">
          <span>{t("replace.replace_with")}</span>
          <input className="input" value={replace} onChange={(e) => setReplace(e.target.value)} />
        </label>
        <label className="ws-check">
          <input type="checkbox" checked={caseSensitive} onChange={(e) => setCaseSensitive(e.target.checked)} />{" "}
          {t("replace.case")}
        </label>
        <label className="ws-check">
          <input type="checkbox" checked={wholeWord} onChange={(e) => setWholeWord(e.target.checked)} />{" "}
          {t("replace.whole_word")}
        </label>
        <button
          type="button"
          className="eb eb--sm eb--primary"
          disabled={!find || busy !== null}
          onClick={() => void runScan()}
        >
          {busy === "scan" ? <Loader2 size={14} className="icon-spin" /> : null} {t("replace.scan")}
        </button>
      </div>

      {busy === "scan" && (
        <p role="status" className="muted">
          {t("replace.scanning", { done: progress[0], total: progress[1] })}
        </p>
      )}

      {last && (
        <div className="alert alert--success" role="status">
          <div className="alert__body">
            <div className="alert__title">
              {tn("replace.done", last.result.replaced, { docs: last.result.documents })}
            </div>
          </div>
          {last.result.batchId && (
            <button
              type="button"
              className="eb eb--sm eb--outline"
              disabled={busy !== null}
              onClick={() => void undo()}
            >
              <RotateCcw size={14} /> {t("replace.undo")}
            </button>
          )}
        </div>
      )}

      {scans && (
        <>
          <p className="muted" aria-live="polite">
            {scans.filter((s) => s.status === "ok").length === 0
              ? t("replace.none")
              : tn(
                  "replace.found",
                  scans.reduce((n, s) => n + s.matches.length, 0),
                  { docs: scans.filter((s) => s.status === "ok").length },
                )}
          </p>
          <ul className="ws-replace__docs">
            {scans.map((s) => {
              const sel = selected.get(s.itemId) ?? new Set<string>();
              const risky = s.signed || s.sealed;
              return (
                <li key={s.itemId} className="ws-replace__doc">
                  <div className="ws-replace__dochead">
                    {s.status === "ok" ? (
                      <input
                        type="checkbox"
                        aria-label={`${t("workspace.select")} ${s.title}`}
                        checked={sel.size === s.matches.length}
                        ref={(el) => {
                          if (el) el.indeterminate = sel.size > 0 && sel.size < s.matches.length;
                        }}
                        onChange={(e) => toggleDoc(s, e.target.checked)}
                      />
                    ) : null}
                    <strong>{s.title}</strong>
                    {s.status === "ok" && (
                      <span className="badge badge--neutral">{tn("search.matches", s.matches.length)}</span>
                    )}
                    {s.status === "encrypted" && (
                      <span className="badge badge--warning">
                        <Lock size={11} /> {t("replace.encrypted")}
                      </span>
                    )}
                    {s.status === "error" && (
                      <span className="badge badge--danger">
                        <AlertTriangle size={11} /> {s.error ?? t("replace.skipped_error")}
                      </span>
                    )}
                    {risky && (
                      <span className="badge badge--warning" title={t("replace.signed_hint")}>
                        <ShieldAlert size={11} /> {s.signed ? t("replace.signed") : t("replace.sealed")}
                      </span>
                    )}
                  </div>
                  {s.status === "ok" && (
                    <ul className="ws-replace__matches">
                      {s.matches.slice(0, 50).map((m) => (
                        <li key={m.id}>
                          <label className="ws-check">
                            <input
                              type="checkbox"
                              checked={sel.has(m.id)}
                              onChange={() => toggleMatch(s.itemId, m.id)}
                            />
                            <span className="ws-replace__ctx">
                              …{m.before}
                              <mark className="ws-mark">{m.match}</mark>
                              {replace !== "" || sel.has(m.id) ? <ins className="ws-ins">{replace}</ins> : null}
                              {m.after}…
                            </span>
                          </label>
                        </li>
                      ))}
                      {s.matches.length > 50 && <li className="muted">{tn("replace.more", s.matches.length - 50)}</li>}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
          <div className="ws-replace__foot">
            <span>{tn("replace.selected", total.n, { docs: total.docs })}</span>
            <button
              type="button"
              className="eb eb--sm eb--danger"
              disabled={total.n === 0 || busy !== null}
              onClick={() => void apply()}
            >
              {busy === "apply" ? <Loader2 size={14} className="icon-spin" /> : <Replace size={14} />}{" "}
              {t("replace.apply")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
