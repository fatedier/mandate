import { toast } from "sonner";
import { errorText } from "@shared/error-text";
import { useAgentPageUi } from "@/store/agent-page-ui";
import { useThreadTabsStore } from "@/store/thread-tabs";

/** Threads whose open is on its way: a second click would send it again. */
const opening = new Set<string>();

/** Opens a manager thread beside the personal agent: its tab, kept on the server so
 *  every device shows it, then shown. True once it shows; a refusal says why
 *  in a toast. */
export async function openThreadBeside(threadId: string): Promise<boolean> {
  const store = useThreadTabsStore.getState();
  if (!(store.tabs ?? []).some((tab) => tab.threadId === threadId)) {
    if (opening.has(threadId)) return false;
    opening.add(threadId);
    try {
      await store.add(threadId);
    } catch (error) {
      toast.error(`Couldn't open it in the panel: ${errorText(error)}`);
      return false;
    } finally {
      opening.delete(threadId);
    }
  }
  useAgentPageUi.getState().openThread(threadId);
  return true;
}
