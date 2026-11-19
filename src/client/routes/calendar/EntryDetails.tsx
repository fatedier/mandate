import { useRef, useState, type ReactNode } from "react";
import { Clock, Pause, Play, Repeat2, Trash2, X } from "lucide-react";
import type { CalendarEntryDto, CalendarTimeDto } from "@shared/api/calendar";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { BottomSheet, BottomSheetTitle } from "@/components/ui/bottom-sheet";
import { Button } from "@/components/ui/button";
import { useCalendarStore } from "@/store/calendar";
import { clockOf, shortDayOf } from "./calendar-dates";
import { isPast, repeatText } from "./calendar-times";

/** What one time of an entry holds, and what the user may do with it: pause
 *  or resume a repeat, delete (asked first: this time only, or all of it). */
function Details({ time, entry, agentName, now, onClose }: {
  time: CalendarTimeDto;
  entry: CalendarEntryDto;
  agentName: string;
  now: number;
  onClose: () => void;
}) {
  const [asking, setAsking] = useState(false);
  const store = useCalendarStore.getState;
  const repeating = entry.repeat !== null;
  const past = isPast(time, now);
  // A time still to come may be skipped; one passed (or skipped already) cannot.
  const skippable = repeating && !past && time.outcome !== "skipped";
  const words = repeatText(entry);
  const act = (run: () => Promise<void>, close: boolean) => {
    void run();
    if (close) onClose();
  };
  return (
    <div data-slot="calendar-details" className="flex flex-col gap-1.5 text-[13px]">
      <div className="flex items-start gap-2">
        <span aria-hidden className="mt-1.5 size-2.5 shrink-0 rounded-[3px] bg-status-review" />
        <h3 data-slot="calendar-details-title" className="m-0 min-w-0 flex-1 break-words text-sm font-semibold">{entry.title}</h3>
        <button type="button" aria-label="Close" onClick={onClose} className="hit relative shrink-0 rounded-sm p-0.5 text-faint hover:text-foreground">
          <X className="size-4" />
        </button>
      </div>
      <p className="m-0 flex items-center gap-1.5 pl-[18px] text-muted-foreground"><Clock aria-hidden className="size-3" />{shortDayOf(time.at)} · {clockOf(time.at)}</p>
      {words ? (
        <p className="m-0 flex flex-wrap items-center gap-1.5 pl-[18px] text-muted-foreground">
          <Repeat2 aria-hidden className="size-3" />
          <span data-slot="calendar-details-repeat">{words}</span>
          {entry.paused ? <span className="rounded-full bg-sel px-1.5 text-2xs font-semibold">Paused</span> : null}
        </p>
      ) : null}
      <div className="pl-[18px]">
        <span className="block text-2xs font-semibold text-faint">{agentName}&apos;s note</span>
        <p data-slot="calendar-details-note" className="m-0 whitespace-pre-wrap break-words text-muted-foreground">{entry.note}</p>
      </div>
      {asking ? (
        <div data-slot="calendar-details-ask" className="mt-1 flex flex-col gap-2 pl-[18px]">
          <p className="m-0">{repeating ? `Delete "${entry.title}"?` : `Delete "${entry.title}"? This can't be undone.`}</p>
          <div className="flex flex-wrap justify-end gap-1.5">
            <Button variant="outline" size="sm" onClick={() => setAsking(false)}>Cancel</Button>
            {repeating && skippable ? <Button variant="outline" size="sm" className="text-destructive" onClick={() => act(() => store().skip(entry.id, time.at), true)}>Only this one</Button> : null}
            <Button variant="destructive" size="sm" onClick={() => act(() => store().remove(entry.id), true)}>{repeating ? "All of them" : "Delete"}</Button>
          </div>
        </div>
      ) : (
        <div className="mt-1 flex flex-wrap justify-end gap-1.5">
          {repeating ? (
            <Button variant="outline" size="sm" onClick={() => act(() => (entry.paused ? store().resume(entry.id) : store().pause(entry.id)), false)}>
              {entry.paused ? <Play className="size-3" /> : <Pause className="size-3" />}
              {entry.paused ? "Resume" : "Pause"}
            </Button>
          ) : null}
          {repeating || !past ? (
            <Button variant="outline" size="sm" className="text-destructive" onClick={() => setAsking(true)}>
              <Trash2 className="size-3" />
              Delete
            </Button>
          ) : null}
        </div>
      )}
    </div>
  );
}

/** The details of a time clicked: beside it on a wide screen, a sheet from the bottom on a phone. */
export function EntryDetails({ time, entry, anchor, phone, agentName, now, onClose }: {
  time: CalendarTimeDto;
  entry: CalendarEntryDto;
  anchor: HTMLElement | null;
  phone: boolean;
  agentName: string;
  now: number;
  onClose: () => void;
}) {
  const pressedOutside = useRef(false);
  // The block itself is the anchor's context: its grid or list, scrolled,
  // moves the details with it.
  const beside = { getBoundingClientRect: () => startOf(anchor ?? document.body), contextElement: anchor ?? undefined };
  const body: ReactNode = <Details key={`${time.entryId}@${time.at}`} time={time} entry={entry} agentName={agentName} now={now} onClose={onClose} />;
  if (phone) {
    return (
      <BottomSheet
        open
        onOpenChange={(open) => { if (!open) onClose(); }}
        slot="calendar-details-sheet"
        bodyClassName="px-4 pt-3 pb-6"
        returnFocus={() => (anchor?.isConnected ? anchor : null)}
        header={<BottomSheetTitle className="sr-only">{entry.title}</BottomSheetTitle>}
      >
        {body}
      </BottomSheet>
    );
  }
  return (
    <Popover open onOpenChange={(open) => { if (!open) onClose(); }}>
      <PopoverAnchor virtualRef={{ current: beside }} />
      <PopoverContent
        data-slot="calendar-details-popover"
        aria-label={entry.title}
        side="right"
        align="start"
        sideOffset={6}
        collisionPadding={12}
        onInteractOutside={() => { pressedOutside.current = true; }}
        // What opened it is a block or a row, not a trigger of its own: closed
        // from the keyboard or by Close, the focus goes back there as it would
        // to a trigger; after a press elsewhere, or with something else holding
        // it by then (the next details), it stays where it is.
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const holder = document.activeElement;
          if (pressedOutside.current || (holder && holder !== document.body)) return;
          if (anchor?.isConnected) anchor.focus();
        }}
        // A long note scrolls inside, its actions still reached: never taller than the room there is.
        className="max-h-[var(--radix-popover-content-available-height)] w-[min(300px,calc(100vw-32px))] overflow-y-auto overscroll-contain p-3"
      >
        {body}
      </PopoverContent>
    </Popover>
  );
}

/** Where the details stand beside: a block or row as wide as the day leaves
 *  no room on either side of it, so they stand beside its start instead. */
const BESIDE = 160;
function startOf(el: Element): DOMRect {
  const box = el.getBoundingClientRect();
  return box.width <= BESIDE ? box : new DOMRect(box.left, box.top, BESIDE, box.height);
}
