import { useEffect, useState, type KeyboardEvent, type MouseEvent } from "react";
import { CircleQuestionMark } from "lucide-react";
import { cn } from "@/lib/utils";

/** The agent's blocking question, surfaced as a first-class callout on
 *  attention cards, with an inline reply that posts to the worker
 *  without opening the dock. Swallows click/key events so the host card
 *  (a Link) doesn't navigate. */
export function QuestionCallout({ question, onSend }: {
  question: string;
  onSend: (text: string) => Promise<void> | void;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSent(false);
    setError(null);
  }, [question]);

  const stop = (e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); };

  const submit = async () => {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    setSending(true);
    try {
      await onSend(trimmed);
      setSent(true);
      setOpen(false);
      setText("");
      setError(null);
    } catch {
      setError("Failed to send — try again");
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if (e.key === "Enter") void submit();
    if (e.key === "Escape") setOpen(false);
  };

  return (
    <div
      className="mt-2 rounded-lg border border-status-input/20 bg-status-input/5 px-2.5 py-2"
      onClick={stop}
    >
      <div className="flex min-w-0 items-center gap-2">
        <CircleQuestionMark className="h-4 w-4 shrink-0 text-status-input" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-sm text-foreground/90" title={question}>
          {question}
        </span>
        {sent ? (
          <span className="shrink-0 font-mono text-2xs text-live">sent — agent resuming</span>
        ) : (
          !open && (
            <button
              type="button"
              onClick={(e) => { stop(e); setOpen(true); }}
              className="shrink-0 rounded-md border border-primary/25 bg-primary/10 px-2.5 py-0.5 font-mono text-2xs font-semibold text-primary-soft transition-colors hover:bg-primary/20"
            >
              Reply ↵
            </button>
          )
        )}
      </div>
      {open && (
        <div className="mt-2 flex items-center gap-2">
          <input
            autoFocus
            value={text}
            onChange={(e) => { setText(e.target.value); setError(null); }}
            onKeyDown={onKeyDown}
            onClick={stop}
            placeholder="Reply to the worker…"
            disabled={sending}
            className={cn(
              "h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2.5 text-sm",
              "placeholder:text-faint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            )}
          />
          <button
            type="button"
            onClick={(e) => { stop(e); void submit(); }}
            disabled={sending || text.trim().length === 0}
            className="shrink-0 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground disabled:opacity-50"
          >
            {sending ? "Sending…" : "Send"}
          </button>
        </div>
      )}
      {error && (
        <div className="mt-1 font-mono text-2xs text-status-input">{error}</div>
      )}
    </div>
  );
}
