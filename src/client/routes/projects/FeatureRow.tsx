import { FileText, MessageSquare, Star } from "lucide-react";
import { Link } from "react-router";
import type { WorkItemDto } from "@shared/api/work-items";
import type { Feature } from "@/store/projects";
import { useProjectsStore } from "@/store/projects";
import { useAgentChatStore } from "@/store/agent-chat";
import { useFeatureWakeActive } from "@/store/wake-activity";
import { HoverSwap } from "@/components/HoverSwap";
import { PaneDot } from "@/components/PaneDot";
import { PhaseDot } from "@/components/PhaseDot";
import { QuestionCallout } from "@/components/QuestionCallout";
import { RelativeTime } from "@/components/RelativeTime";
import { dedupeSummaryAgainstPhaseDetail } from "@/lib/work-item-summary";
import { cn } from "@/lib/utils";
import { useIsMobile } from "@/hooks/useIsMobile";
import type { PaneDisplayStatus } from "./feature-card-data";

export type FeatureRowVariant = "top" | "passive" | "untracked";

export interface FeatureRowProps {
  variant: FeatureRowVariant;
  projectSlug: string;
  feature: Feature;
  /** null only for `untracked` */
  item: WorkItemDto | null;
  paneStatus: PaneDisplayStatus;
  onTogglePin?: () => void;
  onAck?: () => void;
  onPromote?: () => void;
}

const noop = () => {};

// Phone action row: the buttons LOOK small (a 32px outlined Ack, 36px icon
// buttons — a 44px bordered Ack read as a block beside two bare icons) but
// keep a 44px hit target through an invisible pseudo-element that grows the
// box by 6px / 4px on every side. `relative` scopes the inset to the button.
const TOUCH_HIT = "relative before:absolute before:content-['']";
// The Ack is a 22px neutral pill (same shape as the Review pill beside it,
// `--sel` fill, foreground text) so it reads as a quiet action, not a block.
const TOUCH_ACK = `${TOUCH_HIT} pill pill-neutral text-foreground before:-inset-[11px]`;
const TOUCH_ICON = `${TOUCH_HIT} h-9 w-9 before:-inset-1`;

/** One row in a project's feature list. Three variants share one shape:
 *  `top` (pinned or asking for the user) adds the needs pill, Ack and the
 *  inline question reply; `passive` is the steady state; `untracked` has no
 *  work item and shows the tmux window name. The row is 52px unless a
 *  question callout opens under it, or, on phones, the row wants the user and
 *  carries its 44px action row. A frame is no longer how this page says
 *  "wants you" — the pill and the sidebar dot are — so every variant sits on
 *  the same hairline-separated surface. */
export function FeatureRow(props: FeatureRowProps) {
  const href = `/projects/${encodeURIComponent(props.projectSlug)}/features/${encodeURIComponent(props.feature.tmuxWindowName)}`;
  if (props.variant === "untracked" || !props.item) {
    return <UntrackedRow href={href} feature={props.feature} paneStatus={props.paneStatus} />;
  }
  return <TrackedRow {...props} item={props.item} href={href} />;
}

function UntrackedRow({ href, feature, paneStatus }: { href: string; feature: Feature; paneStatus: PaneDisplayStatus }) {
  return (
    <Link
      to={href}
      data-slot="feature-row"
      data-variant="untracked"
      className="group flex min-h-13 items-center gap-3 px-3.5 py-2 text-muted-foreground transition-colors hover:bg-sel"
    >
      <span data-slot="feature-title" className="min-w-0 flex-1 truncate font-mono text-xs">{feature.name}</span>
      <span className="shrink-0 label-micro text-faint">untracked</span>
      <PaneDot status={paneStatus} />
    </Link>
  );
}

