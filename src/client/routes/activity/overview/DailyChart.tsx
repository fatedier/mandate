import { useState } from "react";
import type { ActivityDailyDto } from "@shared/api-contracts";
import {
  cacheHitRate,
  formatCount,
  formatPercentileMs,
  formatTokenCount
} from "../activity-model";

/** The SVG needs an explicit height. Sized only by width it takes its default
 *  and escapes the box; with `overflow: visible` it paints over the page. */
export function DailyChart({ daily }: { daily: ActivityDailyDto[] }) {
  const [hovered, setHovered] = useState<number | null>(null);

  if (daily.length === 0) return null;
  // Guarded: `daily` arrives zero-filled, so a window of silent days would
  // otherwise divide by zero and hand React height="NaN" on every bar.
  const peak = Math.max(1, ...daily.map((d) => d.calls));
  const width = 100 / daily.length;
  const active = hovered === null ? null : daily[hovered] ?? null;

  return (
    // The wrapper, not the plot, is the positioning context: the plot carries
    // `overflow-hidden` to keep the SVG in its box, and a tooltip inside it
    // would be clipped by the same rule.
    <div className="relative">
      <div className="h-52 overflow-hidden">
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="block h-full w-full">
          {[25, 50, 75].map((y) => (
            <line key={y} x1="0" y1={y} x2="100" y2={y}
                  className="stroke-border-soft" strokeWidth="1" vectorEffect="non-scaling-stroke" />
          ))}
          {/* A band behind the whole column, not a brighter bar alone. On a
              quiet day the bar is two pixels, so anything that marked the value
              would be invisible exactly where the tooltip matters most. */}
          {hovered !== null && (
            <rect data-chart-band x={hovered * width} y={0} width={width} height={100}
                  className="fill-muted/45" />
          )}
          {daily.map((day, index) => {
            const height = (day.calls / peak) * 100;
            const failedHeight = day.calls ? (day.failed / day.calls) * height : 0;
            const x = index * width + width * 0.17;
            const barWidth = width * 0.66;
            return (
              <g key={day.date}>
                <rect x={x} y={100 - height} width={barWidth} height={height}
                      className={hovered === index ? "fill-primary" : "fill-primary/55"} />
                {failedHeight > 0.3 && (
                  <rect x={x} y={100 - failedHeight} width={barWidth} height={failedHeight}
                        className="fill-destructive" />
                )}
              </g>
            );
          })}
          {/* Full-height targets, drawn last so they sit above the bars.
              Without them the only thing a pointer can reach is the painted
              bar, and a quiet day against a busy peak is two pixels tall in a
              208px box — the days most worth asking about are the ones that
              cannot be hovered. */}
          {daily.map((day, index) => (
            <rect
              key={`hit-${day.date}`}
              data-chart-hit={day.date}
              x={index * width}
              y={0}
              width={width}
              height={100}
              fill="transparent"
              onMouseEnter={() => setHovered(index)}
              onMouseLeave={() => setHovered((current) => (current === index ? null : current))}
            />
          ))}
        </svg>
      </div>

      <div className="flex justify-between pt-1 text-2xs text-chrome">
        <span className="num">{daily[0]?.date}</span>
        <span className="num">{daily[daily.length - 1]?.date}</span>
      </div>

      {active && hovered !== null && (
        <DayCard day={active} index={hovered} columns={daily.length} />
      )}
    </div>
  );
}

/**
 * One day's figures, anchored over its column.
 *
 * Everything here is already in the response and was previously rendered
 * nowhere: the daily percentiles in particular answer "was that spike slow, or
 * just busy" — a question the bar height alone cannot.
 */
function DayCard({
  day, index, columns
}: { day: ActivityDailyDto; index: number; columns: number }) {
  const centre = ((index + 0.5) / columns) * 100;
  // Beside the column, not over it, and inside the plot rather than above it.
  // Centred it covers the bar it describes; floated above the plot it covers
  // the headline figures, which is what the first attempt did. Flipping past
  // the middle keeps a 13rem card inside a plot of any width, by construction
  // rather than by measuring — measuring would cost a layout pass and a second
  // render on every column the pointer crosses.
  const flip = centre > 55;
  const style = flip
    ? { right: `calc(${(100 - centre).toFixed(2)}% + 0.75rem)` }
    : { left: `calc(${centre.toFixed(2)}% + 0.75rem)` };

  const cached = cacheHitRate(day.inputTokens, day.cacheReadTokens);

  return (
    <div
      data-chart-tooltip={day.date}
      style={style}
      // Pointer events off: the card sits over the hit targets, and a pointer
      // that entered it would count as leaving the column and close it.
      className="pointer-events-none absolute top-2 z-10 w-52 rounded-lg border border-border bg-popover/95 p-3 shadow-lg backdrop-blur-sm"
    >
      <div className="num text-2xs text-chrome">{day.date}</div>
      {/* The failure count belongs to the headline, not to the list: it is a
          subdivision of the calls beside it, and as a conditional row it made
          everything under it jump by a line on the days that had none — which
          is most of them. The list below is now the same five rows for every
          day, so a reader moving across the window compares fixed positions. */}
      <div className="num mt-0.5 text-lg leading-none text-foreground">
        {formatCount(day.calls)}
        <span className="ml-1 text-2xs text-chrome">calls</span>
        {day.failed > 0 && (
          <span className="ml-2 text-2xs text-destructive">
            {formatCount(day.failed)} failed
          </span>
        )}
      </div>
      <dl className="mt-2 flex flex-col gap-1 border-t border-border-soft pt-2 text-2xs">
        <Row label="p50" value={formatPercentileMs(day.p50Ms)} />
        <Row label="p95" value={formatPercentileMs(day.p95Ms)} />
        {/* `inputTokens` is already the whole prompt — the cached part is a
            subset of it, not a sibling to be added (see `cacheHitRate`). The
            names are the ones the providers' own APIs use (`input_tokens`,
            `cache_read_input_tokens`, `output_tokens`), so a reader comparing
            this against a provider dashboard is comparing the same words.

            The two token counts are adjacent because they are the pair worth
            reading against each other — on this store input runs three orders
            of magnitude above output — and the hit rate goes last because it
            is the one figure here in different units. The headline row states
            the share beside its own denominator instead, where there is no
            output figure to separate. */}
        <Row label="input tokens" value={formatTokenCount(day.inputTokens)} />
        <Row label="output tokens" value={formatTokenCount(day.outputTokens)} />
        <Row label="cache hit rate" value={cached === null ? "—" : `${Math.round(cached)}%`} />
      </dl>
    </div>
  );
}

function Row({ label, value, tone }: { label: string; value: string; tone?: "alert" }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-chrome">{label}</dt>
      <dd className={tone === "alert" ? "num text-destructive" : "num text-foreground"}>{value}</dd>
    </div>
  );
}
