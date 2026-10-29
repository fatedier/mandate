import { useId, useState } from "react";
import { Fold } from "@/components/Fold";
import { Link } from "react-router";
import { ChevronRight } from "lucide-react";
import { useWaitingRows } from "@/hooks/useWaitingRows";
import { waitingPlaces, type WaitingRow } from "@/lib/waiting-rows";
import { WAITING_WORD, type WaitingKind } from "@shared/status-words";
import { cn } from "@/lib/utils";

// A question yellow, a failure or a stop red, a decision or a result the accent.
const TONE: Record<WaitingKind, string> = { input: "text-status-input-fg", failed: "text-red", stopped: "text-red", decision: "text-status-review", result: "text-status-review" };
const DOT: Record<WaitingKind, string> = { input: "bg-status-input", failed: "bg-red", stopped: "bg-red", decision: "bg-status-review", result: "bg-status-review" };

const toLookAt = (row: { waiting: WaitingKind }) => row.waiting === "decision" || row.waiting === "result";

/** Everything that waits on the user, most urgent first. What holds an agent
 *  up (a question, a failure, a stop) is a row each; a decision or a result
 *  to read holds nobody up and piles up, so two or more of them are one row
 *  that opens to them in place. */
export function WaitingOnYou() {
  const rows = useWaitingRows();
  const [open, setOpen] = useState(false);
  const listId = useId();
  if (rows.length === 0) return null;
  const reviews = rows.filter(toLookAt);
  const folded = reviews.length >= 2;
  const shown = folded ? rows.filter((r) => !toLookAt(r)) : rows;
  return (
    <section aria-label="Waiting on you" className="flex flex-col gap-2">
      <h2 className="label-group">Waiting on you</h2>
      <div className="flex flex-col overflow-hidden rounded-xl border border-border-soft">
        {shown.map((r, i) => <WaitingRowLink key={r.key} row={r} first={i === 0} />)}
        {folded && (
          <>
            <button
              type="button"
              data-slot="waiting-fold"
              aria-expanded={open}
              aria-controls={listId}
              onClick={() => setOpen(!open)}
              className={cn(
                "flex items-start gap-3 px-3 py-2.5 text-left hover:bg-sel",
                // Opened, the rows say where they are: one line, a touch target on a phone.
                open ? "pointer-coarse:min-h-11" : "min-h-14",
                shown.length > 0 && "border-t border-border-soft"
              )}
            >
              <span aria-hidden className={cn("mt-1.5 size-2 shrink-0 rounded-full", DOT.decision)} />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex min-w-0 items-center gap-2">
                  <span data-slot="waiting-title" className="min-w-0 truncate text-sm font-semibold text-foreground">{reviews.length} to look at</span>
                  <ChevronRight aria-hidden className={cn("size-3.5 shrink-0 text-faint transition-transform", open && "rotate-90")} />
                </span>
                {!open && (
                  <span data-slot="waiting-reason" className="line-clamp-2 break-words text-xs text-muted-foreground">{waitingPlaces(reviews)}</span>
                )}
              </span>
            </button>
            <Fold open={open} id={listId} className="flex flex-col">
              {reviews.map((r) => <WaitingRowLink key={r.key} row={r} first={false} />)}
            </Fold>
          </>
        )}
      </div>
    </section>
  );
}

function WaitingRowLink({ row: r, first }: { row: WaitingRow; first: boolean }) {
  return (
    <Link
      to={r.href}
      data-waiting={r.waiting}
      className={cn("flex min-h-14 items-start gap-3 px-3 py-2.5 hover:bg-sel", !first && "border-t border-border-soft")}
    >
      {/* Centred on the title's 20px line. */}
      <span aria-hidden className={cn("mt-1.5 size-2 shrink-0 rounded-full", DOT[r.waiting])} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        {/* The state word on the title's line, not a column of its own:
            beside the two lines it left a phone one line of reason, the
            worker's name filling the first. */}
        <span className="flex min-w-0 items-baseline gap-3">
          <span data-slot="waiting-title" className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">{r.title}</span>
          <span data-slot="waiting-state" className={cn("shrink-0 text-xs font-semibold", TONE[r.waiting])}>{WAITING_WORD[r.waiting]}</span>
        </span>
        {/* Two lines: what a worker waits on is often a whole sentence,
            and one truncated line cut off the half that says what it
            wants. */}
        <span data-slot="waiting-reason" className="line-clamp-2 break-words text-xs text-muted-foreground">
          {r.name && <span className="text-foreground">{r.name}</span>}
          {r.name && r.text ? " · " : ""}
          {r.text}
        </span>
      </span>
    </Link>
  );
}
