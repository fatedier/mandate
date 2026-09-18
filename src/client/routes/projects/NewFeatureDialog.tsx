import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { SimpleSelect } from "@/components/ui/select";
import { useApi } from "@/hooks/useApi";
import { api } from "@/lib/api-paths";
import { DISABLE_TEXT_ASSIST_PROPS } from "@/lib/input-assist";
import { fieldsForMode, type FeatureMode } from "@/routes/projects/feature-mode-fields";
import type { CreateFeatureResponse, GitBranchesResponse } from "@shared/api-contracts";

interface NewFeatureDialogProps {
  projectId: string;
  projectName: string;
  isGit: boolean;
}

const ALL_MODES: { value: FeatureMode; label: string }[] = [
  { value: "new-branch-new-worktree", label: "New branch + new worktree" },
  { value: "existing-branch-new-worktree", label: "Existing branch + new worktree" },
  { value: "existing-branch-existing-worktree", label: "Existing branch + existing worktree" },
  { value: "shared-cwd", label: "Shared cwd (no worktree)" }
];

export function NewFeatureDialog({ projectId, projectName, isGit }: NewFeatureDialogProps) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [mode, setMode] = useState<FeatureMode>(isGit ? "new-branch-new-worktree" : "shared-cwd");
  const [branch, setBranch] = useState("");
  const [baseRef, setBaseRef] = useState("");
  const [worktreePath, setWorktreePath] = useState("");
  const [branches, setBranches] = useState<string[] | null>(null);
  const [defaultBaseRef, setDefaultBaseRef] = useState<string | null>(null);
  const [branchLoadError, setBranchLoadError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useApi();

  const visibility = fieldsForMode(mode);
  const availableModes = isGit ? ALL_MODES : ALL_MODES.filter((m) => m.value === "shared-cwd");

  const reset = () => {
    setName("");
    setMode(isGit ? "new-branch-new-worktree" : "shared-cwd");
    setBranch("");
    setBaseRef("");
    setWorktreePath("");
    setBranches(null);
    setDefaultBaseRef(null);
    setBranchLoadError(null);
    setError(null);
    setSubmitting(false);
  };

  // Fetch git branch metadata once per open dialog. New branch creation uses
  // the default base ref, and existing branch modes use the branch list.
  useEffect(() => {
    if (!open || !isGit) return;
    if (branches !== null) return;
    void request<GitBranchesResponse>("GET", api.projectBranches(projectId)).then((r) => {
      if (!r || "error" in r) {
        setBranches([]);
        setDefaultBaseRef(null);
        setBranchLoadError(r?.error ?? "Unable to load branches");
        return;
      }
      setBranches(r.branches);
      setDefaultBaseRef(r.defaultBaseRef);
      setBaseRef((current) => current.trim() || r.defaultBaseRef || "");
    });
  }, [open, isGit, branches, projectId, request]);

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    const payload: Record<string, unknown> = { name, mode };
    if (visibility.showBranch) payload.branch = branch;
    if (visibility.showBaseRef) payload.baseRef = baseRef;
    if (visibility.showWorktreePath) payload.worktreePath = worktreePath;
    const result = await request<CreateFeatureResponse>(
      "POST",
      api.projectFeatures(projectId),
      payload
    );
    setSubmitting(false);
    const error = result && "error" in result ? result.error : undefined;
    if (!result || error) {
      setError(error ?? "Request failed");
      return;
    }
    setOpen(false);
    reset();
  };

  const canSubmit =
    !submitting &&
    name.trim().length > 0 &&
    (!visibility.showBranch || branch.trim().length > 0) &&
    (!visibility.showBaseRef || baseRef.trim().length > 0) &&
    (!visibility.showWorktreePath || worktreePath.trim().length > 0);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        {/* Section-level affordance, not a page action: it rests at chrome
            contrast on the header's 28px tier and comes forward on hover. */}
        <Button
          variant="ghost"
          size="xs"
          className="text-chrome hover:text-foreground"
        >
          <Plus className="size-3.5" />
          New feature
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New feature in {projectName}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">Name</span>
            <input
              className="rounded-md border border-border bg-background px-3 py-2"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="auth-rework"
              {...DISABLE_TEXT_ASSIST_PROPS}
              autoFocus
            />
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">Mode</span>
            <SimpleSelect
              value={mode}
              options={availableModes}
              disabled={!isGit && availableModes.length === 1}
              onValueChange={(value) => {
                setMode(value as FeatureMode);
                setBranch("");
                if (value === "new-branch-new-worktree") {
                  setBaseRef((current) => current.trim() || defaultBaseRef || "");
                }
              }}
            />
            {!isGit && (
              <span className="text-2xs text-muted-foreground mt-0.5">
                Git modes are only available when the project is a git repo.
              </span>
            )}
          </label>

          {visibility.showBranch && visibility.branchSource === "new" && (
            <>
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-muted-foreground">Branch (new)</span>
                <input
                  className="rounded-md border border-border bg-background px-3 py-2 font-mono text-xs"
                  value={branch}
                  onChange={(e) => setBranch(e.target.value)}
                  placeholder="feature-x"
                  {...DISABLE_TEXT_ASSIST_PROPS}
                />
              </label>

              <label className="flex flex-col gap-1 text-sm">
                <span className="text-muted-foreground">Base ref</span>
                <input
                  className="rounded-md border border-border bg-background px-3 py-2 font-mono text-xs"
                  value={baseRef}
                  onChange={(e) => setBaseRef(e.target.value)}
                  placeholder={defaultBaseRef ?? "main, origin/main, tag, or commit"}
                  {...DISABLE_TEXT_ASSIST_PROPS}
                />
                <span className="text-2xs text-muted-foreground mt-0.5">
                  Branch will be created from this ref.
                </span>
                {branchLoadError && (
                  <span className="text-2xs text-red mt-0.5">{branchLoadError}</span>
                )}
              </label>
            </>
          )}

          {visibility.showBranch && visibility.branchSource === "existing" && (
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted-foreground">Branch (existing)</span>
              {branches === null ? (
                <span className="text-2xs text-muted-foreground">Loading branches…</span>
              ) : (
                <SimpleSelect
                  value={branch}
                  options={[
                    { value: "", label: "Select a branch…" },
                    ...branches.map((b) => ({ value: b, label: b }))
                  ]}
                  onValueChange={setBranch}
                  className="font-mono text-xs"
                  itemClassName="font-mono text-xs"
                />
              )}
              {branchLoadError && (
                <span className="text-2xs text-red mt-0.5">{branchLoadError}</span>
              )}
            </label>
          )}

          {visibility.showWorktreePath && (
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted-foreground">Existing worktree path</span>
              <input
                className="rounded-md border border-border bg-background px-3 py-2 font-mono text-xs"
                value={worktreePath}
                onChange={(e) => setWorktreePath(e.target.value)}
                placeholder="/path/to/project-feature-x"
                {...DISABLE_TEXT_ASSIST_PROPS}
              />
            </label>
          )}

          {error && <p className="text-xs text-red">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!canSubmit}>
            {submitting ? "Creating…" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
