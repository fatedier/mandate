import { MessageSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAgentChatStore } from "@/store/agent-chat";
import { useChatTrigger } from "@/hooks/useChatTrigger";
import { cn } from "@/lib/utils";
import { UnreadBadge } from "@/components/UnreadBadge";

/** Top-bar chat entry. Opens the current feature's chat on feature routes,
 *  otherwise opens overview chat.
 *  Hidden when the drawer is already open (panel is the close affordance). */
export function TopBarChatTrigger() {
  const drawerOpen = useAgentChatStore((s) => s.drawerOpen);
  const openDrawer = useAgentChatStore((s) => s.openDrawer);
  const { targetScope, unread, label } = useChatTrigger();

  if (drawerOpen) return null;

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={() => openDrawer(targetScope)}
      className={cn("relative", unread > 0 && "text-status-review")}
      aria-label={label}
      title={label}
    >
      <MessageSquare className="h-4 w-4" />
      <UnreadBadge count={unread} className="absolute -top-1 -right-1" />
    </Button>
  );
}
