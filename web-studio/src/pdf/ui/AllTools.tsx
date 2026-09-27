import { ChevronRight } from "lucide-react";
import type { Tool } from "../model/types";
import type { Permissions } from "../ops/security";
import { COMMANDS, FAMILIES, unavailableReason, type CommandContext, type CommandDef, type FamilyId } from "./commands";
import type { RibbonTab } from "./state";

/**
 * « Tous les outils », Acrobat's first pane: every family with its commands.
 * The family's name shows its ribbon tab; a command runs as from the ribbon.
 * Commands the document forbids (or that make no sense for it) are greyed.
 */
export default function AllTools(p: {
  ctx: CommandContext;
  restrictions: Permissions | null;
  tool: Tool;
  onFamily: (tab: RibbonTab) => void;
  onRun: (def: CommandDef) => void;
}) {
  const byFamily = new Map<FamilyId, CommandDef[]>();
  for (const c of COMMANDS) byFamily.set(c.family, [...(byFamily.get(c.family) ?? []), c]);
  return (
    <div className="pdfx-panel pdfx-alltools">
      <div className="pdfx-panel__head">
        <span className="pdfx-panel__title">Tous les outils</span>
      </div>
      <div className="pdfx-panel__body">
        {FAMILIES.filter((f) => !f.hidden).map((f) => {
          const Icon = f.icon;
          const headId = `pdfx-alltools-${f.id}`;
          return (
            <section key={f.id} className="pdfx-alltools__family" aria-labelledby={headId}>
              <button
                type="button"
                id={headId}
                className="pdfx-alltools__head"
                onClick={() => p.onFamily(f.tab)}
                title="Afficher ses commandes dans le ruban"
              >
                <Icon size={16} aria-hidden />
                <span>{f.label}</span>
                <ChevronRight size={14} aria-hidden className="pdfx-alltools__chev" />
              </button>
              <ul className="pdfx-alltools__list">
                {(byFamily.get(f.id) ?? []).map((c) => {
                  const CIcon = c.icon;
                  const why = unavailableReason(c, p.ctx, p.restrictions);
                  const active = c.kind === "tool" && c.tool === p.tool;
                  return (
                    <li key={c.id}>
                      <button
                        type="button"
                        className={`pdfx-alltools__cmd ${active ? "is-active" : ""}`}
                        disabled={!!why}
                        aria-pressed={c.kind === "tool" ? active : undefined}
                        title={why ?? (c.shortcut || c.key ? `${c.label} (${c.shortcut ?? c.key})` : undefined)}
                        onClick={() => p.onRun(c)}
                      >
                        <CIcon size={14} aria-hidden />
                        <span>{c.label}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}
