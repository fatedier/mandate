import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle
} from "@/components/ui/dialog";
import { InlineError, LoadingLine } from "@/components/ViewState";
import { ArchiveCleanupChoices } from "./ArchiveCleanupChoices";
import type { useFeatureArchive } from "./useFeatureArchive";

type FeatureArchiveFlow = ReturnType<typeof useFeatureArchive>;

export function ArchiveFeatureDialog({ featureName, branch, flow }: {
  featureName: string;
  branch?: string | null;
  flow: FeatureArchiveFlow;
}) {
  const {
    busy, confirmOpen, setConfirmOpen, cleanup,
    removeWorktree, setRemoveWorktree, deleteBranch, setDeleteBranch,
    check, findings, checkError, confirmable, runCheck, archive
  } = flow;
  return (
    <Dialog open={confirmOpen} onOpenChange={(open) => { if (!busy) setConfirmOpen(open); }}>
      <DialogContent showCloseButton={!busy} className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle className="text-base">Archive worker "{featureName}"?</DialogTitle>
          <DialogDescription className="whitespace-pre-line">
            {cleanup.description}
          </DialogDescription>
        </DialogHeader>

        {check === "loading" && <LoadingLine>Checking the worktree and branch…</LoadingLine>}
        {checkError !== null && (
          <InlineError detail={checkError} onRetry={() => void runCheck()}>
            Couldn't check the worktree and branch.
          </InlineError>
        )}
        {findings.length > 0 && (
          <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
            <p className="font-medium text-foreground">This would lose work:</p>
            <ul className="mt-1 list-disc pl-5 text-muted-foreground">
              {findings.map((finding) => <li key={finding}>{finding}</li>)}
            </ul>
          </div>
        )}

        <ArchiveCleanupChoices
          disabled={busy}
          worktree={cleanup.showRemoveWorktree ? {
            label: "Remove worktree",
            hint: "Delete the Mandate-created worktree directory when it is clean.",
            checked: removeWorktree,
            onChange: setRemoveWorktree
          } : null}
          branch={cleanup.showDeleteBranch ? {
            label: "Delete branch",
            hint: `Delete local branch "${branch}" when it is safe.`,
            checked: deleteBranch,
            onChange: setDeleteBranch
          } : null}
        />

        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => setConfirmOpen(false)}>
            Cancel
          </Button>
          <Button variant="destructive" disabled={busy || check === "loading"} onClick={() => void archive()}>
            {busy ? "Archiving…" : confirmable ? "Archive anyway" : "Archive"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
