import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useThreadWorkers } from "@/hooks/useThreadWorkers";
import { waitingStateLabel } from "@/lib/feature-status";
import { ArchiveCleanupChoices } from "@/routes/window/ArchiveCleanupChoices";
import { featureArchiveCleanupOptions, readArchiveCheck } from "@/routes/window/useFeatureArchive";
import { useManagerThreadsStore } from "@/store/manager-threads";
import { useProjectsStore } from "@/store/projects";
import type { WorkerFindingsDto } from "@shared/api/agents";

/** What a worker's archive check answered: what it found, or that it could
 *  not run. A worker with no entry yet is still being checked. */
type Check = { findings: string[] } | "failed";

/** Archiving a thread takes its workers with it, and cannot be undone from
 *  the app (an archived thread is only read, or deleted): the dialog lists them, each with its state and what archiving it
 *  would lose, and asks once for all of it. What a check found is confirmed
 *  by the same button, as in a worker's own dialog. */
export function ArchiveThreadDialog({ threadId, onDone }: { threadId: string; onDone: () => void }) {
  const navigate = useNavigate();
  const title = useManagerThreadsStore((s) => s.threads.get(threadId)?.title ?? "this thread");
  const archive = useManagerThreadsStore((s) => s.archive);
  const workers = useThreadWorkers(threadId);
  const projects = useProjectsStore((s) => s.projects);
  const [busy, setBusy] = useState(false);
  const [checks, setChecks] = useState<ReadonlyMap<string, Check>>(new Map());
  // Workers a refusal named, kept for the ones this page has not heard of:
  // its list comes over the live feed, which can trail the server.
  const [named, setNamed] = useState<WorkerFindingsDto[]>([]);
  const [removeWorktrees, setRemoveWorktrees] = useState(true);
  const [deleteBranches, setDeleteBranches] = useState(true);

  // Each worker is checked once, when the dialog first sees it.
  const asked = useRef(new Set<string>());
  useEffect(() => {
    for (const { featureId } of workers) {
      if (asked.current.has(featureId)) continue;
      asked.current.add(featureId);
      const answered = (check: Check) => setChecks((before) => new Map(before).set(featureId, check));
      void readArchiveCheck(featureId).then((check) => answered({ findings: check.findings }), () => answered("failed"));
    }
  }, [workers]);

  const findingsOf = (featureId: string) => {
    const check = checks.get(featureId);
    return check && check !== "failed" ? check.findings : [];
  };
  const checking = workers.some((worker) => !checks.has(worker.featureId));
  // Shown as rows of their own: nothing is confirmed that was not shown.
  const strangers = named.filter((worker) => !workers.some((listed) => listed.featureId === worker.id));
  // The user's word is for the workers whose findings are on the page. The
  // archive checks every other one itself (one whose check could not run
  // here, one started since) and answers with what it finds.
  const shown = [
    ...workers.filter((worker) => findingsOf(worker.featureId).length > 0).map((worker) => worker.featureId),
    ...strangers.map((worker) => worker.id)
  ];
  const confirmable = shown.length > 0;

  // The cleanup boxes, for the workers whose worktree or branch Mandate made.
  const features = projects.flatMap((project) => project.features);
  const cleanups = workers.map((worker) => {
    const feature = features.find((f) => f.id === worker.featureId);
    return {
      branch: feature?.branch ?? null,
      ...featureArchiveCleanupOptions({ featureMode: feature?.mode, branch: feature?.branch, hasWorktree: Boolean(feature?.worktreePath) })
    };
  });
  const withWorktree = cleanups.filter((cleanup) => cleanup.showRemoveWorktree);
  const withBranch = cleanups.filter((cleanup) => cleanup.showDeleteBranch);

  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    const result = await archive(threadId, {
      ...(confirmable ? { confirmed: shown } : {}),
      ...(withWorktree.length > 0 ? { removeWorktrees } : {}),
      ...(withBranch.length > 0 ? { deleteBranches } : {})
    });
    setBusy(false);
    if ("error" in result) {
      // Found by the archive itself (a worker kept working, or its check
      // here could not run): shown on the rows, so the next press is an
      // informed Archive anyway.
      if (result.workers) {
        const found = result.workers;
        setChecks((before) => {
          const next = new Map(before);
          // The archive checked every worker not confirmed: one this dialog
          // could not check, and the archive names nothing in, is clean.
          for (const [id, check] of before) if (check === "failed") next.set(id, { findings: [] });
          for (const worker of found) next.set(worker.id, { findings: worker.findings });
          return next;
        });
        setNamed(found);
      } else toast.error(result.error);
      return;
    }
    onDone();
    navigate("/home");
  };

  const count = workers.length + strangers.length;
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onDone(); }}>
      <DialogContent showCloseButton={!busy} className={count > 0 ? "sm:max-w-[480px]" : "sm:max-w-[420px]"}>
        <DialogHeader>
          <DialogTitle className="text-base">Archive “{title}”?</DialogTitle>
          <DialogDescription>
            It moves to Archived in the sidebar, where you can still read it.
            {count > 0 && ` Its ${count === 1 ? "worker is" : `${count} workers are`} archived with it.`}
          </DialogDescription>
        </DialogHeader>

        {count > 0 && (
          <ul className="divide-y divide-border-soft rounded-md border border-border-soft">
            {workers.map((worker) => {
              const check = checks.get(worker.featureId);
              const findings = findingsOf(worker.featureId);
              return (
                <li key={worker.featureId} data-slot="archive-worker" className="px-3 py-2">
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
            })}
            {strangers.map((worker) => (
              <li key={worker.id} data-slot="archive-worker" className="px-3 py-2">
                <div className="flex min-w-0 items-baseline gap-2">
                  <span data-slot="worker-name" className="min-w-0 truncate text-sm font-medium text-foreground">{worker.name}</span>
                  <span data-slot="worker-project" className="shrink-0 text-xs text-chrome" />
                  <span data-slot="worker-state" className="ml-auto shrink-0 text-xs text-chrome" />
                </div>
                <p data-slot="worker-findings" role="alert" className="mt-0.5 text-xs text-destructive">{worker.findings.join(" ")}</p>
              </li>
            ))}
          </ul>
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
