import { useLayoutEffect, useRef } from "react";
import type { CalendarEntryDto, CalendarTimeDto } from "@shared/api/calendar";
import { cn } from "@/lib/utils";
import { clockOf, sameDay, weekdayOf } from "./calendar-dates";
import { isPast, repeatText, timeKey } from "./calendar-times";

const HOUR_PX = 44;
const PHONE_HOUR_PX = 40;
/** A reminder is a moment: drawn half an hour tall. */
const BLOCK_MIN = 30;

interface Placed {
  time: CalendarTimeDto;
  start: number;
  lane: number;
  lanes: number;
}

/** Minutes into its day, in the viewer's zone. */
function minuteOf(ms: number): number {
  const d = new Date(ms);
  return d.getHours() * 60 + d.getMinutes();
}

/** Blocks that overlap share the width, side by side. */
function place(times: readonly CalendarTimeDto[]): Placed[] {
  const sorted = [...times].sort((a, b) => a.at - b.at);
  const placed: Placed[] = [];
  let cluster: Placed[] = [];
  let clusterEnd = -1;
  const close = () => {
    const lanes = Math.max(1, ...cluster.map((p) => p.lane + 1));
    for (const p of cluster) p.lanes = lanes;
    cluster = [];
  };
  for (const time of sorted) {
    const start = minuteOf(time.at);
    if (start >= clusterEnd) close();
    const taken = new Set(cluster.filter((p) => p.start + BLOCK_MIN > start).map((p) => p.lane));
    let lane = 0;
    while (taken.has(lane)) lane++;
    const item = { time, start, lane, lanes: 1 };
    cluster.push(item);
    placed.push(item);
    clusterEnd = Math.max(clusterEnd, start + BLOCK_MIN);
  }
  close();
  return placed;
}

/** Day and Week: a 24-hour grid, a column a day, each entry's time a block at its hour. */
export function TimeGrid({ days, times, entries, now, where, onOpen }: {
  days: readonly Date[];
  times: readonly CalendarTimeDto[];
  entries: ReadonlyMap<string, CalendarEntryDto>;
  now: number;
  where: "page" | "panel" | "phone";
  onOpen: (time: CalendarTimeDto, el: HTMLElement) => void;
}) {
  const hour = where === "phone" ? PHONE_HOUR_PX : HOUR_PX;
  const scroller = useRef<HTMLDivElement>(null);
  const single = days.length === 1;
  // Opened at the working morning, as the common calendars open; then where
  // the user scrolled it, week after week and from Week to Day.
  const opened = useRef(false);
  useLayoutEffect(() => {
    if (opened.current || !scroller.current) return;
    opened.current = true;
    scroller.current.scrollTop = hour * 7.5;
  }, [hour]);
  const columns = `${where === "phone" ? 34 : 46}px repeat(${days.length}, minmax(0, 1fr))`;
  return (
    <div data-slot="calendar-grid" className="flex min-h-0 flex-1 flex-col">
      <div className="grid shrink-0 border-b border-border-soft" style={{ gridTemplateColumns: columns }}>
        <div />
        {days.map((day) => {
          const today = sameDay(day, now);
          return (
            <div key={day.getTime()} data-slot="calendar-day-head" data-today={today || undefined} className={cn("min-w-0 px-0.5 pb-1.5 pt-1 text-center text-2xs", today ? "text-status-review" : "text-muted-foreground")}>
              {weekdayOf(day)}
              <span className={cn("mx-auto block w-7 rounded-full text-[15px] font-medium leading-7", today ? "bg-status-review text-background" : "text-foreground")}>{day.getDate()}</span>
            </div>
          );
        })}
      </div>
      <div ref={scroller} data-slot="calendar-grid-scroll" className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="relative grid" style={{ gridTemplateColumns: columns, height: hour * 24 }}>
          <div className="relative" aria-hidden>
            {Array.from({ length: 23 }, (_, i) => (
              <span key={i} className="absolute right-1.5 -translate-y-1/2 text-[10.5px] tabular-nums text-faint" style={{ top: (i + 1) * hour }}>{`${String(i + 1).padStart(2, "0")}:00`}</span>
            ))}
          </div>
          {days.map((day) => {
            const mine = times.filter((t) => sameDay(t.at, day));
            const weekend = day.getDay() === 0 || day.getDay() === 6;
            return (
              <div key={day.getTime()} data-slot="calendar-day-column" className={cn("relative min-w-0 border-l border-border-soft", weekend && "bg-panel/60")}>
                {Array.from({ length: 23 }, (_, i) => <div key={i} aria-hidden className="absolute inset-x-0 border-t border-border-soft" style={{ top: (i + 1) * hour }} />)}
                {place(mine).map(({ time, start, lane, lanes }) => {
                  const past = isPast(time, now);
                  const paused = time.outcome === "paused";
                  const entry = entries.get(time.entryId);
                  const words = single && entry ? repeatText(entry) : null;
                  return (
                    <button
                      key={timeKey(time)}
                      type="button"
                      data-slot="calendar-block"
                      data-entry={time.entryId}
                      data-at={time.at}
                      data-past={past || undefined}
                      data-paused={paused || undefined}
                      onClick={(event) => onOpen(time, event.currentTarget)}
                      className={cn(
                        "absolute z-[1] flex min-w-0 items-center gap-1 overflow-hidden whitespace-nowrap rounded-[4px] border-l-[3px] px-1.5 text-left text-[11px] leading-tight focus-visible:outline-2 focus-visible:outline-ring",
                        paused
                          ? "border-l-faint bg-[repeating-linear-gradient(135deg,var(--sel)_0_6px,transparent_6px_12px)] text-muted-foreground shadow-[inset_0_0_0_1px_var(--border)]"
                          : "border-l-status-review bg-status-review/15 text-foreground",
                        past && "opacity-50",
                        where === "phone" && "border-l-2 px-[3px] text-[10px]"
                      )}
                      style={{ top: (start / 60) * hour + 1, height: (BLOCK_MIN / 60) * hour - 2, left: `calc(${(lane / lanes) * 100}% + 2px)`, width: `calc(${100 / lanes}% - 5px)` }}
                    >
                      {where === "page" || single ? <span className="shrink-0 tabular-nums opacity-80">{clockOf(time.at)}</span> : null}
                      <span className="min-w-0 truncate font-semibold">{time.title}</span>
                      {words ? <span className="min-w-0 truncate opacity-80">· {words}</span> : null}
                    </button>
                  );
                })}
                {sameDay(day, now) ? <div data-slot="calendar-now" aria-hidden className="absolute inset-x-0 z-[2] border-t-2 border-destructive before:absolute before:-left-1 before:-top-[5px] before:size-2 before:rounded-full before:bg-destructive" style={{ top: (minuteOf(now) / 60) * hour }} /> : null}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
