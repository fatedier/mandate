import { useState } from "react";
import { formatCalendarDay } from "@/lib/format";
import { cn } from "@/lib/utils";
import { formatCount } from "../activity-model";
import { LEDGER_COPY } from "../ledger-copy";
import { formatUsd } from "../money";

export interface SpendDay {
  date: string;
  spendMicros: number;
  expiredExtraMicros: number;
  calls: number;
  failed: number;
}

/**
 * Spend per day: one bar a day, the part the cache-expired calls paid on top
 * at its base (amber), the rest above it (grey). Hovering a day shows its
 * figures; the value labels stand over the bars when there is room. A bar is
 * a button that picks its day: the picked one stands out and the others
 * fade, and it shows no card (the figures above are its own).
 */
export function SpendChart({ days, estimated, picked = null, onPick = () => {} }: {
  days: SpendDay[];
  estimated: boolean;
  picked?: string | null;
  onPick?: (date: string) => void;
}) {
  const [hovered, setHovered] = useState<number | null>(null);
  if (days.length === 0) return null;
  const peak = Math.max(1, ...days.map((d) => d.spendMicros));
  const active = hovered === null || days[hovered]?.date === picked ? null : days[hovered] ?? null;

  return (
    <div className="@container relative">
      {/* The labels sit over their bars, out of the flow, in the room the top
          padding leaves: the bars alone share the plotting height, so their
          heights stay proportional to the spend. */}
      <div className="flex h-52 items-end gap-1.5 pt-5 @min-[40rem]:gap-3">
        {days.map((day, index) => {
          const total = (day.spendMicros / peak) * 100;
          const expiredShare = day.spendMicros > 0 ? (Math.min(day.expiredExtraMicros, day.spendMicros) / day.spendMicros) * 100 : 0;
          return (
            <button
              type="button"
              key={day.date}
              data-spend-day={day.date}
              aria-pressed={day.date === picked}
              aria-label={`${formatCalendarDay(day.date)}: ${formatUsd(day.spendMicros, estimated)}`}
              onClick={() => onPick(day.date)}
              onMouseOver={() => setHovered(index)}
              onMouseLeave={() => setHovered((current) => (current === index ? null : current))}
              className={cn(
                "relative h-full min-w-0 flex-1 cursor-pointer rounded-sm transition-opacity",
                (hovered === index || day.date === picked) && "bg-sel",
                picked !== null && day.date !== picked && "opacity-35"
              )}
            >
              <div data-spend-bar className="absolute inset-x-0 bottom-0 flex flex-col justify-end" style={{ height: `${total}%` }}>
                <div className="min-h-0 flex-1 rounded-t-sm bg-faint" />
                <div data-spend-expired className="bg-amber" style={{ height: `${expiredShare}%` }} />
              </div>
              <span
                data-spend-label
                className="num absolute inset-x-0 hidden truncate text-center text-2xs text-faint @min-[40rem]:block"
                style={{ bottom: `calc(${total}% + 2px)` }}
              >
                {day.spendMicros > 0 ? formatUsd(day.spendMicros, estimated) : ""}
              </span>
            </button>
          );
        })}
      </div>
      <div className="flex justify-between pt-1 text-2xs text-faint">
        <span className="num">{formatCalendarDay(days[0]?.date ?? "")}</span>
        <span className="num">{formatCalendarDay(days[days.length - 1]?.date ?? "")}</span>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 pt-2 text-2xs text-muted-foreground">
        <span className="flex items-center gap-1.5"><span className="size-2 rounded-[2px] bg-amber" aria-hidden />{LEDGER_COPY.legendExpired}</span>
        <span className="flex items-center gap-1.5"><span className="size-2 rounded-[2px] bg-faint" aria-hidden />{LEDGER_COPY.legendRest}</span>
      </div>
      {active && hovered !== null && (
        <div
          data-spend-card={active.date}
          style={((hovered + 0.5) / days.length) > 0.55
            ? { right: `calc(${(100 - ((hovered + 0.5) / days.length) * 100).toFixed(2)}% + 0.75rem)` }
            : { left: `calc(${(((hovered + 0.5) / days.length) * 100).toFixed(2)}% + 0.75rem)` }}
          className="pointer-events-none absolute top-2 z-10 w-56 rounded-lg border border-border-soft bg-panel p-3 text-2xs shadow-md"
        >
          <div className="num text-faint">{formatCalendarDay(active.date)}</div>
          <div className="num mt-0.5 text-lg leading-none text-foreground">{formatUsd(active.spendMicros, estimated)}</div>
          <div className="num mt-2 flex flex-col gap-1 border-t border-border-soft pt-2 text-muted-foreground">
            <span><span className="text-amber">{formatUsd(active.expiredExtraMicros, estimated)}</span> cache expired</span>
            <span>
              {formatCount(active.calls)} calls
              {active.failed > 0 && <span className="ml-2 text-destructive">{formatCount(active.failed)} failed</span>}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
