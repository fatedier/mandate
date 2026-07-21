import { MessageSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAgentChatStore } from "@/store/agent-chat";
import { useChatTrigger } from "@/hooks/useChatTrigger";
import { cn } from "@/lib/utils";

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
      className={cn("relative", unread > 0 && "text-primary")}
      aria-label={label}
      title={label}
    >
      <MessageSquare className="h-4 w-4" />
      {unread > 0 && (
        <span className="absolute -top-1 -right-1 inline-flex items-center justify-center min-w-[16px] h-4 px-1 rounded-full bg-primary text-primary-foreground text-2xs font-semibold num">
          {unread > 99 ? "99+" : unread}
        </span>
      )}
    </Button>
  );
}
