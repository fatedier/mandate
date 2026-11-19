import { useEffect } from "react";
import { Link, matchPath, useLocation } from "react-router";
import { ChevronRight, Sparkles } from "lucide-react";
import { Fold } from "@/components/Fold";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { collapsedLinkClass, expandedLinkClass } from "@/shell/NavItemRow";
import { usePersonalAgentStore } from "@/store/personal-agent";
import { useVoiceStore } from "@/store/voice";
import { personalAgentLabel } from "@/lib/personal-agent-label";
import { cn } from "@/lib/utils";
import { useSideChatsStore, isSideChatNew } from "@/store/side-chats";
import { useUIStore } from "@/store/ui";
import { SideChatNavRows } from "./SideChatNavRows";
import { ThreadStateMark } from "./ThreadStateMark";

/** The personal agent's row, pinned above New thread:
 *  its name, or "Personal agent" with New until named; the needs-you dot while a
 *  question it asked the user is unanswered; a dot while an answer or
 *  something it handed off came back unseen. One row for the sidebar and the
 *  phone's drawer. */
export function PersonalAgentRow({ collapsed = false, current, onNavigate }: {
  collapsed?: boolean;
  current: boolean;
  /** Fires on navigation; the phone's drawer closes itself with it. */
  onNavigate?: () => void;
}) {
  const agent = usePersonalAgentStore((s) => s.agent);
  const named = agent?.named ?? false;
  const label = personalAgentLabel(agent);
  // Voice live here outranks the unread dot, which returns when voice stops.
  const voiceLive = useVoiceStore((s) => s.voiceMode && s.connectionState !== "moved");
  // A question it asked waits on the user: the yellow a thread's mark takes when its manager asked.
  const asking = (agent?.questions.length ?? 0) > 0 && !voiceLive;
  // The review held its calls back again and again: the same yellow, a thread's held mark.
  const held = Boolean(agent?.heldBack) && !voiceLive && !asking;
  const unread = named && (agent?.unread ?? false) && !voiceLive && !asking && !held;
  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Link
            to="/agent"
            data-slot="personal-agent"
            aria-label={label}
            aria-current={current ? "page" : undefined}
            onClick={onNavigate}
            className={cn(collapsedLinkClass, current && "active")}
          >
            <Sparkles className="h-4 w-4 text-status-review" />
            {voiceLive && (
              <span data-slot="personal-agent-voice" role="img" aria-label="Voice on" className="absolute top-1.5 right-1.5 size-2 rounded-full bg-live" />
            )}
            {asking && (
              <span data-slot="personal-agent-question" role="img" aria-label="Needs your answer" className="absolute top-1.5 right-1.5 size-2 rounded-full bg-status-input" />
            )}
            {held && (
              <span data-slot="personal-agent-held" role="img" aria-label="Needs you" className="absolute top-1.5 right-1.5 size-2 rounded-full bg-status-input" />
            )}
            {unread && (
              <span data-slot="personal-agent-unread" role="img" aria-label="New reply" className="absolute top-1.5 right-1.5 size-2 rounded-full bg-status-review" />
            )}
          </Link>
        </TooltipTrigger>
        <TooltipContent side="right">{label}</TooltipContent>
      </Tooltip>
    );
  }
  const link = (
    <Link
      to="/agent"
      data-slot="personal-agent"
      aria-current={current ? "page" : undefined}
      onClick={onNavigate}
      className={cn(expandedLinkClass, "font-semibold text-foreground", current && "active")}
    >
      <Sparkles className="size-4 shrink-0 text-status-review" />
      <span className="min-w-0 truncate">{label}</span>
      {voiceLive ? (
        <span data-slot="personal-agent-voice" role="img" aria-label="Voice on" className="ml-auto size-1.5 shrink-0 rounded-full bg-live" />
      ) : asking ? (
        <span data-slot="personal-agent-question" role="img" aria-label="Needs your answer" className="ml-auto size-1.5 shrink-0 rounded-full bg-status-input" />
      ) : held ? (
        <span data-slot="personal-agent-held" role="img" aria-label="Needs you" className="ml-auto size-1.5 shrink-0 rounded-full bg-status-input" />
      ) : !named ? (
        <span data-slot="personal-agent-new" className="ml-auto shrink-0 rounded-full bg-status-review/10 px-1.5 text-2xs font-semibold text-status-review">New</span>
      ) : unread ? (
        <span data-slot="personal-agent-unread" role="img" aria-label="New reply" className="ml-auto size-1.5 shrink-0 rounded-full bg-status-review" />
      ) : null}
    </Link>
  );
  return <WithSideChats link={link} onNavigate={onNavigate} />;
}

/** The side chat a page shows, the last that unfolded the group by being
 *  opened: opened again, or another tab of it, it leaves the user's fold be. */
let unfoldedFor: string | null = null;

/** The agent's row with its side chats under it, once it has one: folded by
 *  default, a toggle at the row's end saying how many, and while folded
 *  whether one works (the working mark) or else has something new (the
 *  agent's own new dot). Opening a side chat's page unfolds them. */
function WithSideChats({ link, onNavigate }: { link: React.ReactNode; onNavigate?: () => void }) {
  const chats = useSideChatsStore((s) => s.sideChats) ?? [];
  const open = useUIStore((s) => s.personalSideChatsOpen);
  const setOpen = useUIStore((s) => s.setPersonalSideChatsOpen);
  const { pathname } = useLocation();
  const shownChat = matchPath("/agent/side-chats/:threadId", pathname)?.params.threadId ?? null;
  useEffect(() => {
    if (!shownChat || shownChat === unfoldedFor) return;
    unfoldedFor = shownChat;
    useUIStore.getState().setPersonalSideChatsOpen(true);
  }, [shownChat]);
  if (chats.length === 0) return link;
  const working = chats.some((c) => c.working);
  const fresh = !working && chats.some(isSideChatNew);
  return (
    <div className="flex flex-col">
      <div className="flex min-w-0 items-center">
        {/* The link keeps its own height: the box beside the toggle takes the width. */}
        <div className="min-w-0 flex-1">{link}</div>
        <button
          type="button"
          data-slot="side-chats-toggle"
          aria-expanded={open}
          aria-label={open ? "Hide side chats" : "Show side chats"}
          onClick={() => setOpen(!open)}
          className="flex h-7 shrink-0 items-center gap-1 rounded-sm px-1.5 text-2xs text-faint transition-colors hover:bg-sel hover:text-muted-foreground pointer-coarse:h-9 pointer-coarse:px-2.5"
        >
          {!open && working && <ThreadStateMark dot="working" />}
          {!open && fresh && <span role="img" aria-label="New reply" className="size-1.5 shrink-0 rounded-full bg-status-review" />}
          <span className="tabular-nums">{chats.length}</span>
          <ChevronRight aria-hidden className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")} />
        </button>
      </div>
      <Fold open={open}>
        <SideChatNavRows onNavigate={onNavigate} />
      </Fold>
    </div>
  );
}
