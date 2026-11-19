import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useAllWorkers, type ThreadWorker } from "@/hooks/useThreadWorkers";
import { waitingStateLabel } from "@/lib/worker-status";
import { ArchiveCleanupChoices } from "@/routes/window/ArchiveCleanupChoices";
import { workerArchiveCleanupOptions, readArchiveCheck } from "@/routes/window/useWorkerArchive";
import { useManagerThreadsStore } from "@/store/manager-threads";
import { useProjectsStore } from "@/store/projects";
import { threadHref } from "@/lib/worker-href";
import type { WorkerFindingsDto } from "@shared/api/agents";

/** What a worker's archive check answered: what it found, or that it could
 *  not run. A worker with no entry yet is still being checked. */
type Check = { findings: string[] } | "failed";

/** Archiving a thread takes its workers with it, and cannot be undone from
 *  the app (an archived thread is only read, or deleted): the dialog lists them, each with its state and what archiving it
 *  would lose, and asks once for all of it. What a check found is confirmed
 *  by the same button, as in a worker's own dialog.
 *
 *  Several threads (the Threads page's selection) are asked for together:
 *  each thread's workers under its title, one button and one pair of cleanup
 *  choices for all. Each thread is archived by its own request; one that is
 *  refused stays in the dialog with what was found, the rest go. */
