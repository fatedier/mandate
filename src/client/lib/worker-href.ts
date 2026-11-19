import type { WorkerTab } from "@/lib/worker-groups";

/** A pane inside a worker. Keyed by tmux names, not ids: the segments are
 *  project.tmuxSessionName and worker.tmuxWindowName. */
export function workerPaneHref(projectSlug: string, workerSlug: string, paneId: string): string {
  return `/projects/${encodeURIComponent(projectSlug)}/workers/${encodeURIComponent(workerSlug)}/pane/${encodeURIComponent(paneId)}`;
}

export function threadHref(threadId: string): string {
  return `/threads/${encodeURIComponent(threadId)}`;
}

/** A worker opened in its owner thread's panel, on `tab` when given. */
export function workerInThreadHref(threadId: string, workerId: string, tab?: WorkerTab): string {
  return `${threadHref(threadId)}?worker=${encodeURIComponent(workerId)}${tab ? `&tab=${tab}` : ""}`;
}
