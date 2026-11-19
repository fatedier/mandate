import { useContext, useRef, type MouseEvent } from "react";
import { PanelRight } from "lucide-react";
import { replyTabId } from "@/lib/panel-tabs";
import { useReplyTabs } from "@/store/reply-tabs";
import { cn } from "@/lib/utils";
import { ReplyTabTargetContext } from "./reply-tab-target";
import { openReplyTab } from "./open-reply-tab";

/** After Copy on a reply's action line: opens the reply in the right panel as
 *  a tab of its own, kept on the server so every device shows it. The panel's
 *  icon, in the accent once the reply has its tab; a click then shows that tab.
 *  Nothing on a chat whose page has no panel for it (no target). */
export function OpenInPanelButton({ messageId, text }: { messageId: string; text: string }) {
  const target = useContext(ReplyTabTargetContext);
  if (!target) return null;
  return <PanelButton threadId={target.threadId} open={target.open} messageId={messageId} text={text} />;
}

function PanelButton({ threadId, open, messageId, text }: { threadId: string; open: (tabId: string) => void; messageId: string; text: string }) {
  const tab = useReplyTabs(threadId).find((t) => t.messageId === messageId) ?? null;
  // A second click while the add is on its way would send it again.
  const adding = useRef(false);
  const label = tab ? "Show in panel" : "Open in panel";
  const onClick = (event: MouseEvent) => {
    // The line sits under a reply that may fold: a click here is not one on it.
    event.preventDefault();
    event.stopPropagation();
    if (tab) return open(replyTabId(tab.id));
    if (adding.current) return;
    adding.current = true;
    void openReplyTab(threadId, messageId, text, open).finally(() => { adding.current = false; });
  };
  return (
    <button
      type="button"
      data-slot="open-in-panel"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn(
        // 18px more apart on a touch screen: Copy's 44px touch area and this
        // one's would otherwise overlap.
        "hit relative inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-sm transition-colors hover:bg-foreground/10 pointer-coarse:ml-4.5",
        tab ? "text-primary" : "text-chrome hover:text-foreground"
      )}
    >
      <PanelRight aria-hidden className="h-3.5 w-3.5" />
    </button>
  );
}
