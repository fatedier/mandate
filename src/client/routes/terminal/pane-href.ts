import { terminalHref } from "@/lib/terminals-model";
import { workerPaneHref, workerInThreadHref } from "@/lib/worker-href";
/** The project shape the switcher needs: the route slug (`tmuxSessionName`,
 *  which `useProjectsStore.bySlug` is keyed by) and each worker's window
 *  name (the worker route's `workerSlug`). */
interface PaneHrefProject {
  tmuxSessionName: string;
  workers: ReadonlyArray<{ tmuxWindowName: string }>;
}

interface PaneHrefInput {
  project: PaneHrefProject | null | undefined;
  /** The TARGET pane's tmux session (Recent can point at another session). */
  sessionName: string;
  windowName: string;
  paneId: string;
  /** Named in a Terminals address when known, so a reused id never attaches. */
  pid?: number;
}

/** Terminal route for a pane picked in a worker terminal's switcher. A
 *  window of the same project that is one of its workers keeps the worker
 *  route so the breadcrumb stays project / worker / pane; any other window
 *  (e.g. `zsh`) and any pane in another session open on the Terminals page,
 *  which works for unmanaged sessions too. */
export function paneHrefFor({ project, sessionName, windowName, paneId, pid }: PaneHrefInput): string {
  const worker = project && project.tmuxSessionName === sessionName
    ? project.workers.find((w) => w.tmuxWindowName === windowName)
    : undefined;
  if (worker && project) {
    return workerPaneHref(project.tmuxSessionName, worker.tmuxWindowName, paneId);
  }
  return pid ? terminalHref(paneId, pid) : `/terminals/pane/${encodeURIComponent(paneId)}`;
}

/** The worker a route names, once the projects hold it. */
type TerminalWorker = { id: string; ownerThreadId: string | null } | null;

/** Where a worker terminal's title links back to: the worker's Terminal tab
 *  in its thread's panel; the projects until they hold the worker (an active
 *  worker always has a thread). */
export function terminalBackHref(worker: TerminalWorker | undefined): string {
  return worker?.ownerThreadId ? workerInThreadHref(worker.ownerThreadId, worker.id, "terminal") : "/projects";
}

/** What a worker terminal's title names and links back to: its worker, by
 *  its route slug until the projects load. */
export function terminalPlace({ workerSlug, workerName, worker }: {
  workerSlug: string | undefined;
  workerName: string | undefined;
  worker?: TerminalWorker;
}): { name: string; backHref: string } {
  return { name: workerName ?? workerSlug ?? "", backHref: terminalBackHref(worker) };
}
