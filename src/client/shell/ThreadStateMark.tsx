import { useState } from "react";
import { cn } from "@/lib/utils";
import { DOT_ARIA } from "@shared/status-words";
import type { ThreadDot } from "@shared/thread-dot";

/** Every working dot on one beat. A browser starts a CSS animation afresh
 *  whenever its element comes back into the document: a turn starting, and
 *  also the row moved in the sorted list, or the sidebar shown again. So each
 *  start is put at the document timeline's origin, and two running threads
 *  breathe together whenever their turns began. */
function onBeat(event: React.AnimationEvent<SVGSVGElement>) {
  for (const animation of event.currentTarget.getAnimations()) animation.startTime = 0;
}

/** A thread's state as one mark in a 10px slot: what asks for you a solid
 *  dot (red: it broke; yellow: a question; the accent: a decision or a
 *  result to read), a turn running
 *  the green dot that breathes wherever the app shows something running, a
 *  wait on a monitor a grey clock. Running is green, not the working blue,
 *  which sat 0.07 from the review dot (OKLab). Idle draws nothing; the slot
 *  stays, so the titles line up. A mark that comes later fades in, and a
 *  change of colour moves gently. */
export function ThreadStateMark({ dot }: { dot: ThreadDot }) {
  const mark = dot === "failed" || dot === "needs_you" || dot === "decision" || dot === "result"
    ? "dot" : dot === "working" ? "pulse" : dot === "watching" ? "clock" : undefined;
  // A mark that comes later fades in; one there as the sidebar opened is
  // just there. Between marks the colour moves gently.
  const [fadesIn, setFadesIn] = useState(!mark);
  if (!mark && !fadesIn) setFadesIn(true);
  return (
    <span role="img" aria-label={`state: ${DOT_ARIA[dot]}`} data-mark={mark} className="relative size-2.5 shrink-0">
      {mark && (
        // The fade is its own box's: the working dot's breath is the mark's
        // animation, and one element runs one.
        <span className={cn("absolute inset-0", fadesIn && "animate-in fade-in-0 duration-200")}>
          <svg
            viewBox="0 0 8 8"
            aria-hidden
            onAnimationStart={onBeat}
            className={cn(
              "absolute inset-0 size-full transition-colors duration-200 motion-reduce:transition-none",
              dot === "failed" && "text-red",
              dot === "needs_you" && "text-status-input",
              (dot === "decision" || dot === "result") && "text-status-review",
              dot === "working" && "animate-working text-live",
              dot === "watching" && "text-faint"
            )}
          >
            {(mark === "dot" || mark === "pulse") && <circle cx="4" cy="4" r="3" fill="currentColor" />}
            {mark === "clock" && (
              <>
                <circle cx="4" cy="4" r="3.1" fill="none" stroke="currentColor" strokeWidth="1.1" />
                <path d="M4 2.3V4.1l1.3 0.8" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" />
              </>
            )}
          </svg>
        </span>
      )}
    </span>
  );
}
