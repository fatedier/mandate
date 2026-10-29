import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useApi } from "@/hooks/useApi";
import { api } from "@/lib/api-paths";
import type { AdoptProjectResponse } from "@shared/api-contracts";
import { TextInput } from "@/routes/projects/setup/shared";

interface AdoptDialogProps {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  sessionName: string;
  /** Best-guess working dir from the first pane's currentPath, or empty. */
  suggestedWorkingDir?: string;
}

export function AdoptDialog({ open, onOpenChange, sessionName, suggestedWorkingDir }: AdoptDialogProps) {
  const [projectName, setProjectName] = useState(sessionName);
  const [workingDir, setWorkingDir] = useState(suggestedWorkingDir ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useApi();

  useEffect(() => {
    if (open) {
      setProjectName(sessionName);
      setWorkingDir(suggestedWorkingDir ?? "");
      setError(null);
    }
  }, [open, sessionName, suggestedWorkingDir]);

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    const result = await request<AdoptProjectResponse>("POST", api.projectAdopt, {
      sessionName, projectName, workingDir
    });
    setSubmitting(false);
    const error = result && "error" in result ? result.error : undefined;
    if (!result || error) {
      setError(error ?? "Request failed");
      return;
    }
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Adopt session "{sessionName}" as project</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <TextInput label="Project name" value={projectName} onChange={setProjectName} autoFocus />
          <TextInput label="Working directory" value={workingDir} onChange={setWorkingDir} placeholder="/path/to/project" mono />
          <p className="text-2xs text-muted-foreground">
            Each existing window will become a feature in shared-cwd mode. You can re-mode them later.
          </p>
          {error && <p className="text-xs text-red">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>Cancel</Button>
          <Button onClick={submit} disabled={submitting || !projectName || !workingDir}>
            {submitting ? "Adopting…" : "Adopt"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
