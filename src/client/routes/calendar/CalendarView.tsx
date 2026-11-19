import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { CalendarEntryDto, CalendarTimeDto } from "@shared/api/calendar";
import { PillTabs } from "@/components/PillTabs";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useNow } from "@/hooks/useNow";
import { personalAgentLabel } from "@/lib/personal-agent-label";
import { useCalendarRange } from "@/store/calendar";
import { usePersonalAgentStore } from "@/store/personal-agent";
import { cn } from "@/lib/utils";
import { periodOf, startOfDay, stepAnchor, type CalendarViewKind } from "./calendar-dates";
import { rememberView, rememberedView, type CalendarPlace } from "./calendar-view-memory";
import { timeKey } from "./calendar-times";
import { TimeGrid } from "./TimeGrid";
import { MonthGrid } from "./MonthGrid";
import { CalendarList } from "./CalendarList";
import { EntryDetails } from "./EntryDetails";

const VIEWS: ReadonlyArray<{ id: CalendarViewKind; label: string }> = [
  { id: "day", label: "Day" },
  { id: "week", label: "Week" },
  { id: "month", label: "Month" },
  { id: "list", label: "List" }
];

/** The personal agent's calendar as the common calendar apps draw one: Day,
 *  Week, Month and List, Today and a step back or on. The page and the panel
 *  tab draw this one component; each place keeps its own view. */
export function CalendarView({ place }: { place: "page" | "panel" }) {
  const phone = useIsMobile();
  const where: CalendarPlace = phone ? "phone" : place;
  return <CalendarBody key={where} where={where} />;
}

function CalendarBody({ where }: { where: CalendarPlace }) {
  const phone = where === "phone";
  const now = useNow();
  const [view, setView] = useState<CalendarViewKind>(() => rememberedView(where));
  const [anchor, setAnchor] = useState(() => startOfDay(Date.now()));
  const [picked, setPicked] = useState(() => startOfDay(Date.now()));
  const [open, setOpen] = useState<{ key: string; el: HTMLElement | null } | null>(null);
  const period = useMemo(() => periodOf(view, anchor), [view, anchor]);
  const { data } = useCalendarRange(period.from, period.to);
  const agentName = personalAgentLabel(usePersonalAgentStore((s) => s.agent));
  const entries = useMemo(() => new Map<string, CalendarEntryDto>((data?.entries ?? []).map((e) => [e.id, e])), [data]);
  const times = data?.times ?? [];
  // A time deleted by "Only this one" is gone from the page, as in the common calendars.
  const drawn = useMemo(() => (data?.times ?? []).filter((t) => t.outcome !== "skipped"), [data]);
  const opened = open ? times.find((t) => timeKey(t) === open.key) : undefined;
  const openedEntry = opened ? entries.get(opened.entryId) : undefined;
  const choose = (next: CalendarViewKind) => {
    setView(next);
    setOpen(null);
    rememberView(where, next);
  };
  const go = (day: Date) => {
    setAnchor(startOfDay(day));
    setPicked(startOfDay(day));
    setOpen(null);
  };
  const onOpen = (time: CalendarTimeDto, el: HTMLElement) => setOpen({ key: timeKey(time), el });
  const empty = data !== null && data.entries.length === 0;
  return (
    <div data-slot="calendar-view" data-view={view} data-place={where} className="flex min-h-0 flex-1 flex-col">
      {/* On a phone the views take a row of their own under the title, Today
          and the steps: beside the steps they would not fit a narrow one. On a
          touch screen the controls stand far enough apart that their touch
          areas do not overlap. */}
      <div data-slot="calendar-toolbar" className={cn("flex shrink-0 flex-wrap items-center gap-1.5 pointer-coarse:gap-4", phone ? "px-3 py-2" : "px-3.5 py-2.5")}>
        <span data-slot="calendar-title" className={cn("flex-1 truncate font-semibold", phone ? "min-w-0 text-[15px]" : "min-w-[120px] text-sm")}>{period.title}</span>
        <button type="button" data-slot="calendar-today" onClick={() => go(new Date())} className="hit relative h-7 rounded-md border border-border px-2.5 text-[12.5px] hover:bg-sel">Today</button>
        <button type="button" aria-label="Previous" onClick={() => go(stepAnchor(view, anchor, -1))} className="hit relative inline-flex size-7 items-center justify-center rounded-md border border-border hover:bg-sel">
          <ChevronLeft className="size-3.5" />
        </button>
        <button type="button" aria-label="Next" onClick={() => go(stepAnchor(view, anchor, 1))} className="hit relative inline-flex size-7 items-center justify-center rounded-md border border-border hover:bg-sel">
          <ChevronRight className="size-3.5" />
        </button>
        <span className={cn(phone ? "basis-full" : "order-last")}>
          <PillTabs items={VIEWS} value={view} onChange={choose} aria-label="Calendar view" />
        </span>
      </div>
      {/* Day, Week and Month draw their grid with nothing on it too, as the
          common calendars do; it is there while a range loads, so it is never
          taken away when the range comes back empty. Only a list, empty, says so. */}
      {empty && view === "list" ? <p data-slot="calendar-empty" className="px-4 py-3 text-[13px] text-muted-foreground md:px-[18px]">Nothing on the calendar.</p> : null}
      {view === "day" || view === "week" ? <TimeGrid days={period.days} times={drawn} entries={entries} now={now} where={where} onOpen={onOpen} /> : null}
      {view === "month" ? (
        <MonthGrid
          days={period.days}
          month={startOfDay(anchor).getMonth()}
          times={drawn}
          entries={entries}
          now={now}
          phone={phone}
          picked={picked}
          onPick={(day) => { setPicked(day); setOpen(null); }}
          onOpenDay={(day) => { go(day); choose("day"); }}
          onOpen={onOpen}
        />
      ) : null}
      {/* Until its range arrives a list says nothing, rather than "nothing in these days". */}
      {!empty && view === "list" && data !== null ? <CalendarList days={period.days} times={times} entries={entries} now={now} phone={phone} onOpen={onOpen} /> : null}
      {/* A press on another block while one's details are open opens its own:
          keyed by the time, the first ones end, and their close, which Radix
          still sends a moment after that click, closes only them. */}
      {open && opened && openedEntry ? (
        <EntryDetails key={open.key} time={opened} entry={openedEntry} anchor={open.el} phone={phone} agentName={agentName} now={now} onClose={() => setOpen((shown) => (shown?.key === open.key ? null : shown))} />
      ) : null}
    </div>
  );
}