export function ArchiveThreadDialog({ threadIds, onDone }: { threadIds: readonly string[]; onDone: () => void }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const threads = useManagerThreadsStore((s) => s.threads);
  const archive = useManagerThreadsStore((s) => s.archive);
  const everyWorker = useAllWorkers();
  const projects = useProjectsStore((s) => s.projects);
  const [busy, setBusy] = useState(false);
  const [checks, setChecks] = useState<ReadonlyMap<string, Check>>(new Map());
  // The threads this dialog has archived: the ones left are still asked for.
  const [archived, setArchived] = useState<ReadonlySet<string>>(new Set());
  // Workers a refusal named, by thread, kept for the ones this page has not
  // heard of: its list comes over the live feed, which can trail the server.
  const [named, setNamed] = useState<ReadonlyMap<string, WorkerFindingsDto[]>>(new Map());
  const [removeWorktrees, setRemoveWorktrees] = useState(true);
  const [deleteBranches, setDeleteBranches] = useState(true);

  const ids = threadIds.filter((id) => !archived.has(id));
  const workersOf = (threadId: string): ThreadWorker[] => everyWorker.filter((worker) => worker.ownerThreadId === threadId);
  const workers = ids.flatMap(workersOf);

  // Each worker is checked once, when the dialog first sees it.
  const asked = useRef(new Set<string>());
  const workerIds = workers.map((worker) => worker.workerId).join(" ");
  useEffect(() => {
    for (const workerId of workerIds ? workerIds.split(" ") : []) {
      if (asked.current.has(workerId)) continue;
      asked.current.add(workerId);
      const answered = (check: Check) => setChecks((before) => new Map(before).set(workerId, check));
      void readArchiveCheck(workerId).then((check) => answered({ findings: check.findings }), () => answered("failed"));
    }
  }, [workerIds]);

  const findingsOf = (workerId: string) => {
    const check = checks.get(workerId);
    return check && check !== "failed" ? check.findings : [];
  };
  const checking = workers.some((worker) => !checks.has(worker.workerId));
  // Shown as rows of their own: nothing is confirmed that was not shown.
  const strangersOf = (threadId: string) => (named.get(threadId) ?? []).filter((worker) => !workersOf(threadId).some((listed) => listed.workerId === worker.id));
  const strangers = ids.flatMap(strangersOf);
  // The user's word is for the workers whose findings are on the page. The
  // archive checks every other one itself (one whose check could not run
  // here, one started since) and answers with what it finds.
  const shownOf = (threadId: string) => [
    ...workersOf(threadId).filter((worker) => findingsOf(worker.workerId).length > 0).map((worker) => worker.workerId),
    ...strangersOf(threadId).map((worker) => worker.id)
  ];
  const confirmable = ids.some((id) => shownOf(id).length > 0);

  // The cleanup boxes, for the workers whose worktree or branch Mandate made.
  const allWorkers = projects.flatMap((project) => project.workers);
  const cleanupsOf = (threadId: string) => workersOf(threadId).map((worker) => {
    const record = allWorkers.find((w) => w.id === worker.workerId);
    return {
      branch: record?.branch ?? null,
      ...workerArchiveCleanupOptions({ workerMode: record?.mode, branch: record?.branch, hasWorktree: Boolean(record?.worktreePath) })
    };
  });
  const cleanups = ids.flatMap(cleanupsOf);
  const withWorktree = cleanups.filter((cleanup) => cleanup.showRemoveWorktree);
  const withBranch = cleanups.filter((cleanup) => cleanup.showDeleteBranch);

  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    const done: string[] = [];
    let refusal: string | null = null;
    // One thread after another, each with what its own rows show and what
    // its own workers have to clean up.
    for (const threadId of ids) {
      const shown = shownOf(threadId);
      const own = cleanupsOf(threadId);
      const result = await archive(threadId, {
        ...(shown.length > 0 ? { confirmed: shown } : {}),
        ...(own.some((cleanup) => cleanup.showRemoveWorktree) ? { removeWorktrees } : {}),
        ...(own.some((cleanup) => cleanup.showDeleteBranch) ? { deleteBranches } : {})
      });
      if (!("error" in result)) {
        done.push(threadId);
        continue;
      }
      // Found by the archive itself (a worker kept working, or its check
      // here could not run): shown on the rows, so the next press is an
      // informed Archive anyway.
      if (result.workers) {
        const found = result.workers;
        const own = new Set(workersOf(threadId).map((worker) => worker.workerId));
        setChecks((before) => {
          const next = new Map(before);
          // The archive checked every worker not confirmed: one this dialog
          // could not check, and the archive names nothing in, is clean.
          for (const [id, check] of before) if (check === "failed" && own.has(id)) next.set(id, { findings: [] });
          for (const worker of found) next.set(worker.id, { findings: worker.findings });
          return next;
        });
        setNamed((before) => new Map(before).set(threadId, found));
      } else refusal ??= result.error;
    }
    setBusy(false);
    if (refusal !== null) toast.error(refusal);
    if (done.length < ids.length) {
      // What was refused stays, for another try.
      setArchived((before) => new Set([...before, ...done]));
    } else onDone();
    // Away from the page of a thread that is no longer there; asked from
    // elsewhere (a list, the sidebar's menu), that page stays.
    if (done.some((id) => pathname === threadHref(id))) navigate("/home");
  };

  const count = workers.length + strangers.length;
  const one = ids.length === 1 ? ids[0]! : null;
  const onDuty = ids.some((id) => Boolean(threads.get(id)?.duty));
  const workerRow = (worker: ThreadWorker) => {
    const check = checks.get(worker.workerId);
    const findings = findingsOf(worker.workerId);
    return (
      <li key={worker.workerId} data-slot="archive-worker" className="px-3 py-2">
        <div className="flex min-w-0 items-baseline gap-2">
          <span data-slot="worker-name" className="min-w-0 truncate text-sm font-medium text-foreground">{worker.name}</span>
          <span data-slot="worker-project" className="shrink-0 text-xs text-chrome">{worker.projectName}</span>
          <span data-slot="worker-state" className="ml-auto shrink-0 text-xs text-chrome">
            {check === undefined ? "Checking…" : check === "failed" ? "Couldn’t check" : waitingStateLabel(worker)}
          </span>
        </div>
        {findings.length > 0 && (
          <p data-slot="worker-findings" role="alert" className="mt-0.5 text-xs text-destructive">{findings.join(" ")}</p>
        )}
      </li>
    );
  };
  const strangerRow = (worker: WorkerFindingsDto) => (
    <li key={worker.id} data-slot="archive-worker" className="px-3 py-2">
      <div className="flex min-w-0 items-baseline gap-2">
        <span data-slot="worker-name" className="min-w-0 truncate text-sm font-medium text-foreground">{worker.name}</span>
        <span data-slot="worker-project" className="shrink-0 text-xs text-chrome" />
        <span data-slot="worker-state" className="ml-auto shrink-0 text-xs text-chrome" />
      </div>
      <p data-slot="worker-findings" role="alert" className="mt-0.5 text-xs text-destructive">{worker.findings.join(" ")}</p>
    </li>
  );
  const rowsOf = (threadId: string) => (
    <ul className="divide-y divide-border-soft rounded-md border border-border-soft">
      {workersOf(threadId).map(workerRow)}
      {strangersOf(threadId).map(strangerRow)}
    </ul>
  );
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onDone(); }}>
      <DialogContent showCloseButton={!busy} className={count > 0 ? "sm:max-w-[480px]" : "sm:max-w-[420px]"}>
        <DialogHeader>
          <DialogTitle className="text-base">
            {one !== null ? `Archive “${threads.get(one)?.title ?? "this thread"}”?` : `Archive ${ids.length} threads?`}
          </DialogTitle>
          {one !== null ? (
            <DialogDescription>
              It moves to the Archived tab of Threads, where you can still read it.
              {count > 0 && ` Its ${count === 1 ? "worker is" : `${count} workers are`} archived with it.`}
            </DialogDescription>
          ) : (
            <DialogDescription>
              They move to the Archived tab of Threads, where you can still read them.
              {count > 0 && ` Their ${count === 1 ? "worker is" : `${count} workers are`} archived with them.`}
            </DialogDescription>
          )}
          {onDuty && (
            <p data-slot="archive-duty" className="text-sm text-muted-foreground">
              {one !== null ? "Its schedules are paused and cannot be resumed." : "Schedules of the threads on duty are paused and cannot be resumed."}
            </p>
          )}
        </DialogHeader>

        {count > 0 && one !== null && rowsOf(one)}
        {/* Several threads: each one's workers under its title. */}
        {count > 0 && one === null && (
          <div className="flex max-h-[45vh] flex-col gap-3 overflow-y-auto">
            {ids.filter((id) => workersOf(id).length + strangersOf(id).length > 0).map((id) => (
              <section key={id} data-slot="archive-thread-group" className="flex flex-col gap-1.5">
                <p data-slot="archive-thread-title" className="truncate text-xs font-medium text-muted-foreground">{threads.get(id)?.title ?? id}</p>
                {rowsOf(id)}
              </section>
            ))}
          </div>
        )}

        <ArchiveCleanupChoices
          disabled={busy}
          worktree={withWorktree.length > 0 ? {
            label: withWorktree.length === 1 ? "Remove worktree" : "Remove worktrees",
            hint: withWorktree.length === 1
              ? "Delete the Mandate-created worktree directory when it is clean."
              : "Delete the worktree directories Mandate made, each when it is clean.",
            checked: removeWorktrees,
            onChange: setRemoveWorktrees
          } : null}
          branch={withBranch.length > 0 ? {
            label: withBranch.length === 1 ? "Delete branch" : "Delete branches",
            hint: withBranch.length === 1
              ? `Delete local branch "${withBranch[0]!.branch}" when it is safe.`
              : "Delete the local branches Mandate made, each when it is safe.",
            checked: deleteBranches,
            onChange: setDeleteBranches
          } : null}
        />

        <DialogFooter className="mt-1">
          <Button type="button" variant="outline" disabled={busy} onClick={onDone}>Cancel</Button>
          <Button type="button" variant="destructive" disabled={busy || checking} onClick={() => void confirm()}>
            {busy ? "Archiving…" : confirmable ? "Archive anyway" : "Archive"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
