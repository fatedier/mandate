import { useState, type ComponentProps } from "react";
import { Plus } from "lucide-react";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useApi } from "@/hooks/useApi";
import { api } from "@/lib/api-paths";
import { withTmuxInstallHint } from "@/lib/tmux-install";
import type { CreateProjectResponse } from "@shared/api-contracts";
import { TextInput } from "./setup/shared";

interface NewProjectDialogProps {
  /** Visual weight of the trigger button. Default = filled primary CTA
   *  (right for the empty-projects state); the Home pane header passes
   *  "outline" so it reads as a hairline chrome action. */
  triggerVariant?: ComponentProps<typeof Button>["variant"];
  /** Size of the trigger. Default "sm"; the Home pane header passes "xs" so
   *  it sits on the 28px chrome tier. */
  triggerSize?: ComponentProps<typeof Button>["size"];
}

export function NewProjectDialog({
  triggerVariant = "default",
  triggerSize = "sm"
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
        <Button size={triggerSize} variant={triggerVariant}>
          <Plus className="size-3.5" />
          New project
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          {/* The setup pages' field: the app's focus ring, not the browser's
              own outline the bare inputs drew here. */}
          <TextInput label="Name" value={name} onChange={setName} placeholder="My App" autoFocus />
          <TextInput label="Working directory" value={workingDir} onChange={setWorkingDir} placeholder="/path/to/project" mono />
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
