import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { MoreHorizontal, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle
} from "@/components/ui/dialog";
import { api } from "@/lib/api-paths";

interface ArchiveFeatureButtonProps {
  featureId: string;
  featureName: string;
  featureMode?: string;
  branch?: string | null;
  hasWorktree?: boolean;
}

/** Trash-icon button + confirm prompt for archiving a feature. Calls
 *  DELETE /api/features/:id. On success, navigates back to /projects.
 *
 *  Why a button (not just an agent tool): the user expects normal CRUD —
 *  if they made a feature in the UI, they should be able to delete it
 *  from the UI without context-switching to the agent. */
export function ArchiveFeatureButton({
  featureId,
  featureName,
  featureMode,
  branch,
  hasWorktree
}: ArchiveFeatureButtonProps) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const cleanup = useMemo(
    () => featureArchiveCleanupOptions({ featureMode, branch, hasWorktree }),
    [featureMode, branch, hasWorktree]
  );
  const [removeWorktree, setRemoveWorktree] = useState(cleanup.removeWorktreeDefault);
  const [deleteBranch, setDeleteBranch] = useState(cleanup.deleteBranchDefault);

  const onClick = async () => {
    if (busy) return;
    const nextCleanup = featureArchiveCleanupOptions({ featureMode, branch, hasWorktree });
    setRemoveWorktree(nextCleanup.removeWorktreeDefault);
    setDeleteBranch(nextCleanup.deleteBranchDefault);
    setConfirmOpen(true);
  };

  const archive = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const params = new URLSearchParams();
      if (cleanup.showRemoveWorktree) params.set("removeWorktree", String(removeWorktree));
      if (cleanup.showDeleteBranch) params.set("deleteBranch", String(deleteBranch));
      const url = params.size > 0
        ? `${api.featureById(featureId)}?${params.toString()}`
        : api.featureById(featureId);
      const r = await fetch(url, { method: "DELETE" });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        toast.error(body?.error ?? `Archive failed (HTTP ${r.status})`);
        return;
      }
      toast.success(`Archived "${featureName}"`);
      setConfirmOpen(false);
      navigate("/projects");
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Archive request failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {/* Behind an overflow menu, not on the header rail. Archiving a feature is
          rare and irreversible; as a permanent icon beside Refresh it was one
          click away at all times and read as a peer of a reload. This matches
          how projects already expose their destructive action on Home. */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Feature actions"
            title="Feature actions"
            disabled={busy}
            className="text-chrome"
          >
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onSelect={onClick}
            className="text-destructive focus:bg-destructive/10 focus:text-destructive"
          >
            <Trash2 className="h-4 w-4" />
            Archive feature
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={confirmOpen} onOpenChange={(open) => { if (!busy) setConfirmOpen(open); }}>
        <DialogContent showCloseButton={!busy} className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle className="text-base">Archive feature "{featureName}"?</DialogTitle>
            <DialogDescription className="whitespace-pre-line">
              {cleanup.description}
            </DialogDescription>
          </DialogHeader>

          {(cleanup.showRemoveWorktree || cleanup.showDeleteBranch) && (
            <div className="rounded-md border border-border-soft bg-muted/20 p-3 space-y-3">
              {cleanup.showRemoveWorktree && (
                <label className="flex items-start gap-3 text-sm">
                  <input
                    type="checkbox"
                    className="mt-1 h-4 w-4 accent-primary"
                    checked={removeWorktree}
                    disabled={busy}
                    onChange={(event) => setRemoveWorktree(event.currentTarget.checked)}
                  />
                  <span className="min-w-0">
                    <span className="block font-medium text-foreground">Remove worktree</span>
                    <span className="block text-xs text-muted-foreground">
                      Delete the Mandate-created worktree directory when it is clean.
                    </span>
                  </span>
                </label>
              )}
              {cleanup.showDeleteBranch && (
                <label className="flex items-start gap-3 text-sm">
                  <input
                    type="checkbox"
                    className="mt-1 h-4 w-4 accent-primary"
                    checked={deleteBranch}
                    disabled={busy}
                    onChange={(event) => setDeleteBranch(event.currentTarget.checked)}
                  />
                  <span className="min-w-0">
                    <span className="block font-medium text-foreground">Delete branch</span>
                    <span className="block text-xs text-muted-foreground">
                      Delete local branch "{branch}" when it is safe.
                    </span>
                  </span>
                </label>
              )}
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" disabled={busy} onClick={() => void archive()}>
              {busy ? "Archiving..." : "Archive"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function featureArchiveCleanupOptions(input: {
  featureMode?: string;
  branch?: string | null;
  hasWorktree?: boolean;
}): {
  description: string;
  showRemoveWorktree: boolean;
  removeWorktreeDefault: boolean;
  showDeleteBranch: boolean;
  deleteBranchDefault: boolean;
} {
  const lines = ["The chat thread and terminal window/panes will be closed."];
  const showRemoveWorktree = Boolean(input.hasWorktree)
    && (input.featureMode === "new-branch-new-worktree" || input.featureMode === "existing-branch-new-worktree");
  const showDeleteBranch = Boolean(input.branch) && input.featureMode === "new-branch-new-worktree";
  if (input.featureMode === "new-branch-new-worktree") {
    if (input.hasWorktree) lines.push("You can choose whether to remove the Mandate-created worktree.");
    if (input.branch) lines.push(`You can choose whether to delete the Mandate-created local branch "${input.branch}".`);
  } else if (input.featureMode === "existing-branch-new-worktree") {
    if (input.hasWorktree) lines.push("You can choose whether to remove the Mandate-created worktree.");
    if (input.branch) lines.push(`The existing branch "${input.branch}" will be kept.`);
  } else if (input.featureMode === "existing-branch-existing-worktree") {
    lines.push("The existing worktree and branch will be kept.");
  }
  return {
    description: lines.join("\n"),
    showRemoveWorktree,
    removeWorktreeDefault: showRemoveWorktree,
    showDeleteBranch,
    deleteBranchDefault: showDeleteBranch
  };
}
