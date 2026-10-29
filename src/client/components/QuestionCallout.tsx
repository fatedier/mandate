import { useEffect, useId, useMemo, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { CircleQuestionMark } from "lucide-react";
import { cn } from "@/lib/utils";
import { markdownToText } from "@/lib/markdown-text";
import { MarkdownView } from "@/components/MarkdownView";
import { Button } from "@/components/ui/button";
import { useEnterToSend } from "@/hooks/useEnterToSend";
import type { QuestionOption } from "@shared/questions";

/** The tint every question wears, wherever it is asked: something here wants
 *  an answer. */
export const QUESTION_FRAME = "border border-status-input/40 bg-status-input/8";
/** A worker's question while it is its manager's to answer: amber, as the
 *  worker's own state reads it. */
const MANAGER_QUESTION_FRAME = "border border-amber/40 bg-amber/8";

/** A question that waits for an answer, in the one frame it has everywhere.
 *
 *  With a `heading` it is laid out in full, where there is room to answer it
 *  (above a conversation's composer): who waits, the question, the answers it
 *  suggests (the first is the recommended one), and what else can be done.
 *  Picking an answer is the caller's to send; the answers are held while
 *  `busy`. With `onSend` it has a field of its own under them: what is typed
 *  there is sent as the answer to this question, held as a pick is, and kept
 *  when it is refused (`onSend` resolves with why).
 *
 *  Without one it is a line on a worker's card: the question itself is the
 *  head, cut to fit. With `onSend` it takes a reply typed in place, sent to
 *  whoever asked without leaving the page; it swallows click and key events
 *  then, so a card that is a link does not navigate. */
export function QuestionCallout({ question, heading, options = [], onPick, busy = false, hint, error, actions, onSend, placeholder, draft, onDraftChange, tone = "user" }: {
  question: string;
  /** Whose to answer: the user's (yellow), or a worker's manager's (amber). */
  tone?: "user" | "manager";
  /** Who waits, as the head's line; the question then stands in full under it. */
  heading?: string;
  options?: readonly QuestionOption[];
  onPick?: (label: string) => void;
  busy?: boolean;
  hint?: string;
  /** Why the last pick did not go. */
  error?: string | null;
  /** What sits at the end of the head's line: paging, folding. */
  actions?: ReactNode;
  /** Sends a reply typed in place; resolves with why it did not go, if it was refused. */
  onSend?: (text: string) => Promise<string | null | void> | void;
  /** In full, the empty field's words. */
  placeholder?: string;
  /** In full, what is typed in the field, kept by the caller: it outlives
   *  the block while the question is folded away. */
  draft?: string;
  onDraftChange?: (text: string) => void;
}) {
  const [open, setOpen] = useState(false);
  // On one line (a worker's card) the question is its words alone.
  const words = useMemo(() => markdownToText(question), [question]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [replyError, setReplyError] = useState<string | null>(null);

  useEffect(() => {
    setSent(false);
    setReplyError(null);
  }, [question]);

  const stop = (e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); };

  const full = heading !== undefined;
  // In full it is a region to a screen reader: named by its head, described by the question.
  const headingId = useId();
  const questionId = useId();
  // In full, the answer field is always there.
  const inline = full && onSend !== undefined;
  const value = inline && draft !== undefined ? draft : text;
  const setValue = inline && onDraftChange ? onDraftChange : setText;
  const submit = async () => {
    const trimmed = value.trim();
    if (!onSend || !trimmed || sending || busy) return;
    setSending(true);
    try {
      // A refusal is said by the caller (`error`); the words stay to send again.
      if (await onSend(trimmed)) return;
      setSent(true);
      setOpen(false);
      setValue("");
      setReplyError(null);
    } catch {
      setReplyError("Failed to send — try again");
    } finally {
      setSending(false);
    }
  };

  // The composer's rule for an IME: the Enter that confirms a candidate is
  // the IME's (an unfinished answer sent would close the question).
  const { isComposing, textareaProps: { onCompositionStart, onCompositionEnd } } = useEnterToSend(() => {});
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if (isComposing(e.nativeEvent)) return;
    if (e.key === "Enter") void submit();
    if (e.key === "Escape") setOpen(false);
  };

  const failed = error ?? replyError;
  return (
    <div
      data-slot={full ? "question-dock" : "question-callout"}
      role={full ? "region" : undefined}
      aria-labelledby={full ? headingId : undefined}
      aria-describedby={full ? questionId : undefined}
      className={cn(
        // In full: a column that can be squeezed. Where the screen is short
        // its body scrolls in what is left, and the head and the hint keep
        // their lines. On a card: 12px above and below on a touch screen,
        // for Reply's touch area reaches 11px past it.
        full ? "flex min-h-0 flex-col rounded-xl px-4 py-3" : "mt-2 rounded-lg px-2.5 py-2 pointer-coarse:py-3",
        tone === "manager" ? MANAGER_QUESTION_FRAME : QUESTION_FRAME
      )}
      // A card sits in a row that opens on a click: clicks in it stay in it.
      // In full it stands alone, and its links open as links do.
      onClick={onSend && !full ? stop : undefined}
    >
      <div className="flex min-w-0 shrink-0 items-center gap-2">
        <CircleQuestionMark className={cn("size-4 shrink-0", tone === "manager" ? "text-amber" : "text-status-input-fg")} aria-hidden />
        {full
          ? <span id={headingId} data-slot="question-heading" className={cn("min-w-0 flex-1 truncate text-xs font-semibold", tone === "manager" ? "text-amber" : "text-status-input-fg")}>{heading}</span>
          : <span className="min-w-0 flex-1 truncate text-sm text-foreground/90" title={words}>{words}</span>}
        {actions}
        {onSend && !inline && (sent ? (
          <span className="shrink-0 font-mono text-2xs text-live">sent — agent resuming</span>
        ) : (
          !open && (
            <button
              type="button"
              onClick={(e) => { stop(e); setOpen(true); }}
              className="hit relative shrink-0 rounded-md border border-border bg-sel px-2.5 py-0.5 font-mono text-2xs font-semibold text-foreground"
            >
              Reply ↵
            </button>
          )
        ))}
      </div>
      {full && (
        // The block is never taller than half the screen, so the composer
        // under it keeps its place: past that, this scrolls. The padding is
        // room for an answer's focus ring, which a scroller clips.
        <div data-slot="question-body" className="-mx-0.5 mt-1 max-h-[min(24rem,50dvh)] min-h-0 overflow-y-auto p-0.5">
          {/* The model's words drawn as the chat draws a reply: its links
              (a canvas opens over the page), bold, code. A long question
              scrolls in a few lines of its own, so the answers under it stay
              in view. */}
          <div id={questionId} data-slot="question-text" className="max-h-[min(9rem,22dvh)] overflow-y-auto text-foreground">
            <MarkdownView text={question} />
          </div>
          {options.length > 0 && (
            <div role="group" aria-label="Suggested answers" className="mt-2 flex flex-col gap-1">
              {options.map((option, index) => (
                <button
                  key={option.label}
                  type="button"
                  data-slot="question-option"
                  // Held, not disabled: the one that has the focus keeps it.
                  aria-disabled={busy || undefined}
                  onClick={() => { if (!busy) onPick?.(option.label); }}
                  className="flex min-w-0 flex-col gap-0.5 rounded-md border border-border-soft bg-background/50 px-2.5 py-1.5 text-left transition-colors hover:bg-sel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 aria-disabled:pointer-events-none aria-disabled:opacity-60 pointer-coarse:min-h-11 pointer-coarse:justify-center"
                >
                  <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                    {/* A button: its words alone, no link inside it. */}
                    <span data-slot="question-option-label" className="min-w-0 text-sm font-medium text-foreground [overflow-wrap:anywhere]">{markdownToText(option.label)}</span>
                    {index === 0 && <span className="shrink-0 text-2xs text-faint">Recommended</span>}
                  </span>
                  {option.description && (
                    <span data-slot="question-option-description" className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{markdownToText(option.description)}</span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {(open || inline) && (
        <div className="mt-2 flex shrink-0 items-center gap-2">
          <input
            autoFocus={!inline}
            data-slot={inline ? "question-input" : undefined}
            aria-label={inline ? placeholder : undefined}
            value={value}
            onChange={(e) => { setValue(e.target.value); setReplyError(null); }}
            onKeyDown={onKeyDown}
            onCompositionStart={onCompositionStart}
            onCompositionEnd={onCompositionEnd}
            onClick={stop}
            placeholder={inline ? placeholder : "Reply to the worker…"}
            // In full it is held, not disabled, while its answer is on its way: it keeps the focus.
            disabled={!inline && sending}
            readOnly={inline && (sending || busy)}
            className={cn(
              // In full it sits among the answers, as tall as they are on a touch screen.
              inline
                ? "h-9 min-w-0 flex-1 rounded-md border border-border-soft bg-background/50 px-2.5 text-sm pointer-coarse:h-11"
                : "h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2.5 text-sm",
              "placeholder:text-faint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-60",
              inline && "read-only:opacity-60"
            )}
          />
          <Button
            type="button"
            size="sm"
            data-slot={inline ? "question-send" : undefined}
            onClick={(e) => { stop(e); void submit(); }}
            disabled={!inline && (sending || value.trim().length === 0)}
            aria-disabled={(inline && (sending || busy || value.trim().length === 0)) || undefined}
            className={cn("shrink-0 text-xs font-semibold", inline && "h-9 aria-disabled:pointer-events-none aria-disabled:opacity-50 pointer-coarse:h-11")}
          >
            {sending ? "Sending…" : "Send"}
          </Button>
        </div>
      )}
      {failed && <p data-slot="question-error" role="alert" className="mt-2 shrink-0 text-xs text-red">{failed}</p>}
      {hint && !inline && <p data-slot="question-hint" className="mt-1.5 shrink-0 text-2xs text-faint">{hint}</p>}
    </div>
  );
}
