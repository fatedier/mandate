import { useEffect, useState } from "react";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { useSecondClock } from "@/hooks/useSecondClock";
import { formatElapsedClock } from "@/lib/format";
import { Shown } from "@/components/Shown";
import { cn } from "@/lib/utils";
import { lineVisible, type WorkingLine } from "./working-line";

/** A star that opens and closes, out and back. U+2733 asks for its text
 *  form: it has an emoji one too. */
const FRAMES = ["·", "✢", "✳\uFE0E", "✶", "✻", "✽"];
const SEQUENCE = [...FRAMES, ...FRAMES.slice(1, -1).reverse()];
const FRAME_MS = 120;

export function WorkingGlyph() {
  const still = useMediaQuery("(prefers-reduced-motion: reduce)");
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (still) return;
    const timer = setInterval(() => setFrame((current) => (current + 1) % SEQUENCE.length), FRAME_MS);
    return () => clearInterval(timer);
  }, [still]);
  return (
    <span data-slot="working-glyph" aria-hidden="true" className="flex w-3.5 shrink-0 justify-center text-sm leading-none text-live">
      {still ? "✻" : SEQUENCE[frame]}
    </span>
  );
}

/** The chat's one line while a turn works: a turning mark, what it is doing
 *  (the text shimmers; while it thinks, the heading its reasoning summary has
 *  reached), and how long the turn has run. The clock sits outside the
 *  shimmer so a tick never restarts it. It fades in as a turn starts and out
 *  as it ends (opened mid-turn, it is just there). Null: no turn works. */
export function WorkingIndicator({ line }: { line: WorkingLine | null }) {
  return (
    <Shown when={line !== null} enter="animate-in fade-in-0 duration-150" exit="animate-out fade-out-0 duration-150">
      {line && <WorkingRow line={line} />}
    </Shown>
  );
}

function WorkingRow({ line }: { line: WorkingLine }) {
  const [firstSeen] = useState(Date.now);
  const now = useSecondClock();
  const since = line.since ? Date.parse(line.since) : Number.NaN;
  const start = Number.isFinite(since) ? since : firstSeen;
  // While the reply moves it is what the eye follows: the line fades aside,
  // keeping its place, so the chat does not move by its height each time the
  // reply starts and stops; the second's tick brings it back once the text
  // has been still a moment.
  const aside = !lineVisible(line, now);
  return (
    <div
      data-slot="working-indicator"
      data-state={aside ? "aside" : "shown"}
      role="status"
      className={cn(
        "flex min-h-7 items-center gap-1.5 text-xs text-muted-foreground transition-[opacity,visibility] duration-150 ease-(--ease-ui) motion-reduce:transition-none",
        aside && "invisible opacity-0"
      )}
    >
      <WorkingGlyph />
      {/* A reasoning heading can be long: it gives way, the clock does not. */}
      <span data-slot="working-verb" className="min-w-0 truncate text-shimmer">{line.verb}…</span>
      <span data-slot="working-clock" aria-hidden="true" className="shrink-0 tabular-nums text-faint">
        {formatElapsedClock(now - start)}
      </span>
    </div>
  );
}
