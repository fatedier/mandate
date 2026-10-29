import { Link } from "react-router";
import { Sparkles } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { collapsedLinkClass, expandedLinkClass } from "@/shell/NavItemRow";
import { useGlobalAgentStore } from "@/store/global-agent";
import { useVoiceStore } from "@/store/voice";
import { globalAgentLabel } from "@/lib/global-agent-label";
import { cn } from "@/lib/utils";

/** The global agent's row, pinned above New thread:
 *  its name, or "Your agent" with New until named; the needs-you dot while a
 *  question it asked the user is unanswered; a dot while an answer or
 *  something it handed off came back unseen. One row for the sidebar and the
 *  phone's drawer. */
export function GlobalAgentRow({ collapsed = false, current, onNavigate }: {
  collapsed?: boolean;
  current: boolean;
  /** Fires on navigation; the phone's drawer closes itself with it. */
  onNavigate?: () => void;
}) {
  const agent = useGlobalAgentStore((s) => s.agent);
  const named = agent?.named ?? false;
  const label = globalAgentLabel(agent);
  // Voice live here outranks the unread dot, which returns when voice stops.
  const voiceLive = useVoiceStore((s) => s.voiceMode && s.connectionState !== "moved");
  // A question it asked waits on the user: the yellow a thread's mark takes when its manager asked.
  const asking = (agent?.questions.length ?? 0) > 0 && !voiceLive;
  const unread = named && (agent?.unread ?? false) && !voiceLive && !asking;
  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Link
            to="/agent"
            data-slot="global-agent"
            aria-label={label}
            aria-current={current ? "page" : undefined}
            onClick={onNavigate}
            className={cn(collapsedLinkClass, current && "active")}
          >
            <Sparkles className="h-4 w-4 text-status-review" />
            {voiceLive && (
              <span data-slot="global-agent-voice" role="img" aria-label="Voice on" className="absolute top-1.5 right-1.5 size-2 rounded-full bg-live" />
            )}
            {asking && (
              <span data-slot="global-agent-question" role="img" aria-label="Needs your answer" className="absolute top-1.5 right-1.5 size-2 rounded-full bg-status-input" />
            )}
            {unread && (
              <span data-slot="global-agent-unread" role="img" aria-label="New reply" className="absolute top-1.5 right-1.5 size-2 rounded-full bg-status-review" />
            )}
          </Link>
        </TooltipTrigger>
        <TooltipContent side="right">{label}</TooltipContent>
      </Tooltip>
    );
  }
  return (
    <Link
      to="/agent"
      data-slot="global-agent"
      aria-current={current ? "page" : undefined}
      onClick={onNavigate}
      className={cn(expandedLinkClass, "font-semibold text-foreground", current && "active")}
    >
      <Sparkles className="size-4 shrink-0 text-status-review" />
      <span className="min-w-0 truncate">{label}</span>
      {voiceLive ? (
        <span data-slot="global-agent-voice" role="img" aria-label="Voice on" className="ml-auto size-1.5 shrink-0 rounded-full bg-live" />
      ) : asking ? (
        <span data-slot="global-agent-question" role="img" aria-label="Needs your answer" className="ml-auto size-1.5 shrink-0 rounded-full bg-status-input" />
      ) : !named ? (
        <span data-slot="global-agent-new" className="ml-auto shrink-0 rounded-full bg-status-review/10 px-1.5 text-2xs font-semibold text-status-review">New</span>
      ) : unread ? (
        <span data-slot="global-agent-unread" role="img" aria-label="New reply" className="ml-auto size-1.5 shrink-0 rounded-full bg-status-review" />
      ) : null}
    </Link>
  );
}
