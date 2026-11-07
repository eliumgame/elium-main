/**
 * Débit par minute et quota mensuel de tokens, par client.
 *
 * Le débit est en mémoire (fenêtre glissante d'une minute). La consommation mensuelle est
 * persistée dans un petit fichier JSON (écriture différée et atomique) pour qu'un redémarrage
 * ne remette pas les compteurs à zéro — sinon un quota ne protégerait pas la facture.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface MonthUsage {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  /** Dépense estimée (€) à partir des prix indicatifs configurés. */
  costEur: number;
}

type Store = Record<string, Record<string, MonthUsage>>; // mois "AAAA-MM" → client → usage

export function monthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

const empty = (): MonthUsage => ({ requests: 0, promptTokens: 0, completionTokens: 0, costEur: 0 });

export class UsageTracker {
  private store: Store = {};
  private hits = new Map<string, number[]>();
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly file: string | null,
    private readonly now: () => number = Date.now,
  ) {
    if (file) {
      try {
        const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
        if (parsed && typeof parsed === "object") this.store = parsed as Store;
      } catch {
        // Fichier absent (premier démarrage) ou illisible : on repart de zéro.
      }
    }
  }

  /** Enregistre une requête dans la fenêtre d'une minute ; renvoie false si le débit est dépassé. */
  takeRequestSlot(clientId: string, perMinute: number): boolean {
    const t = this.now();
    const recent = (this.hits.get(clientId) ?? []).filter((x) => t - x < 60_000);
    if (recent.length >= perMinute) {
      this.hits.set(clientId, recent);
      return false;
    }
    recent.push(t);
    this.hits.set(clientId, recent);
    return true;
  }

  get(clientId: string): MonthUsage {
    return { ...(this.store[monthKey(new Date(this.now()))]?.[clientId] ?? empty()) };
  }

  /** Vrai si le client a encore du quota ce mois-ci (0 = illimité). */
  hasQuota(clientId: string, monthlyTokenQuota: number): boolean {
    if (monthlyTokenQuota === 0) return true;
    const u = this.get(clientId);
    return u.promptTokens + u.completionTokens < monthlyTokenQuota;
  }

  record(clientId: string, promptTokens: number, completionTokens: number, costEur: number): void {
    const m = monthKey(new Date(this.now()));
    const month = (this.store[m] ??= {});
    const u = (month[clientId] ??= empty());
    u.requests += 1;
    u.promptTokens += promptTokens;
    u.completionTokens += completionTokens;
    u.costEur = Math.round((u.costEur + costEur) * 1e6) / 1e6;
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (!this.file || this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, 2000);
    this.flushTimer.unref();
  }

  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.store, null, 2));
    renameSync(tmp, this.file);
  }
}
