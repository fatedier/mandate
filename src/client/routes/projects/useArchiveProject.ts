import { useState } from "react";
import { toast } from "sonner";
import { confirmAction } from "@/components/confirm-action";
import { api } from "@/lib/api-paths";
import { errorText } from "@shared/error-text";

interface ArchiveProjectInput {
  projectId: string;
  projectName: string;
  /** When true, offer a follow-up prompt to also kill the tmux session via
   *  ?killTmux=true. */
  hasTmuxSession?: boolean;
  /** Once both questions are answered, as the request goes. */
  onStart?: () => void;
}

/** Two-step archive flow shared by the project actions menu (and anything
 *  else that wants to delete a project from the UI): confirm archive, then
 *  optionally confirm kill-tmux, then DELETE /api/projects/:id. Toasts on
 *  success and failure; resolves whether the project was archived. */
export function useArchiveProject() {
  const [busy, setBusy] = useState(false);

  const archive = async ({ projectId, projectName, hasTmuxSession, onStart }: ArchiveProjectInput): Promise<boolean> => {
    if (busy) return false;
    if (!(await confirmAction({
      title: `Archive project "${projectName}"?`,
      description: "All its workers will also be archived.",
      confirmLabel: "Archive"
    }))) return false;

    let killTmux = false;
    if (hasTmuxSession) {
      killTmux = await confirmAction({
        title: "Also kill the tmux session?",
        description: "Pick \"Kill tmux\" to terminate it. \"Keep running\" leaves the tmux session alive — the project row will still be archived either way.",
        confirmLabel: "Kill tmux",
        cancelLabel: "Keep running"
      });
    }

    setBusy(true);
    onStart?.();
    try {
      const url = killTmux
        ? `${api.projectById(projectId)}?killTmux=true`
        : api.projectById(projectId);
      const r = await fetch(url, { method: "DELETE" });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        toast.error(body?.error ?? `Archive failed (HTTP ${r.status})`);
        return false;
      }
      toast.success(`Archived "${projectName}"`);
      return true;
    } catch (e: unknown) {
      toast.error(errorText(e, "Archive request failed"));
      return false;
    } finally {
      setBusy(false);
    }
  };

  return { archive, busy };
}
