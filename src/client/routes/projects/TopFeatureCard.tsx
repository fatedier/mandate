import { Link } from "react-router";
import { FileText, Star } from "lucide-react";
import { useProjectsStore, type Feature } from "@/store/projects";
import type { WorkItemDto } from "@shared/api/work-items";
import type { PaneDisplayStatus } from "./feature-card-data";
import { PhaseDot } from "@/components/PhaseDot";
import { SlugChip } from "@/components/SlugChip";
import { StatusRail, type StatusRailTone } from "@/components/StatusRail";
import { QuestionCallout } from "@/components/QuestionCallout";
import { HoverSwap } from "@/components/HoverSwap";
import { useAgentChatStore } from "@/store/agent-chat";
import { useFeatureWakeActive } from "@/store/wake-activity";
import { cn } from "@/lib/utils";
import { RelativeTime } from "@/components/RelativeTime";
import { dedupeSummaryAgainstPhaseDetail } from "@/lib/work-item-summary";

interface Props {
  projectSlug: string;
  feature: Feature;
  item: WorkItemDto;
  paneStatus: PaneDisplayStatus;
  onTogglePin: () => void;
  onAck: () => void;
  onPromote: () => void;
}

const NEEDS_BADGE: Record<"input" | "review", string> = {
  input: "bg-status-input/12 text-status-input border-status-input/25",
  review: "bg-status-review/10 text-status-review border-status-review/25"
};

const NEEDS_LABEL: Record<"input" | "review", string> = {
  input: "blocked · input",
  review: "review"
};

