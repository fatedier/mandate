import { memo, useEffect, useMemo, useState } from "react";
import { Loader2, AlertCircle, RotateCw, Clock3 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { markdownToText } from "@/lib/markdown-text";
import { VoiceMarkerHeader } from "./VoiceMarkerHeader";
import type { AgentMessageAttachment } from "@shared/agent-message-types";
import type { AnsweredQuestion } from "@shared/questions";
import { imageSources } from "./attachments";
import { ImageTiles } from "./ImageTiles";
import { MentionTag } from "./MentionTag";
import { splitMentions, type Mention } from "@shared/mentions";

interface UserMessageProps {
  text: string;
  attachments?: AgentMessageAttachment[];
  status: "sending" | "queued" | "sent" | "failed" | "persisted";
  error?: string;
  onRetry?: () => void;
  /** When true, prefix the bubble with a small mic icon to mark
   *  this message came from voice (not text typing). */
  voiceMarker?: boolean;
  /** When true, treat as in-progress / ephemeral (greyed out, pulsing). */
  ephemeral?: boolean;
  /** Who passed it on for the user ("via Jarvis · Voice"), under the bubble. */
  relayLabel?: string;
  /** Who wrote it when the user did not ("Manager"), above the bubble. */
  sender?: string;
  /** Set for a message drawn folded to eight lines until opened: its mark in
   *  the list's set of opened rows, whether it is open, and the toggle. Three
   *  plain props, so the memo below still holds while a reply streams. */
  foldKey?: string;
  foldOpen?: boolean;
  onFoldChange?: (key: string, open: boolean) => void;
  /** The questions it answers, quoted above its words. */
  answers?: readonly AnsweredQuestion[];
  /** The questions whose line is in the transcript: their quotes go there. */
  jumpable?: ReadonlySet<string>;
  onJumpToQuestion?: (questionId: string) => void;
  /** What its `@<label>` words name: drawn as tags that open them. */
  mentions?: readonly Mention[];
}

/** A send that settles sooner than this shows no sending state at all, so
 *  the usual send is not a flash of spinner. */
export const SENDING_INDICATOR_DELAY_MS = 500;

/** `active`, but only once it has stayed true for `delayMs`. */
function useActiveFor(active: boolean, delayMs: number): boolean {
  const [elapsed, setElapsed] = useState(false);
  useEffect(() => {
    if (!active) return;
    const timer = setTimeout(() => setElapsed(true), delayMs);
    return () => {
      clearTimeout(timer);
      setElapsed(false);
    };
  }, [active, delayMs]);
  // `active &&` covers the render before the cleanup's reset lands.
  return active && elapsed;
}

function UserMessageImpl({ text, attachments = [], status, error, onRetry, voiceMarker, ephemeral, relayLabel, sender, foldKey, foldOpen = false, onFoldChange, answers, jumpable, onJumpToQuestion, mentions }: UserMessageProps) {
  const isFailed = status === "failed";
  const isQueued = status === "queued";
  const showSending = useActiveFor(status === "sending", SENDING_INDICATOR_DELAY_MS);
  const row = (
    // No clock in the bubble: the transcript's dividers show the time where the
    // chat paused or a day began, and the row's own is on the line under it (RowFrame).
    // The sending spinner sits in a slot beside every bubble, filled or not,
    // so a slow send changes nothing about the bubble's size.
    <div className="flex items-end justify-end gap-1.5">
      <span data-slot="sending-slot" className="mb-1 flex size-3 shrink-0 items-center justify-center text-faint">
        {showSending && <Loader2 role="status" aria-label="Sending" className="size-3 animate-spin" />}
      </span>
      <div
        data-slot="user-bubble"
        className={cn(
          "max-w-[78%] rounded-[16px_16px_4px_16px] bg-user-bubble px-3.5 py-2.5 text-foreground",
          isQueued && "border border-dashed border-border",
          ephemeral && "opacity-70",
          isFailed && "border border-red"
        )}
      >
        {answers?.map((answered) => (
          <AnswerQuote
            key={answered.id}
            question={answered.question}
            onJump={onJumpToQuestion && jumpable?.has(answered.id) ? () => onJumpToQuestion(answered.id) : undefined}
          />
        ))}
        {voiceMarker && (
          <div className="mb-0.5">
            <VoiceMarkerHeader ephemeral={ephemeral} />
          </div>
        )}
        {attachments.length > 0 && (
          <ImageTiles
            className="mb-2"
            images={attachments.map((attachment) => ({ id: attachment.id, alt: attachment.name || "Attached image", ...imageSources(attachment) }))}
          />
        )}
        {text && (
          <div data-slot="bubble-text" className={cn("text-sm leading-[1.6] whitespace-pre-wrap break-words", foldKey && !foldOpen && "line-clamp-8")}>
            {mentions && mentions.length > 0
              ? splitMentions(text, mentions).map((part, i) => typeof part === "string" ? part : <MentionTag key={i} mention={part} />)
              : text}
          </div>
        )}
        {foldKey && (
          <button
            type="button"
            data-slot="bubble-fold"
            aria-expanded={foldOpen}
            onClick={() => onFoldChange?.(foldKey, !foldOpen)}
            className="hit relative mt-1 rounded-xs text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            {foldOpen ? "Show less" : "Show more"}
          </button>
        )}
        {isQueued && (
          <div className="flex items-center gap-1 mt-1 text-2xs text-muted-foreground">
            <Clock3 className="h-3 w-3" /> queued
          </div>
        )}
        {isFailed && (
          <div className="flex items-center gap-2 mt-1 text-2xs text-red">
            <AlertCircle className="h-3 w-3" />
            <span className="truncate">{error ?? "send failed"}</span>
            {onRetry && (
              <Button variant="ghost" size="xs" className="text-red" onClick={onRetry}>
                <RotateCw /> Retry
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
  // Above the bubble, on its right edge. The column stretches its children,
  // so the row keeps the full width its bubble's 78% is measured against.
  const named = sender ? (
    <div className="flex flex-col gap-[3px]">
      <div data-slot="sender-label" className="self-end pr-0.5 text-2xs text-chrome">{sender}</div>
      {row}
    </div>
  ) : row;
  if (!relayLabel) return named;
  // Under the bubble, its right edge on the bubble's.
  return (
    <div className="flex flex-col items-end gap-0.5">
      {named}
      <div data-slot="relay-label" className="text-2xs text-faint">{relayLabel}</div>
    </div>
  );
}


/** The question an answer was given to, quoted in grey above its words as a
 *  chat app quotes what a reply answers: two lines, the rest on hover. It
 *  leads to the question's line when that line is in the transcript. */
function AnswerQuote({ question: markdown, onJump }: { question: string; onJump?: () => void }) {
  // Two lines at most: the question's words, without its Markdown.
  const question = useMemo(() => markdownToText(markdown), [markdown]);
  const frame = "mb-1.5 block w-full border-l-2 border-chrome/50 pl-2 text-left text-xs leading-[1.5] text-muted-foreground";
  // The clamp sits on the words, not the frame: a button does not take the
  // box a line clamp needs.
  const words = <span data-slot="answer-quote-text" className="line-clamp-2">{question}</span>;
  if (!onJump) return <div data-slot="answer-quote" title={question} className={frame}>{words}</div>;
  return (
    <button
      type="button"
      data-slot="answer-quote"
      title={question}
      onClick={onJump}
      // Only the right corners round (for the focus ring): rounding the left
      // ones would bend the grey bar into a bracket.
      className={cn(frame, "rounded-r-xs transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60")}
    >
      {words}
    </button>
  );
}

// Memoised: the transcript re-renders on every streaming delta, and an
// unmemoised row means all of them re-render for each token.
export const UserMessage = memo(UserMessageImpl);
