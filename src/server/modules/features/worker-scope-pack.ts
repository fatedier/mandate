import type { WorkerScopeDeps } from "../../runtime/scopes/worker-scope.js";
import { buildWorkerScope } from "../../runtime/scopes/worker-scope.js";
import { scopePack, type ScopePack } from "../../runtime/scope-packs.js";

export function buildWorkerScopePack(deps: WorkerScopeDeps): ScopePack {
  return scopePack("worker", () => buildWorkerScope(deps));
}
