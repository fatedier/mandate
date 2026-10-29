import { PanelRightOpen, Star } from "lucide-react";
import { Link } from "react-router";
import type { WorkItemDto } from "@shared/api/work-items";
import type { Feature } from "@/store/projects";
import { useProjectsStore } from "@/store/projects";
import { useAgentChatStore } from "@/store/agent-chat";
import { useFeatureWakeActive } from "@/store/wake-activity";
import { HoverSwap } from "@/components/HoverSwap";
import { PaneDot } from "@/components/PaneDot";
import { QuestionCallout } from "@/components/QuestionCallout";
import { useWorkerQuestionTone } from "@/hooks/useWorkerQuestionTone";
import { RelativeTime } from "@/components/RelativeTime";
import { featureStatePill, PILL_DOT_CLASS, type PillTone } from "@/lib/feature-status";
import { usePaneNames } from "@/lib/pane-names";
import { useFeaturePlan } from "@/store/feature-plans";
import { featureStateLine, planProgress } from "@shared/feature-state";
import { cn } from "@/lib/utils";
import { useIsMobile } from "@/hooks/useIsMobile";
import type { PaneDisplayStatus } from "./feature-card-data";
import { featureHref } from "@/lib/feature-href";

export type FeatureRowVariant = "top" | "passive" | "untracked";

/** The state's colour on line two: its dot, and the lead word before the text. */
const TONE: Record<PillTone, { dot: string; text: string }> = {
  red: { dot: PILL_DOT_CLASS.red, text: "text-red" },
  blue: { dot: PILL_DOT_CLASS.blue, text: "text-phase-working" },
  amber: { dot: PILL_DOT_CLASS.amber, text: "text-amber" },
  green: { dot: PILL_DOT_CLASS.green, text: "text-phase-done" },
  cyan: { dot: PILL_DOT_CLASS.cyan, text: "text-muted-foreground" },
  violet: { dot: PILL_DOT_CLASS.violet, text: "text-muted-foreground" },
  neutral: { dot: PILL_DOT_CLASS.neutral, text: "text-muted-foreground" }
};

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
// For any pointer (a narrow window with a mouse renders this row too), so not
// the touch-only `hit` utility.
const TOUCH_HIT = "relative before:absolute before:content-['']";
// The Ack is a 22px neutral pill (same shape as the Review pill beside it,
// `--sel` fill, foreground text) so it reads as a quiet action, not a block.
const TOUCH_ACK = `${TOUCH_HIT} pill pill-neutral text-foreground before:-inset-[11px]`;
const TOUCH_ICON = `${TOUCH_HIT} h-9 w-9 before:-inset-1`;

/** One row in a project's feature list. Three variants share one shape:
 *  `top` (pinned or asking for the user) reads Needs you on its state line
 *  and adds Ack and the inline reply to the plan's open question; `passive` is the steady state; `untracked` has no
 *  work item and shows the tmux window name. The row is 52px unless a
 *  question callout opens under it, or, on phones, the row wants the user and
 *  carries its 44px action row. A frame is no longer how this page says
 *  "wants you" — the state line and the sidebar dot are — so every variant sits on
 *  the same hairline-separated surface. */
