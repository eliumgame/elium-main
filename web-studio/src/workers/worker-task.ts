/**
 * Helper commun des tâches lourdes hors du fil principal (généralise `importXlsxAsync`).
 *
 * Côté appelant : `runWorkerTask({ create, request, inline, … })`.
 *  - `create` crée le Worker ; l'URL doit rester un littéral à l'endroit de l'appel pour que Vite
 *    emballe le fichier : `create: () => new Worker(new URL("./x.worker.ts", import.meta.url), { type: "module" })`.
 *  - `inline` exécute la MÊME tâche sur le fil appelant : repli quand Worker est absent (jsdom,
 *    tests), quand sa création échoue (CSP) ou quand il ne démarre pas.
 *  - progression (`onProgress`), annulation (`signal` : le Worker est terminé net), délai maximal
 *    (`timeoutMs`) et plafond d'entrée (`maxInputBytes` + `inputBytes`) avec message clair.
 * Côté Worker : `serveWorkerTask(handler)` (voir worker-host.ts).
 * Mode d'emploi : documentation, section « Tâches lourdes hors du fil principal ».
 */

export interface TaskContext {
  /** Fraction 0–1 et libellé de l'étape en cours. */
  progress(fraction: number, label: string): void;
}

export type WorkerMessage<Res> =
  | { type: "ready" }
  | { type: "progress"; fraction: number; label: string }
  | { type: "result"; value: Res }
  | { type: "error"; message: string; name?: string };

export class WorkerLimitError extends Error {
  override name = "WorkerLimitError";
}
export class WorkerTimeoutError extends Error {
  override name = "WorkerTimeoutError";
}

export interface WorkerTaskOptions<Req, Res> {
  create: () => Worker;
  request: Req;
  /** Objets transférés (pas copiés) vers le Worker : leur contenu n'est plus lisible côté appelant. */
  transfer?: Transferable[];
  /** Même tâche sur le fil appelant. Reçoit la requête d'origine (jamais une copie transférée). */
  inline: (request: Req, ctx: TaskContext) => Res | Promise<Res>;
  onProgress?: (p: { fraction: number; label: string }) => void;
  signal?: AbortSignal;
  /** Au-delà, le Worker est terminé et la promesse rejetée (WorkerTimeoutError). */
  timeoutMs?: number;
  /** Taille des données d'entrée et plafond : refus immédiat (WorkerLimitError) avec `limitMessage`. */
  inputBytes?: number;
  maxInputBytes?: number;
  limitMessage?: string;
  /** Force l'exécution sur le fil appelant. */
  forceInline?: boolean;
  /**
   * Worker réutilisable (tâches à état : le Worker garde des données d'un appel à l'autre). Sur succès le
   * Worker est conservé ; sur annulation, délai ou erreur il est terminé et `set(null)` est appelé.
   */
  reuse?: { get(): Worker | null; set(w: Worker | null): void };
  /** Délai pour que le Worker se déclare prêt (chargement des modules) ; au-delà : repli en ligne. Défaut 20 s. */
  startTimeoutMs?: number;
  /** Libellé du message d'annulation. */
  abortMessage?: string;
}

/** Workers ayant déjà annoncé qu'ils écoutent (un Worker réutilisé n'a pas à le refaire). */
const readyWorkers = new WeakSet<Worker>();

/** Vrai quand un vrai Worker peut être créé (faux sous jsdom/vitest). */
export const workersAvailable = (): boolean => typeof Worker !== "undefined";

export function runWorkerTask<Req, Res>(opts: WorkerTaskOptions<Req, Res>): Promise<Res> {
  const { signal, onProgress } = opts;
  const abortError = () => new DOMException(opts.abortMessage ?? "Opération annulée", "AbortError");
  return new Promise<Res>((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    if (opts.maxInputBytes != null && (opts.inputBytes ?? 0) > opts.maxInputBytes) {
      const mo = (n: number) => `${Math.round(n / 1048576)} Mo`;
      return reject(
        new WorkerLimitError(
          opts.limitMessage ??
            `Fichier trop volumineux (${mo(opts.inputBytes ?? 0)}, maximum ${mo(opts.maxInputBytes)}).`,
        ),
      );
    }
    let worker: Worker | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const finish = (fn: () => void, keep = false) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (worker && keep && opts.reuse) {
        worker.onmessage = null;
        worker.onerror = null;
      } else {
        worker?.terminate();
        opts.reuse?.set(null);
      }
      worker = null;
      fn();
    };
    const onAbort = () => finish(() => reject(abortError()));
    signal?.addEventListener("abort", onAbort);
    const ctx: TaskContext = { progress: (fraction, label) => onProgress?.({ fraction, label }) };

    const runInline = () => {
      if (settled) return;
      Promise.resolve()
        .then(() => opts.inline(opts.request, ctx))
        .then(
          (v) => finish(() => (signal?.aborted ? reject(abortError()) : resolve(v))),
          (e) => finish(() => reject(e)),
        );
    };

    if (opts.forceInline || !workersAvailable()) return runInline();
    let gotMessage = false;
    try {
      worker = opts.reuse?.get() ?? opts.create();
      opts.reuse?.set(worker);
    } catch {
      return runInline(); // CSP ou plateforme sans Worker module
    }
    if (opts.timeoutMs != null) {
      const ms = opts.timeoutMs;
      timer = setTimeout(
        () =>
          finish(() =>
            reject(new WorkerTimeoutError(`L'opération a dépassé ${Math.round(ms / 1000)} s et a été interrompue.`)),
          ),
        ms,
      );
    }
    const post = () => {
      try {
        worker?.postMessage(opts.request, opts.transfer ?? []);
      } catch (e) {
        finish(() => reject(e));
      }
    };
    let startTimer: ReturnType<typeof setTimeout> | undefined;
    const fallBack = () => {
      if (settled || gotMessage) return;
      worker?.terminate();
      opts.reuse?.set(null);
      worker = null;
      runInline();
    };
    worker.onmessage = (ev: MessageEvent<WorkerMessage<Res>>) => {
      gotMessage = true;
      const d = ev.data;
      if (d.type === "ready") {
        // Un module Worker perd les messages envoyés avant la fin de son chargement : on n'envoie qu'après « prêt ».
        if (startTimer) clearTimeout(startTimer);
        if (worker) readyWorkers.add(worker);
        post();
      } else if (d.type === "progress") ctx.progress(d.fraction, d.label);
      else if (d.type === "result") finish(() => resolve(d.value), true);
      else {
        const err = new Error(d.message);
        if (d.name) err.name = d.name;
        finish(() => reject(err));
      }
    };
    worker.onerror = (ev) => {
      ev.preventDefault?.();
      if (!gotMessage && !settled) {
        // Le Worker n'a jamais démarré (chargement refusé) : repli en ligne, sans erreur visible.
        if (startTimer) clearTimeout(startTimer);
        return fallBack();
      }
      finish(() => reject(new Error(ev.message || "Le calcul en arrière-plan a échoué.")));
    };
    if (readyWorkers.has(worker)) {
      gotMessage = true;
      post();
    } else {
      startTimer = setTimeout(fallBack, opts.startTimeoutMs ?? 20_000);
    }
  });
}
