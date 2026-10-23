/// <reference lib="webworker" />
/**
 * Côté Worker du helper commun (voir worker-task.ts) : reçoit la requête, exécute le gestionnaire,
 * renvoie progression, résultat ou erreur. Usage, dans un fichier `*.worker.ts` :
 *   serveWorkerTask<Req, Res>(async (req, ctx) => ({ value, transfer: [value.buffer] }));
 * Le gestionnaire peut renvoyer directement la valeur, ou `{ value, transfer }` pour transférer des buffers.
 */
import type { TaskContext, WorkerMessage } from "./worker-task";

export interface TaskOutput<Res> {
  value: Res;
  transfer?: Transferable[];
}

function isTaskOutput<Res>(v: unknown): v is TaskOutput<Res> {
  return typeof v === "object" && v !== null && "value" in v && "transfer" in v;
}

export function serveWorkerTask<Req, Res>(
  handler: (req: Req, ctx: TaskContext) => Promise<Res | TaskOutput<Res>> | Res | TaskOutput<Res>,
): void {
  const scope = self as unknown as DedicatedWorkerGlobalScope;
  const send = (m: WorkerMessage<Res>, transfer: Transferable[] = []) => scope.postMessage(m, transfer);
  scope.onmessage = async (ev: MessageEvent<Req>) => {
    try {
      const out = await handler(ev.data, {
        progress: (fraction, label) => send({ type: "progress", fraction, label }),
      });
      if (isTaskOutput<Res>(out)) send({ type: "result", value: out.value }, out.transfer);
      else send({ type: "result", value: out as Res });
    } catch (e) {
      send({
        type: "error",
        message: e instanceof Error ? e.message : String(e),
        name: e instanceof Error ? e.name : undefined,
      });
    }
  };
  send({ type: "ready" });
}
