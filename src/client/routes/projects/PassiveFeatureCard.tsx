import { Link } from "react-router";
import { MessageSquare, Star } from "lucide-react";
import { useProjectsStore, type Feature } from "@/store/projects";
import type { WorkItemDto } from "@shared/api/work-items";
import type { PaneDisplayStatus } from "./feature-card-data";
import { PhaseDot } from "@/components/PhaseDot";
import { SlugChip } from "@/components/SlugChip";
import { StatusRail } from "@/components/StatusRail";
import { HoverSwap } from "@/components/HoverSwap";
import { useFeatureWakeActive } from "@/store/wake-activity";
import { cn } from "@/lib/utils";
import { RelativeTime } from "@/components/RelativeTime";

interface Props {
  projectSlug: string;
  feature: Feature;
  item: WorkItemDto;
  paneStatus: PaneDisplayStatus;
  onTogglePin: () => void;
  onPromote?: () => void;
}

export function PassiveFeatureCard({ projectSlug, feature, item, paneStatus, onTogglePin, onPromote }: Props) {
  const isPinned = !!feature.pinnedAt;
  const pinning = useProjectsStore((s) => s.pinningFeatureIds.has(feature.id));
  // Live signal = worker wake running ∪ pane working. Wakes cover the
  // agent's own thinking / server-side tools, which never touch tmux panes.
  const wakeActive = useFeatureWakeActive(feature.id);
  const active = wakeActive || paneStatus === "running";
  const stop = (e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation(); };

  return (
    <Link
      to={`/projects/${encodeURIComponent(projectSlug)}/features/${encodeURIComponent(feature.tmuxWindowName)}`}
      // No frame. A card frame is how this page says "this one wants you"; the
      // steady-state features were wearing the same frame as the ones that do,
      // so a section with six items read as six equal demands. These are rows
      // now — they keep the status rail and gain a hover surface, and the framed
      // cards above them get their meaning back.
      className="group relative block overflow-hidden rounded-lg py-2.5 pl-4 pr-3 transition-colors hover:bg-foreground/[0.04]"
    >
      <StatusRail tone="neutral" />
      <div className="flex min-w-0 items-center justify-between gap-2">
        {/* The title owns row one — nothing competes with it for width. */}
        <span className="min-w-0 flex-1 truncate text-sm font-semibold" title={item.title || feature.name}>
          {item.title || feature.name}
        </span>
        <HoverSwap
          rest={
            <>
              <span className="num font-mono text-2xs text-faint">
                <RelativeTime value={item.lastActivityAt} />
              </span>
              {/* Touch has no hover, so HoverSwap's action slot is `display:none`
                  here (it is `hidden md:flex`) — this cluster is the entire
                  mobile action set for the row. Chat used to live only in that
                  slot, which left a phone with pin as the only thing it could do
                  to a steady-state feature.

                  Inline rather than a bordered action row like TopFeatureCard's:
                  a frame is how this page says "this one wants you", and these
                  rows are deliberately frameless (see the Link's comment below).
                  Same `onPromote` as the pointer affordance, so both breakpoints
                  land on the overview thread with a ref pill — the destination
                  is the card's, not the feature's own thread.

                  h-11 (44px) is the mobile touch target ChangesTab already sets;
                  the pin beside it moves up from h-7 to match, since two adjacent
                  icon buttons at different sizes read as a mistake and 28px was
                  under the bar anyway. The icons stay h-4 so the row's visual
                  weight does not change with the target. */}
              {onPromote && (
                <button
                  onClick={(e) => { stop(e); onPromote(); }}
                  className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-sm transition-colors hover:bg-accent md:hidden"
                  aria-label="Chat about this feature"
                >
                  <MessageSquare className="h-4 w-4 text-muted-foreground" />
                </button>
              )}
              <button
                onClick={(e) => { stop(e); if (!pinning) onTogglePin(); }}
                aria-disabled={pinning}
                className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-sm transition-colors hover:bg-accent aria-disabled:cursor-wait aria-disabled:opacity-50 md:hidden"
                aria-label={isPinned ? "Unpin" : "Pin to top"}
              >
                <Star className={cn("h-4 w-4", isPinned ? "fill-status-review text-status-review" : "text-muted-foreground")} />
              </button>
            </>
          }
          hover={
            <>
              {onPromote && (
                <button
                  onClick={(e) => { stop(e); onPromote(); }}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-sm transition-colors hover:bg-accent"
                  aria-label="Chat about this feature"
                  title="Chat about this feature"
                >
                  <MessageSquare className="h-4 w-4 text-muted-foreground" />
                </button>
              )}
              <button
                onClick={(e) => { stop(e); if (!pinning) onTogglePin(); }}
                aria-disabled={pinning}
                className="inline-flex h-7 w-7 items-center justify-center rounded-sm transition-colors hover:bg-accent aria-disabled:cursor-wait aria-disabled:opacity-50"
                aria-label={isPinned ? "Unpin" : "Pin to top"}
              >
                <Star className={cn("h-4 w-4", isPinned ? "fill-status-review text-status-review" : "text-muted-foreground")} />
              </button>
            </>
          }
        />
      </div>
      {/* Status line: phase (dot breathes while panes actually run) plus the
          feature slug as right-aligned metadata. */}
      <div className="mt-2 flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1">
          <PhaseDot phase={item.phase} active={active} />
        </span>
        {item.title && item.title !== feature.name && (
          <SlugChip title={feature.name} className="min-w-0 max-w-[10rem] truncate">
            {feature.tmuxWindowName}
          </SlugChip>
        )}
      </div>
      {/* The agent's declared "what I'm doing now" gets its own full-width
          line — squeezed into the status line it truncated after a few
          words. Prose, so sans (mono is reserved for machine identifiers). */}
      {item.phaseDetail && (
        <div className="mt-1 truncate text-sm text-foreground/80" title={item.phaseDetail}>
          {item.phaseDetail}
        </div>
      )}
    </Link>
  );
}
