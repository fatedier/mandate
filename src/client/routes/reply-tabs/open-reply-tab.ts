import { toast } from "sonner";
import { errorText } from "@shared/error-text";
import { replyTabId } from "@/lib/panel-tabs";
import { useReplyTabsStore } from "@/store/reply-tabs";

/** Opens a reply in its thread's panel as a tab of its own, kept on the
 *  server so every device shows it, then `open`s that tab; a refusal says
 *  why in a toast. True once it shows. */
export function openReplyTab(threadId: string, messageId: string, text: string, open: (tabId: string) => void): Promise<boolean> {
  return useReplyTabsStore.getState().add(threadId, messageId, text).then(
    (created) => { open(replyTabId(created.id)); return true; },
    (error: unknown) => { toast.error(`Couldn't open it in the panel: ${errorText(error)}`); return false; }
  );
}
