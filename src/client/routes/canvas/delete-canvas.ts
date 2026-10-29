import { toast } from "sonner";
import { confirmAction } from "@/components/confirm-action";
import { api } from "@/lib/api-paths";
import { errorText } from "@shared/error-text";
import type { CanvasUpdatedPayload, DeleteCanvasResponse } from "@shared/api-contracts";
import { canvasTabId } from "@/lib/panel-tabs";
import { useWorkerPanelStore } from "@/store/worker-panel";
import { useAgentPageUi } from "@/store/agent-page-ui";

/** Deletes a canvas for good, after asking: the one way a canvas is deleted
 *  (agents have no tool for it). True when it is gone. On success its tabs
 *  close, in every thread's panel and on Your agent's page, and the lists are
 *  told at once, as the server's event also tells every other page. */
export async function deleteCanvasAfterConfirm(canvas: { id: string; title: string; featureId: string | null }): Promise<boolean> {
  if (!(await confirmAction({
    title: `Delete canvas "${canvas.title}"?`,
    description: "This deletes the canvas and its files. Links to it in chats and plans will say it can't be found. This can't be undone.",
    confirmLabel: "Delete",
    destructive: true
  }))) return false;
  try {
    const res = await fetch(api.canvasById(canvas.id), { method: "DELETE" });
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as DeleteCanvasResponse;
      toast.error(`Delete failed: ${"error" in body ? body.error : res.statusText}`);
      return false;
    }
  } catch (err) {
    toast.error(`Delete failed: ${errorText(err)}`);
    return false;
  }
  closeCanvasTabs(canvas.id);
  window.dispatchEvent(new CustomEvent<CanvasUpdatedPayload>("mandate:canvas-updated", { detail: { canvasId: canvas.id, featureId: canvas.featureId } }));
  return true;
}

function closeCanvasTabs(canvasId: string): void {
  const tab = canvasTabId(canvasId);
  const panels = useWorkerPanelStore.getState();
  for (const [threadId, panel] of Object.entries(panels.byThread)) {
    if (panel.tabs.includes(tab)) panels.closeTab(threadId, tab);
  }
  const page = useAgentPageUi.getState();
  if (page.tabs.includes(tab)) page.closeTab(tab);
}