export function TopFeatureCard({
  projectSlug, feature, item, paneStatus,
  onTogglePin, onAck, onPromote
}: Props) {
  const isPinned = !!feature.pinnedAt;
  const pinning = useProjectsStore((s) => s.pinningFeatureIds.has(feature.id));
  const sendMessage = useAgentChatStore((s) => s.sendMessage);
  // Live signal = worker wake running ∪ pane working. Wakes cover the
  // agent's own thinking / server-side tools, which never touch tmux panes.
  const wakeActive = useFeatureWakeActive(feature.id);
  const needs = item.needsUser;
  const tone: StatusRailTone = needs === "input" ? "input" : needs === "review" ? "review" : "neutral";

  // Strip basic markdown and collapse to a single inline line; full body
  // lives on the feature page. The phase row directly above already prints
  // phaseDetail, so summary lines that repeat it verbatim are dropped first —
  // otherwise the card says the same sentence twice, one line apart.
  const summaryText = dedupeSummaryAgainstPhaseDetail(item.summary, item.phaseDetail);
  const bodyPreview = summaryText
    ? summaryText
        .split("\n")
        .map((line) => line.replace(/^\s*[#*\->]+\s*/, "").trim())
        .filter((line) => line.length > 0)
        .join(" · ")
        .replace(/`/g, "")
        .replace(/\*\*/g, "")
    : null;

  const stop = (e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation(); };
  const handleReply = async (text: string) => {
    const outcome = await sendMessage({ type: "worker", featureId: feature.id }, text);
    // sendMessage never rejects; rethrow so QuestionCallout shows its error state.
    if (outcome === "failed") throw new Error("send failed");
  };

  return (
    <Link
      to={`/projects/${encodeURIComponent(projectSlug)}/features/${encodeURIComponent(feature.tmuxWindowName)}`}
      className="group relative block overflow-hidden rounded-lg border border-border bg-card p-4 pl-4.5 shadow-card transition hover:border-input hover:bg-accent/20 hover:shadow-card-hover"
    >
      <StatusRail tone={tone} />

      {/* Top row: badge · pin · title · slug/canvas · pane dot + time (or hover actions) */}
      {/* items-start below md: the title is allowed two lines there, and a
          centred badge/star against a wrapped title looks dropped. */}
      <div className="mb-2 flex min-w-0 items-start justify-between gap-2 md:items-center">
        <div className="flex min-w-0 items-start gap-2 md:items-center">
          {needs !== null && (
            <span className={cn("shrink-0 rounded-full border px-2 py-0.5 label-micro", NEEDS_BADGE[needs])}>
              {NEEDS_LABEL[needs]}
            </span>
          )}
          <button
            onClick={(e) => { stop(e); if (!pinning) onTogglePin(); }}
            aria-disabled={pinning}
            className={cn(
              "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-sm transition hover:bg-accent aria-disabled:cursor-wait aria-disabled:opacity-50",
              isPinned ? "opacity-100" : "opacity-100 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100"
            )}
            aria-label={isPinned ? "Unpin" : "Pin to top"}
          >
            <Star className={cn("h-4 w-4", isPinned ? "fill-status-review text-status-review" : "text-muted-foreground")} />
          </button>
          {/* Wraps on narrow screens rather than truncating. At 390px the badge,
              pin, canvas marker and timestamp left the title ~130px, so the one
              thing the card exists to tell you was the first thing cut. */}
          <span
            className="min-w-0 line-clamp-2 text-base font-semibold md:truncate"
            title={item.title || feature.name}
          >
            {item.title || feature.name}
          </span>
          {item.canvasId && (
            <span
              className="flex shrink-0 items-center text-phase-design"
              aria-label="Feature has canvas"
              title="Feature has canvas"
            >
              <FileText className="h-3.5 w-3.5" aria-hidden />
            </span>
          )}
        </div>
        {/* Live pane activity reads off the PhaseDot's breathing below —
            one carrier per signal pair (phase color + activity motion). */}
        <HoverSwap
          rest={
            <span className="num font-mono text-2xs text-faint">
              <RelativeTime value={item.lastActivityAt} />
            </span>
          }
          hover={
            <>
              {needs !== null && (
                <button
                  onClick={(e) => { stop(e); onAck(); }}
                  className="inline-flex h-7 items-center rounded-md border border-border px-2.5 text-xs font-medium transition-colors hover:bg-accent"
                >
                  Ack
                </button>
              )}
              <button
                onClick={(e) => { stop(e); onPromote(); }}
                className="inline-flex h-7 items-center rounded-md border border-primary/25 px-2.5 text-xs font-medium text-primary-soft transition-colors hover:bg-primary/10"
              >
                Chat
              </button>
            </>
          }
        />
      </div>

      {/* The agent's blocking question is a first-class callout with inline reply. */}
      {needs === "input" && item.phaseDetail && (
        <QuestionCallout question={item.phaseDetail} onSend={handleReply} />
      )}

      {/* Phase row (detail suppressed when the callout already shows it);
          the feature slug sits here as right-aligned metadata so the title
          row never gets squeezed. */}
      <div className="mt-2 flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1">
          <PhaseDot
            phase={item.phase}
            active={wakeActive || paneStatus === "running"}
            detail={needs === "input" ? undefined : item.phaseDetail ?? undefined}
          />
        </span>
        {item.title && item.title !== feature.name && (
          <SlugChip title={feature.name} className="min-w-0 max-w-[10rem] truncate">
            {feature.tmuxWindowName}
          </SlugChip>
        )}
      </div>

      {bodyPreview && (
        <div className="mt-1 truncate text-sm text-foreground/85" title={bodyPreview}>
          {bodyPreview}
        </div>
      )}

      {/* Mobile action row (hover doesn't exist on touch). */}
      <div className="mt-3 flex items-center gap-2 border-t border-border-soft pt-3 md:hidden">
        {needs !== null && (
          <button onClick={(e) => { stop(e); onAck(); }} className="inline-flex h-8 items-center rounded-md border border-border px-3 text-xs font-medium transition-colors hover:bg-accent">
            Ack
          </button>
        )}
        <button onClick={(e) => { stop(e); onPromote(); }} className="inline-flex h-8 items-center rounded-md border border-primary/25 px-3 text-xs font-medium text-primary-soft transition-colors hover:bg-primary/10">
          Chat
        </button>
      </div>
    </Link>
  );
}
