import { useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { api } from "@/lib/api-paths";
import type { ArchiveCheckDto } from "@shared/api/features";
import { errorText } from "@shared/error-text";
import { readJson } from "@/lib/api-json";

/** Archiving a worker: the dialog's cleanup choices, the check of what it
 *  would lose (asked when the dialog opens), and the archive itself. */
export function useFeatureArchive({ featureId, featureName, featureMode, branch, hasWorktree, onArchived }: {
  featureId: string;
  featureName: string;
  featureMode?: string;
  branch?: string | null;
  hasWorktree?: boolean;
  onArchived?: () => void;
}) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const cleanup = useMemo(
    () => featureArchiveCleanupOptions({ featureMode, branch, hasWorktree }),
    [featureMode, branch, hasWorktree]
  );
  const [removeWorktree, setRemoveWorktree] = useState(cleanup.removeWorktreeDefault);
  const [deleteBranch, setDeleteBranch] = useState(cleanup.deleteBranchDefault);
  // What archiving would lose, asked of the server when the dialog opens.
  // "loading" until it answers.
  const [check, setCheck] = useState<ArchiveCheckDto | "loading" | null>(null);
  const findings = check && check !== "loading" ? check.findings : [];
  // The check itself failed: said apart from what would be lost, since it is
  // not a finding the user can confirm; Archive lets the server run its own.
  const [checkError, setCheckError] = useState<string | null>(null);
  const confirmable = findings.length > 0 && checkError === null;
  // Only the newest check answers: a reopened dialog or a Retry supersedes.
  const checkSeq = useRef(0);

  const open = async () => {
    if (busy) return;
    const nextCleanup = featureArchiveCleanupOptions({ featureMode, branch, hasWorktree });
    setRemoveWorktree(nextCleanup.removeWorktreeDefault);
    setDeleteBranch(nextCleanup.deleteBranchDefault);
    setConfirmOpen(true);
    await runCheck();
  };

  const runCheck = async () => {
    const seq = ++checkSeq.current;
    setCheck("loading");
    setCheckError(null);
    try {
      const result = await readArchiveCheck(featureId);
      if (seq !== checkSeq.current) return;
      setCheck(result);
    } catch (err) {
      if (seq !== checkSeq.current) return;
      setCheck(null);
      setCheckError(errorText(err));
    }
  };

  const archive = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const params = new URLSearchParams();
      if (cleanup.showRemoveWorktree) params.set("removeWorktree", String(removeWorktree));
      if (cleanup.showDeleteBranch) params.set("deleteBranch", String(deleteBranch));
      // The user has read what it would lose and chose to archive anyway.
      if (confirmable) params.set("confirmed", "true");
      const url = params.size > 0
        ? `${api.featureById(featureId)}?${params.toString()}`
        : api.featureById(featureId);
      const r = await fetch(url, { method: "DELETE" });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        // Found since the dialog opened (the worker kept working): show what
        // the server found, so the next click is an informed Archive anyway.
        if (r.status === 409 && Array.isArray(body?.check?.findings)) {
          checkSeq.current += 1;
          setCheck(body.check as ArchiveCheckDto);
          setCheckError(null);
          return;
        }
        toast.error(body?.error ?? `Archive failed (HTTP ${r.status})`);
        return;
      }
      toast.success(`Archived "${featureName}"`);
      setConfirmOpen(false);
      if (onArchived) onArchived();
      else navigate("/projects");
    } catch (e: unknown) {
      toast.error(errorText(e, "Archive request failed"));
    } finally {
      setBusy(false);
    }
  };

  return {
    busy, confirmOpen, setConfirmOpen, cleanup,
    removeWorktree, setRemoveWorktree, deleteBranch, setDeleteBranch,
    check, findings, checkError, confirmable,
    open, runCheck, archive
  };
}

/** What archiving this worker would lose, asked of the server. Rejects when
 *  the check could not run or its answer names no findings. */
export async function readArchiveCheck(featureId: string): Promise<ArchiveCheckDto> {
  const result = await readJson<ArchiveCheckDto>(await fetch(api.featureArchiveCheck(featureId)));
  if (!Array.isArray(result?.findings)) throw new Error("The answer named no findings.");
  return result;
}

/** Which cleanups a worker's archive offers: a worktree Mandate made for it,
 *  and a branch Mandate made for it. */
export function featureArchiveCleanupOptions(input: {
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
