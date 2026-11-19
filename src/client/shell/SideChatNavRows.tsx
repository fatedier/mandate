import { NavLink } from "react-router";
import { useSideChatsStore, isSideChatNew, sideChatHref } from "@/store/side-chats";
import { cn } from "@/lib/utils";
import { ThreadStateMark } from "./ThreadStateMark";

/** The side chats under the agent's row: each as a thread's row is drawn
 *  (the working mark, a bold title while something is new), indented under
 *  the agent whose conversation they came from. */
export function SideChatNavRows({ onNavigate }: { onNavigate?: () => void }) {
  const chats = useSideChatsStore((s) => s.sideChats) ?? [];
  return (
    <div role="group" aria-label="Side chats" className="flex flex-col gap-0.5 pt-0.5 pl-5">
      {chats.map((chat) => {
        const unread = isSideChatNew(chat);
        return (
          <NavLink
            key={chat.id}
            to={sideChatHref(chat.id)}
            data-slot="side-chat-row"
            data-unread={unread || undefined}
            onClick={() => onNavigate?.()}
            className="flex h-7 min-w-0 shrink-0 items-center gap-2.5 rounded-sm px-2 text-xs text-muted-foreground transition-colors hover:bg-sel hover:text-foreground pointer-coarse:h-9 [&.active]:bg-sel [&.active]:text-foreground"
          >
            <ThreadStateMark dot={chat.working ? "working" : "idle"} />
            <span className={cn("min-w-0 truncate", unread && "font-semibold text-foreground")}>{chat.title}</span>
            {unread && <span className="sr-only">New</span>}
          </NavLink>
        );
      })}
    </div>
  );
}