export function FeatureRow(props: FeatureRowProps) {
  const href = featureHref(props.projectSlug, props.feature.tmuxWindowName);
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
      <span data-slot="feature-title" className="min-w-0 flex-1 truncate text-xs">{feature.name}</span>
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
  // Live signal = worker wake running ∪ pane working: motion on the dot.
  const wakeActive = useFeatureWakeActive(feature.id);
  const active = wakeActive || paneStatus === "running";
  const showSlug = !!item.title && item.title !== feature.name;
  const plan = useFeaturePlan(feature.id);
  const paneNames = usePaneNames();
  const pill = featureStatePill(plan, item.failedAt ?? null, item.failedKind ?? null, wakeActive);
  // A worker that waits for an answer shows its question in the reply box
  // below; line two then carries the conclusion rather than the same
  // question again.
  const asked = isTop && pill.state === "asking" ? plan?.openQuestions[0] : undefined;
  const stateLine = featureStateLine(plan, { at: item.failedAt ?? null, message: item.failedMessage ?? null, kind: item.failedKind ?? null }, wakeActive);
  const questionTone = useWorkerQuestionTone(feature.id);
  // The state word already leads the line, so a lead that only says it again
  // ("Failed" then "Failed:") goes; "Now:" and "Next:" add something and stay.
  const restated = stateLine.lead?.replace(/:$/, "") === pill.label;
  const line = asked
    ? { ...stateLine, lead: null, text: plan?.conclusion?.trim() || "" }
    : restated ? { ...stateLine, lead: null } : stateLine;
  const { done, total } = planProgress(plan);
  const tone = TONE[pill.tone];

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
      {/* Pinned is not a status: filled in the foreground colour, never a
          status colour. */}
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
      aria-label="Open worker"
      title="Open worker"
    >
      <PanelRightOpen className="size-3.5 text-muted-foreground" />
    </button>
  ) : null;
  // Ack gets the same touch/pointer sizes as Chat and pin. Which one renders
  // is decided by the viewport: the hover slot is display:none below md, so a
  // phone gets the action row instead and never a hidden pointer twin.
  // Something to acknowledge: a question that needs no answer any more.
  const acks = asked !== undefined;
  const ackButton = (size: "touch" | "pointer") => acks ? (
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
          </span>
          {/* Line two reads the plan: the state (a dot, pulsing only while
              work really runs, and its word), progress, then what matters for
              that state. The text is what gives way; the rest does not shrink. */}
          <span data-slot="feature-state-line" className="mt-0.5 flex min-w-0 items-center gap-1.5 overflow-hidden text-2xs text-muted-foreground">
            <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", tone.dot, active && "animate-live")} />
            <span data-slot="feature-state" className={cn("shrink-0 font-medium", tone.text)}>{pill.label}</span>
            {total > 0 && <span data-slot="feature-progress" className="num shrink-0 text-faint">{done}/{total}</span>}
            {line.text && (
              <span className="flex min-w-0 gap-1">
                {line.lead && <span className={cn("shrink-0", tone.text)}>{line.lead}</span>}
                <span data-slot="feature-state-text" className="min-w-0 truncate" title={line.text}>{line.text}</span>
                {line.pane && <span className="shrink-0 text-faint">· {paneNames.get(line.pane) ?? line.pane}</span>}
              </span>
            )}
          </span>
        </span>
        {/* The right column mirrors the two lines on the left: the needs pill
            and the time (or, hovered, the actions) above, the slug below,
            right-aligned. The slug is the row's stable identity — titles
            change — so it stays visible at rest, in its own column where it
            neither competes with the title nor squeezes the summary. Phones
            drop it: the feature page carries it there. */}
        {/* The swap wraps the whole column, not just the time: the 28px
            action buttons are laid out invisibly at rest, and stacked above
            the slug they pushed the row from 52px to 58. As one cell the
            resting stack (time line + slug line) is the taller of the two, so
            the row keeps its height and the actions sit centred on hover. */}
        <HoverSwap
          rest={
            <span data-slot="feature-right" className="flex shrink-0 flex-col items-end gap-0.5">
              {/* The title's line height, so the time sits on the title's
                  line and the column is as tall as the two lines beside it
                  (a 22px line, once a pill's, made it 4px taller). */}
              <span data-slot="feature-time-line" className="flex h-[calc(var(--text-xs)*var(--text-xs--line-height))] items-center gap-3">
                <span className="num shrink-0 text-2xs text-faint"><RelativeTime value={item.lastActivityAt} /></span>
              </span>
              {/* Without a slug an empty line of the same height holds its
                  place, so the time stays on the title line like every other
                  row's instead of centring between the two. */}
              {showSlug && !isPhone ? (
                <span data-slot="feature-slug" className="max-w-[18rem] truncate font-mono text-2xs text-faint" title={feature.name}>
                  {feature.tmuxWindowName}
                </span>
              ) : (
                <span aria-hidden="true" className="font-mono text-2xs">{"\u00a0"}</span>
              )}
            </span>
          }
          hover={isPhone ? null : (
            <>
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
          buttons at all. 16px apart on a touch screen: the Ack's area reaches
          11px past it and an icon's 4px, and touch areas must not overlap. */}
      {isPhone && acks && (
        <div data-slot="feature-actions-touch" className="flex items-center gap-2 pointer-coarse:gap-4">
          {ackButton("touch")}
          {chatButton("touch")}
          <span className="flex-1" />
          {pinButton("touch")}
        </div>
      )}
      {asked && <QuestionCallout question={asked} onSend={handleReply} tone={questionTone} />}
    </Link>
  );
}
