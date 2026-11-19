import { useState } from "react";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";
import { confirmAction } from "@/components/confirm-action";
import { useAgentChatStore } from "@/store/agent-chat";
import { errorText } from "@shared/error-text";

/** Deletes a message of the owner's that the agent has not answered, once
 *  they have confirmed: it leaves the conversation for good. As quiet as
 *  Copy beside it; the server's refusal (answered since, a turn under way)
 *  is shown as it says it. */
export function DeleteMessageButton({ messageId }: { messageId: string }) {
  const [busy, setBusy] = useState(false);
  const run = async () => {
    if (busy) return;
    const confirmed = await confirmAction({
      title: "Delete this message?",
      description: "It is removed from the conversation for good. The agent will not see it.",
      confirmLabel: "Delete"
    });
    if (!confirmed) return;
    setBusy(true);
    try {
      await useAgentChatStore.getState().deleteMessage(messageId);
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      data-slot="delete-message"
      disabled={busy}
      onClick={() => { void run(); }}
      aria-label="Delete message"
      title="Delete message"
      // 18px further from the button before it on a touch screen, as Share
      // is: their 44px touch areas would otherwise overlap.
      className="hit relative inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-chrome transition-colors hover:bg-foreground/10 hover:text-foreground disabled:opacity-50 pointer-coarse:ml-4.5"
    >
      <Trash2 className="h-3.5 w-3.5" aria-hidden />
    </button>
  );
}
