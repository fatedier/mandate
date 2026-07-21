import { useState, type ComponentProps } from "react";
import { Plus } from "lucide-react";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useApi } from "@/hooks/useApi";
import { api } from "@/lib/api-paths";
import { DISABLE_TEXT_ASSIST_PROPS } from "@/lib/input-assist";
import { withTmuxInstallHint } from "@/lib/tmux-install";
import type { CreateProjectResponse } from "@shared/api-contracts";

interface NewProjectDialogProps {
  /** Visual weight of the trigger button. Default = filled primary CTA
   *  (right for the empty-projects state); pass "ghost" for low-key chrome
   *  like the TopBar action slot. */
  triggerVariant?: ComponentProps<typeof Button>["variant"];
  /** Render only the `+` icon (text label goes to title tooltip + aria-label).
   *  Use this in TopBar to match the icon-only chat trigger; keep false in
   *  empty-state CTAs where the label discoverability matters. */
  triggerIconOnly?: boolean;
}

export function NewProjectDialog({
  triggerVariant = "default",
  triggerIconOnly = false
}: NewProjectDialogProps = {}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [workingDir, setWorkingDir] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useApi();

  const reset = () => {
    setName("");
    setWorkingDir("");
    setError(null);
    setSubmitting(false);
  };

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    const result = await request<CreateProjectResponse>(
      "POST",
      api.projects,
      { name, workingDir }
    );
    setSubmitting(false);
    const error = result && "error" in result ? result.error : undefined;
    if (!result || error) {
      setError(error ? withTmuxInstallHint(error) : "Request failed");
      return;
    }
    setOpen(false);
    reset();
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { setOpen(next); if (!next) reset(); }}>
      <DialogTrigger asChild>
        {triggerIconOnly ? (
          <Button
            size="icon"
            variant={triggerVariant}
            aria-label="New project"
            title="New project"
          >
            <Plus className="h-4 w-4" />
          </Button>
        ) : (
          <Button size="sm" variant={triggerVariant}>
            <Plus className="h-4 w-4" />
            New project
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">Name</span>
            <input
              className="rounded-md border border-border bg-background px-3 py-2"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My App"
              {...DISABLE_TEXT_ASSIST_PROPS}
              autoFocus
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">Working directory</span>
            <input
              className="rounded-md border border-border bg-background px-3 py-2 font-mono text-xs"
              value={workingDir}
              onChange={(e) => setWorkingDir(e.target.value)}
              placeholder="/path/to/project"
              {...DISABLE_TEXT_ASSIST_PROPS}
            />
          </label>
          {error && <p className="whitespace-pre-line text-xs leading-5 text-red">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={submitting}>Cancel</Button>
          <Button onClick={submit} disabled={submitting || !name || !workingDir}>
            {submitting ? "Creating…" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
