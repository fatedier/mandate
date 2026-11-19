import { Repeat2 } from "lucide-react";
import type { CalendarEntryDto, CalendarTimeDto } from "@shared/api/calendar";
import { cn } from "@/lib/utils";
import { clockOf, dayName, sameDay } from "./calendar-dates";
import { isPast, repeatText, timeKey } from "./calendar-times";

/** One time as a row of a list: its time, title and, wide, its repeat. A
 *  phone's Month lists a day's times whatever became of them: a past one is
 *  dimmed and a paused one greyed, as in the grid (List shows neither). */
export function CalendarRow({ time, entry, phone, now, onOpen }: {
  time: CalendarTimeDto;
  entry: CalendarEntryDto | undefined;
  phone: boolean;
  now: number;
  onOpen: (time: CalendarTimeDto, el: HTMLElement) => void;
}) {
  const words = entry ? repeatText(entry) : null;
  const past = isPast(time, now);
  const paused = time.outcome === "paused";
  return (
    <button
      type="button"
      data-slot="calendar-list-row"
      data-entry={time.entryId}
      data-at={time.at}
      data-past={past || undefined}
      data-paused={paused || undefined}
      onClick={(event) => onOpen(time, event.currentTarget)}
      className={cn(
        "hit relative -mx-1.5 flex w-[calc(100%+0.75rem)] min-w-0 items-baseline gap-2.5 rounded-md px-1.5 py-1 text-left pointer-coarse:min-h-11 pointer-coarse:items-center hover:bg-sel focus-visible:outline-2 focus-visible:outline-ring",
        paused && "text-muted-foreground",
        past && "opacity-50"
      )}
    >
      <span aria-hidden className={cn("size-2 shrink-0 -translate-y-px rounded-full", paused ? "bg-faint" : "bg-status-review")} />
      <span className="w-10 shrink-0 text-[12.5px] tabular-nums text-muted-foreground">{clockOf(time.at)}</span>
      <span className="min-w-0 flex-1 truncate">{time.title}</span>
      {words ? (
        <span className="inline-flex shrink-0 items-center gap-1 text-[11.5px] text-faint" title={words}>
          <Repeat2 aria-hidden className="size-3" />
          {phone ? null : <span>{words}</span>}
        </span>
      ) : null}
    </button>
  );
}

/** List: each day with what it will deliver, in time order; past and paused times left out. */
export function CalendarList({ days, times, entries, now, phone, onOpen }: {
  days: readonly Date[];
  times: readonly CalendarTimeDto[];
  entries: ReadonlyMap<string, CalendarEntryDto>;
  now: number;
  phone: boolean;
  onOpen: (time: CalendarTimeDto, el: HTMLElement) => void;
}) {
  const ahead = times.filter((t) => t.outcome === "due" && t.at > now);
  const filled = days.map((day) => ({ day, times: ahead.filter((t) => sameDay(t.at, day)) })).filter((d) => d.times.length > 0);
  return (
    <div data-slot="calendar-list" className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-6 pt-1 md:px-[18px]">
      {filled.length === 0 ? <p className="py-3 text-[13px] text-muted-foreground">Nothing in these days.</p> : null}
      {filled.map(({ day, times: dayTimes }, index) => (
        <section key={day.getTime()} data-slot="calendar-list-day" className={cn("grid gap-2 py-2 max-md:grid-cols-1 md:grid-cols-[92px_1fr]", index > 0 && "border-t border-border-soft")}>
          <h3 className={cn("m-0 pt-1 text-xs font-semibold", sameDay(day, now) ? "text-status-review" : "text-muted-foreground")}>{dayName(day, now)}</h3>
          <div className="min-w-0">
            {dayTimes.map((time) => <CalendarRow key={timeKey(time)} time={time} entry={entries.get(time.entryId)} phone={phone} now={now} onOpen={onOpen} />)}
          </div>
        </section>
      ))}
    </div>
  );
}
