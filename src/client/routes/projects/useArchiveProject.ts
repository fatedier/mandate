import { useState } from "react";
import { toast } from "sonner";
import { confirmAction } from "@/components/confirm-action";
import { api } from "@/lib/api-paths";

interface ArchiveProjectInput {
  projectId: string;
  projectName: string;
  /** When true, offer a follow-up prompt to also kill the tmux session via
   *  ?killTmux=true. */
  hasTmuxSession?: boolean;
}

/** Two-step archive flow shared by the project actions menu (and anything
 *  else that wants to delete a project from the UI): confirm archive, then
 *  optionally confirm kill-tmux, then DELETE /api/projects/:id. Toasts on
 *  success and failure. */
export function useArchiveProject() {
  const [busy, setBusy] = useState(false);

  const archive = async ({ projectId, projectName, hasTmuxSession }: ArchiveProjectInput) => {
    if (busy) return;
    if (!(await confirmAction({
      title: `Archive project "${projectName}"?`,
      description: "All features will also be archived.",
      confirmLabel: "Archive",
      destructive: true
    }))) return;

    let killTmux = false;
    if (hasTmuxSession) {
      killTmux = await confirmAction({
        title: "Also kill the tmux session?",
        description: "Pick \"Kill tmux\" to terminate it. \"Keep running\" leaves the tmux session alive — the project row will still be archived either way.",
        confirmLabel: "Kill tmux",
        cancelLabel: "Keep running",
        destructive: true
      });
    }

    setBusy(true);
    try {
      const url = killTmux
        ? `${api.projectById(projectId)}?killTmux=true`
        : api.projectById(projectId);
      const r = await fetch(url, { method: "DELETE" });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        toast.error(body?.error ?? `Archive failed (HTTP ${r.status})`);
        return;
      }
      toast.success(`Archived "${projectName}"`);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Archive request failed");
    } finally {
      setBusy(false);
    }
  };

  return { archive, busy };
}