function TrackedRow({
  variant, projectSlug: _projectSlug, feature, item, paneStatus, href,
  onTogglePin = noop, onAck = noop, onPromote
}: FeatureRowProps & { item: WorkItemDto; href: string }) {
  const isTop = variant === "top";
  const isPhone = useIsMobile();
  const isPinned = !!feature.pinnedAt;
  const pinning = useProjectsStore((s) => s.pinningFeatureIds.has(feature.id));
  const sendMessage = useAgentChatStore((s) => s.sendMessage);
  // Live signal = worker wake running ∪ pane working (§3.1): motion on the dot.
  const wakeActive = useFeatureWakeActive(feature.id);
  const active = wakeActive || paneStatus === "running";
  const needs = isTop ? item.needsUser : null;
  const showSlug = !!item.title && item.title !== feature.name;

  // Line two: the phase, then the declared "what I'm doing" (phaseDetail) and,
  // on top rows, the summary after it. Summary lines that repeat phaseDetail
  // are dropped first; basic markdown markers are stripped to a single line.
  // When the row asks a question, phaseDetail is the question and the callout
  // below already prints it, so line two carries only the summary.
  const summaryText = dedupeSummaryAgainstPhaseDetail(item.summary, item.phaseDetail);
  const bodyPreview = isTop && summaryText
    ? summaryText.split("\n").map((line) => line.replace(/^\s*[#*\->]+\s*/, "").trim())
        .filter((line) => line.length > 0).join(" · ").replace(/`/g, "").replace(/\*\*/g, "")
    : null;
  const phaseDetail = needs === "input" ? null : item.phaseDetail;
  const detail = [phaseDetail, bodyPreview].filter((part): part is string => !!part).join(" · ");

  const stop = (e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation(); };
  const handleReply = async (text: string) => {
    const outcome = await sendMessage({ type: "worker", featureId: feature.id }, text);
    // sendMessage never rejects; rethrow so QuestionCallout shows its error state.
    if (outcome === "failed") throw new Error("send failed");
  };

  const pinButton = (size: "touch" | "pointer") => (
    <button
      onClick={(e) => { stop(e); if (!pinning) onTogglePin(); }}
      aria-disabled={pinning}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-sm transition-colors hover:bg-sel aria-disabled:cursor-wait aria-disabled:opacity-50",
        size === "touch" ? TOUCH_ICON : "h-7 w-7"
      )}
      aria-label={isPinned ? "Unpin" : "Pin to top"}
    >
      {/* Pinned is not a status: filled in the foreground colour, never the
          review amber it used to share with the Review pill beside it. */}
      <Star className={cn("size-3.5", isPinned ? "fill-foreground text-foreground" : "text-muted-foreground")} />
    </button>
  );
  const chatButton = (size: "touch" | "pointer") => onPromote ? (
    <button
      onClick={(e) => { stop(e); onPromote(); }}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-sm transition-colors hover:bg-sel",
        size === "touch" ? TOUCH_ICON : "h-7 w-7"
      )}
      aria-label="Chat about this feature"
      title="Chat about this feature"
    >
      <MessageSquare className="size-3.5 text-muted-foreground" />
    </button>
  ) : null;
  // Ack gets the same touch/pointer sizes as Chat and pin. Which one renders
  // is decided by the viewport: the hover slot is display:none below md, so a
  // phone gets the action row instead and never a hidden pointer twin.
  const needsPill = needs !== null ? (
    <span data-slot="feature-needs" className={cn("pill", needs === "input" ? "pill-red" : "pill-review")}>
      {needs === "input" ? "Needs input" : "Review"}
    </span>
  ) : null;
  const ackButton = (size: "touch" | "pointer") => needs !== null ? (
    <button
      onClick={(e) => { stop(e); onAck(); }}
      className={cn(
        "shrink-0 transition-colors",
        size === "touch"
          ? TOUCH_ACK
          // Same 22px neutral pill as the phone's: a 28px bordered button was
          // the largest thing in a cluster of 22px pills and bare icons.
          : "pill pill-neutral text-foreground hover:bg-border"
      )}
    >
      Ack
    </button>
  ) : null;

  return (
    <Link
      to={href}
      data-slot="feature-row"
      data-variant={variant}
      className="group flex min-h-13 flex-col justify-center gap-2 px-3.5 py-1.5 transition-colors hover:bg-sel"
    >
      <div className="flex min-w-0 items-center gap-3">
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2">
            <span
              data-slot="feature-title"
              className="min-w-0 truncate text-xs font-medium text-foreground"
              title={item.title || feature.name}
            >
              {item.title || feature.name}
            </span>
            {item.canvasId && (
              <span className="flex shrink-0 items-center text-faint" aria-label="Feature has canvas" title="Feature has canvas">
                <FileText className="size-3.5" aria-hidden />
              </span>
            )}
          </span>
          <span className="mt-0.5 flex min-w-0 items-center text-2xs">
            <PhaseDot phase={item.phase} active={active} detail={detail || undefined} />
          </span>
        </span>
        {/* The right column mirrors the two lines on the left: the needs pill
            and the time (or, hovered, the actions) above, the slug below,
            right-aligned. The slug is the row's stable identity — titles
            change — so it stays visible at rest, in its own column where it
            neither competes with the title nor squeezes the summary. Phones
            drop it: the feature page and the sidebar carry it there. */}
        {/* The swap wraps the whole column, not just the time: the 28px
            action buttons are laid out invisibly at rest, and stacked above
            the slug they pushed the row from 52px to 58. As one cell the
            resting stack (22px pill line + slug) is the taller of the two, so
            the row keeps its height and the actions sit centred on hover. */}
        <HoverSwap
          rest={
            <span data-slot="feature-right" className="flex shrink-0 flex-col items-end gap-0.5">
              <span className="flex h-[22px] items-center gap-3">
                {needsPill}
                <span className="num shrink-0 text-2xs text-faint"><RelativeTime value={item.lastActivityAt} /></span>
              </span>
              {showSlug && !isPhone && (
                <span data-slot="feature-slug" className="max-w-[18rem] truncate font-mono text-2xs text-faint" title={feature.name}>
                  {feature.tmuxWindowName}
                </span>
              )}
            </span>
          }
          hover={isPhone ? null : (
            <>
              {needsPill}
              {ackButton("pointer")}
              {chatButton("pointer")}
              {pinButton("pointer")}
            </>
          )}
        />
      </div>
      {/* Phones: only a row that wants the user gets an action row (Ack · Chat ·
          pin, 44px targets). Passive rows stay one line; their Chat is the feature
          page's top-bar button and their pin is in the feature actions menu. Render-
          branched on the viewport, not CSS-gated, so a passive row carries no hidden
          buttons at all. */}
      {isPhone && needs !== null && (
        <div data-slot="feature-actions-touch" className="flex items-center gap-2">
          {ackButton("touch")}
          {chatButton("touch")}
          <span className="flex-1" />
          {pinButton("touch")}
        </div>
      )}
      {needs === "input" && item.phaseDetail && (
        <QuestionCallout question={item.phaseDetail} onSend={handleReply} />
      )}
    </Link>
  );
}
