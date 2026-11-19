import type { CalendarEntryDto, CalendarTimeDto } from "@shared/api/calendar";
import { cn } from "@/lib/utils";
import { clockOf, dayName, sameDay, shortDayOf } from "./calendar-dates";
import { isPast, timeKey } from "./calendar-times";
import { CalendarRow } from "./CalendarList";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
/** What a day's box holds before "+N more". */
const SHOWN = 3;

/** Month: weeks from Monday; each day its times, up to three, then "+N more".
 *  On a phone, dots, and the tapped day's times under the grid. */
export function MonthGrid({ days, month, times, entries, now, phone, picked, onPick, onOpenDay, onOpen }: {
  days: readonly Date[];
  /** The month drawn (0–11): days of the months around it are dimmed. */
  month: number;
  times: readonly CalendarTimeDto[];
  entries: ReadonlyMap<string, CalendarEntryDto>;
  now: number;
  phone: boolean;
  /** The phone's day tapped. */
  picked: Date;
  onPick: (day: Date) => void;
  /** A day opened in Day view. */
  onOpenDay: (day: Date) => void;
  onOpen: (time: CalendarTimeDto, el: HTMLElement) => void;
}) {
  const ofDay = (day: Date) => times.filter((t) => sameDay(t.at, day));
  const pickedTimes = ofDay(picked);
  return (
    <div data-slot="calendar-month" className={cn("min-h-0 flex-1 overflow-y-auto overscroll-contain pb-4", phone ? "px-2" : "px-3.5")}>
      <div className="grid grid-cols-7 border-l border-t border-border-soft">
        {WEEKDAYS.map((name) => <div key={name} className="border-b border-r border-border-soft px-1.5 py-1 text-2xs font-semibold text-faint">{name}</div>)}
        {days.map((day) => {
          const mine = ofDay(day);
          const today = sameDay(day, now);
          const out = day.getMonth() !== month;
          const label = shortDayOf(day);
          if (phone) {
            return (
              <button
                key={day.getTime()}
                type="button"
                data-slot="calendar-day-cell"
                data-today={today || undefined}
                aria-label={label}
                aria-pressed={sameDay(day, picked)}
                onClick={() => onPick(day)}
                className={cn("flex min-h-[52px] min-w-0 flex-col items-center gap-1 border-b border-r border-border-soft pt-1", sameDay(day, picked) && "bg-sel", out && "text-faint")}
              >
                <span className={cn("inline-flex size-5 items-center justify-center rounded-full text-[11.5px] tabular-nums", today && "bg-status-review font-semibold text-background", out && !today && "opacity-50")}>{day.getDate()}</span>
                <span data-slot="calendar-dots" className="flex gap-[3px]">
                  {mine.slice(0, 4).map((t) => <i key={timeKey(t)} className={cn("block size-[5px] rounded-full", t.outcome === "paused" ? "bg-faint" : "bg-status-review", isPast(t, now) && "opacity-45")} />)}
                </span>
              </button>
            );
          }
          const crowded = mine.length > SHOWN;
          const shown = crowded ? mine.slice(0, SHOWN - 1) : mine;
          return (
            <div
              key={day.getTime()}
              data-slot="calendar-day-cell"
              data-today={today || undefined}
              onClick={(event) => { if (!(event.target as HTMLElement).closest("[data-slot='calendar-chip']")) onOpenDay(day); }}
              className="flex min-h-[84px] min-w-0 cursor-pointer flex-col gap-0.5 border-b border-r border-border-soft p-[3px] hover:bg-sel/50"
            >
              <button type="button" aria-label={label} onClick={(event) => { event.stopPropagation(); onOpenDay(day); }} className={cn("ml-0.5 inline-flex size-5 items-center justify-center rounded-full text-[11.5px] tabular-nums text-muted-foreground", today && "bg-status-review font-semibold text-background", out && !today && "opacity-45")}>
                {day.getDate()}
              </button>
              {shown.map((time) => (
                <button
                  key={timeKey(time)}
                  type="button"
                  data-slot="calendar-chip"
                  data-entry={time.entryId}
                  data-at={time.at}
                  data-past={isPast(time, now) || undefined}
                  data-paused={time.outcome === "paused" || undefined}
                  onClick={(event) => onOpen(time, event.currentTarget)}
                  className={cn(
                    "block w-full min-w-0 truncate rounded-[4px] px-1 text-left text-[10.5px] leading-normal",
                    time.outcome === "paused"
                      ? "bg-[repeating-linear-gradient(135deg,var(--sel)_0_6px,transparent_6px_12px)] text-muted-foreground shadow-[inset_0_0_0_1px_var(--border)]"
                      : "bg-status-review/15 text-foreground",
                    isPast(time, now) && "opacity-50"
                  )}
                >
                  {clockOf(time.at)} {time.title}
                </button>
              ))}
              {crowded ? (
                <button type="button" data-slot="calendar-more" onClick={(event) => { event.stopPropagation(); onOpenDay(day); }} className="pl-1 text-left text-[10.5px] text-faint hover:text-foreground">
                  +{mine.length - shown.length} more
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
      {phone ? (
        <section data-slot="calendar-picked-day" className="mt-3 px-1">
          <h3 className={cn("m-0 mb-1 text-xs font-semibold", sameDay(picked, now) ? "text-status-review" : "text-muted-foreground")}>{dayName(picked, now)}</h3>
          {pickedTimes.length === 0 ? <p className="text-[13px] text-muted-foreground">Nothing in these days.</p> : null}
          {pickedTimes.map((time) => <CalendarRow key={timeKey(time)} time={time} entry={entries.get(time.entryId)} phone now={now} onOpen={onOpen} />)}
        </section>
      ) : null}
    </div>
  );
}
