import { useState, type KeyboardEvent } from "react";
import { scalePoint, tickFormat, type ScaleLinear } from "d3-scale";
import { line } from "d3-shape";
import type { ActivityTrendDto, ActivityTrendValueDto } from "@shared/api-contracts";
import { Section } from "@/components/Section";
import { useElementWidth } from "@/hooks/useElementWidth";
import { formatCalendarDay } from "@/lib/format";
import { cn } from "@/lib/utils";
import { formatPercentileMs } from "../activity-model";
import { shortGroupLabels } from "../breakdown-model";
import { formatUsd } from "../money";
import { useTapToPeek } from "./tap-to-peek";
import { besideMark, formatAxisSeconds, LABEL_FONT_PX, LABEL_HEIGHT, labelWidth, linearAxis, spreadLabels } from "./chart-scales";

type Metric = "spend" | "ttft" | "failed";

/** Each chart's title: over it, and its name to a screen reader. */
const TITLES: Record<Metric, string> = { spend: "Spend a day", ttft: "TTFT p95 a day", failed: "Failed a day" };

/** A line's colour by its place among the busiest models, the rest in
 *  grey. Spelled out whole: Tailwind finds classes by reading the source. */
const TONES = [
  { stroke: "stroke-chart-1", fill: "fill-chart-1", swatch: "bg-chart-1" },
  { stroke: "stroke-chart-2", fill: "fill-chart-2", swatch: "bg-chart-2" },
  { stroke: "stroke-chart-3", fill: "fill-chart-3", swatch: "bg-chart-3" }
] as const;
const REST_TONE = { stroke: "stroke-faint", fill: "fill-faint", swatch: "bg-faint" } as const;

/** Drawn at this width until the box is measured (and in tests, which have
 *  no layout). Below `NARROW` the lines lose their end labels and the
 *  legend alone names them: a phone's plot cannot spare the room. */
const DEFAULT_WIDTH = 600;
const NARROW = 480;
const HEIGHT = 150;
/** Between two end labels' baselines: an 11px label's box is ~14px tall. */
const END_GAP = 15;
const TICKS = 3;
/** The day card's width, fixed so where it goes can be worked out before
 *  it is drawn. */
const CARD_WIDTH = 224;

interface TrendLine {
  key: string;
  name: string;
  tone: { stroke: string; fill: string; swatch: string };
}

/**
 * Grouped by day: what each of the busiest models spent, how long its first
 * token took (p95) and how often it failed, a day at a time, with the rest of
 * the models as one grey line. A day with no reading breaks a line rather
 * than dropping it to zero. A day opens its log, as a table row does.
 */
export function DayTrends({ trend, estimated, onSelect }: {
  trend: ActivityTrendDto;
  estimated: boolean;
  onSelect: (day: string) => void;
}) {
  const names = shortGroupLabels(trend.series.filter((series) => !series.others), "model");
  let rank = 0;
  const lines: TrendLine[] = trend.series.map((series) => ({
    key: series.key,
    name: series.others ? `${series.models} other${series.models === 1 ? "" : "s"}` : names.get(series.key) ?? series.label,
    tone: series.others ? REST_TONE : TONES[rank++] ?? REST_TONE
  }));
  const chart = (metric: Metric) => <TrendChart metric={metric} trend={trend} lines={lines} estimated={estimated} onSelect={onSelect} />;
  return (
    <div className="flex flex-col gap-6">
      <ul data-trend-legend aria-label="Lines" className="flex flex-wrap gap-x-4 gap-y-1 text-2xs text-muted-foreground">
        {lines.map((entry) => (
          <li key={entry.key} className="inline-flex items-center gap-1.5 font-mono">
            <span aria-hidden className={cn("h-0.5 w-3 rounded-full", entry.tone.swatch)} />
            {entry.name}
          </li>
        ))}
      </ul>
      {/* A chart with nothing to draw is left out, as an empty ranked list
          is: a window that spent nothing (every call in a plan, free or
          unpriced), or one where no call recorded a first token. */}
      {drawn(trend, "spend") && <Section title={TITLES.spend} meta={estimated ? "estimated" : undefined}>{chart("spend")}</Section>}
      {drawn(trend, "ttft") && <Section title={TITLES.ttft} meta="seconds">{chart("ttft")}</Section>}
      <Section title={TITLES.failed} meta="of calls">{chart("failed")}</Section>
    </div>
  );
}

/** Whether a chart has a line to draw: a reading on some day, and for
 *  spend one above zero. */
function drawn(trend: ActivityTrendDto, metric: Metric): boolean {
  return trend.days.some((day) => day.values.some((value) => {
    const reading = read(metric, value);
    return reading !== null && (metric !== "spend" || reading > 0);
  }));
}

/** The figure a chart draws: spend is zero on a day with no call (nothing
 *  was spent); a first token or a failed share has no reading then. */
function read(metric: Metric, value: ActivityTrendValueDto | undefined): number | null {
  if (!value) return null;
  switch (metric) {
    case "spend": return value.spendMicros;
    case "ttft": return value.ttftP95Ms;
    case "failed": return value.failedRate;
  }
}

function formatValue(metric: Metric, value: number | null, estimated: boolean): string {
  if (value === null) return "—";
  switch (metric) {
    case "spend": return formatUsd(value, estimated);
    case "ttft": return formatPercentileMs(value);
    case "failed": return `${value.toFixed(1)}%`;
  }
}

/** How an axis writes its ticks: d3 picks the decimals from the step
 *  between them, so two ticks never read the same and none carries more
 *  digits than the step needs. Spend ticks are micros written as dollars. */
function tickFormatter(metric: Metric, scale: ScaleLinear<number, number>): (value: number) => string {
  switch (metric) {
    case "spend": {
      const dollars = tickFormat(0, (scale.domain()[1] ?? 0) / 1_000_000, TICKS, "$,f");
      return (value) => dollars(value / 1_000_000);
    }
    case "ttft": return formatAxisSeconds;
    case "failed": {
      const share = scale.tickFormat(TICKS, ",~f");
      return (value) => `${share(value)}%`;
    }
  }
}

function TrendChart({ metric, trend, lines, estimated, onSelect }: {
  metric: Metric;
  trend: ActivityTrendDto;
  lines: TrendLine[];
  estimated: boolean;
  onSelect: (day: string) => void;
}) {
  const [measure, measured] = useElementWidth<HTMLDivElement>();
  // The card shows for the day under the pointer, else the one a finger
  // tapped, else the one with the keyboard's focus.
  const [hovered, setHovered] = useState<number | null>(null);
  const [peeked, setPeeked] = useState<number | null>(null);
  const [focused, setFocused] = useState<number | null>(null);
  const showing = hovered ?? peeked ?? focused;
  const peek = useTapToPeek(showing);
  const width = measured || DEFAULT_WIDTH;
  const labelled = width >= NARROW;
  const top = 10;
  const bottom = HEIGHT - 22;
  const dates = trend.days.map((day) => day.date);
  const values = lines.map((entry) => trend.days.map((day) => read(metric, day.values.find((value) => value.key === entry.key))));
  const y = linearAxis(Math.max(0, ...values.flat().filter((value): value is number => value !== null)), [bottom, top], TICKS);
  const format = tickFormatter(metric, y.scale);
  // The gutter fits the widest tick it holds.
  const left = Math.max(28, ...y.ticks.map((tick) => labelWidth(format(tick)))) + 10;
  const right = labelled ? Math.max(0, ...lines.map((entry) => labelWidth(entry.name))) + 22 : 12;
  const plot = { x: left, y: top, width: Math.max(1, width - left - right), height: bottom - top };
  const x = scalePoint<string>().domain(dates).range([plot.x, plot.x + plot.width]);
  const xOf = (index: number) => x(dates[index]!) ?? plot.x;
  const step = dates.length > 1 ? plot.width / (dates.length - 1) : plot.width;
  const path = line<number | null>()
    .defined((value) => value !== null)
    .x((_, index) => xOf(index))
    .y((value) => y.scale(value ?? 0));

  // Each line's last reading, and where its name goes beside the plot.
  const ends = lines
    .map((entry, index) => {
      const at = values[index]!.findLastIndex((value) => value !== null);
      return at < 0 ? null : { entry, cx: xOf(at), cy: y.scale(values[index]![at]!) };
    })
    .filter((end) => end !== null);
  const endYs = spreadLabels(ends.map((end) => end.cy), END_GAP, plot.y + LABEL_HEIGHT / 2, plot.y + plot.height);
  const day = showing === null ? null : trend.days[showing] ?? null;
  const describe = (index: number) => `${formatCalendarDay(dates[index]!)}: `
    + lines.map((entry, at) => `${entry.name} ${formatValue(metric, values[at]![index]!, estimated)}`).join(", ");
  const pick = (index: number) => onSelect(dates[index]!);
  // A tap elsewhere moves a phone's pointer off the day: its card goes too.
  const leave = (index: number) => {
    setHovered((current) => (current === index ? null : current));
    setPeeked((current) => (current === index ? null : current));
  };

  return (
    <div ref={measure} data-trend-chart={metric} className="relative">
      <svg role="group" aria-label={TITLES[metric]} width="100%" height={HEIGHT} viewBox={`0 0 ${width} ${HEIGHT}`} className="block">
        {y.ticks.map((tick) => (
          <g key={tick}>
            <line x1={plot.x} x2={plot.x + plot.width} y1={y.scale(tick)} y2={y.scale(tick)} className="stroke-border-soft" strokeWidth="1" />
            <text data-trend-tick x={plot.x - 6} y={y.scale(tick) + 4} textAnchor="end" fontSize={LABEL_FONT_PX} className="num fill-faint">
              {format(tick)}
            </text>
          </g>
        ))}
        {dates.length > 1 ? (
          <>
            <text x={plot.x} y={HEIGHT - 6} fontSize={LABEL_FONT_PX} className="num fill-faint">{formatCalendarDay(dates[0]!)}</text>
            <text x={plot.x + plot.width} y={HEIGHT - 6} textAnchor="end" fontSize={LABEL_FONT_PX} className="num fill-faint">{formatCalendarDay(dates[dates.length - 1]!)}</text>
          </>
        ) : dates.length === 1 && (
          <text x={xOf(0)} y={HEIGHT - 6} textAnchor="middle" fontSize={LABEL_FONT_PX} className="num fill-faint">{formatCalendarDay(dates[0]!)}</text>
        )}
        {showing !== null && (
          <line x1={xOf(showing)} x2={xOf(showing)} y1={plot.y} y2={plot.y + plot.height} className="stroke-border" strokeWidth="1" />
        )}
        {/* The rest first, then the busiest last: the first colour on top. */}
        {[...lines.keys()].reverse().map((index) => {
          const entry = lines[index]!;
          const series = values[index]!;
          // A reading with none on either side is no segment: a point instead.
          const alone = series.flatMap((value, at) =>
            value !== null && (at === 0 || series[at - 1] === null) && (at === series.length - 1 || series[at + 1] === null) ? [at] : []);
          return (
            <g key={entry.key}>
              <path
                data-trend-line={entry.key}
                d={path(series) ?? ""}
                fill="none"
                strokeWidth="2"
                strokeLinejoin="round"
                strokeLinecap="round"
                className={entry.tone.stroke}
              />
              {alone.map((at) => (
                <circle key={at} data-trend-point={entry.key} cx={xOf(at)} cy={y.scale(series[at]!)} r={3} className={entry.tone.fill} />
              ))}
            </g>
          );
        })}
        {labelled && ends.map((end, index) => (
          <g key={`end-${end.entry.key}`}>
            <circle cx={end.cx} cy={end.cy} r={3.5} strokeWidth="2" className={cn(end.entry.tone.fill, "stroke-panel")} />
            <line x1={end.cx + 5} x2={plot.x + plot.width + 10} y1={end.cy} y2={endYs[index]!} className="stroke-faint" strokeWidth="1" />
            <text
              data-trend-end={end.entry.key}
              x={plot.x + plot.width + 12}
              y={endYs[index]! + 4}
              fontSize={LABEL_FONT_PX}
              className="fill-muted-foreground font-mono"
            >
              {end.entry.name}
            </text>
          </g>
        ))}
        {showing !== null && lines.map((entry, index) => {
          const value = values[index]![showing];
          if (value === null || value === undefined) return null;
          return <circle key={`at-${entry.key}`} cx={xOf(showing)} cy={y.scale(value)} r={4} strokeWidth="2" className={cn(entry.tone.fill, "stroke-panel")} />;
        })}
        {focused !== null && (
          <rect x={xOf(focused) - step / 2} y={plot.y} width={step} height={plot.height} fill="none" strokeWidth="1.5" className="stroke-foreground" />
        )}
        {/* A full-height target for each day, over the lines: a day is found
            by where it is across, whatever its lines read. */}
        {dates.map((date, index) => (
          <rect
            key={date}
            data-trend-day={date}
            x={xOf(index) - step / 2}
            y={plot.y}
            width={step}
            height={plot.height}
            fill="transparent"
            role="button"
            tabIndex={0}
            aria-label={describe(index)}
            className="cursor-pointer outline-none"
            onPointerDown={(event) => peek.down(index, event)}
            onClick={() => (peek.opens(index) ? pick(index) : setPeeked(index))}
            onKeyDown={(event: KeyboardEvent) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              pick(index);
            }}
            onMouseEnter={() => setHovered(index)}
            onMouseLeave={() => leave(index)}
            onFocus={() => setFocused(index)}
            onBlur={() => setFocused((current) => (current === index ? null : current))}
          />
        ))}
      </svg>
      {day && showing !== null && (
        <DayValues
          date={day.date}
          rows={lines.map((entry, index) => ({ entry, value: formatValue(metric, values[index]![showing]!, estimated) }))}
          left={besideMark(xOf(showing), 0, CARD_WIDTH, width)}
        />
      )}
    </div>
  );
}

/** A day's figures for one chart, beside its day and inside the chart. */
function DayValues({ date, rows, left }: {
  date: string;
  rows: Array<{ entry: TrendLine; value: string }>;
  left: number;
}) {
  return (
    <div
      data-trend-card={date}
      style={{ left, width: CARD_WIDTH }}
      // Pointer events off: the card sits over the day targets, and a pointer
      // that entered it would count as leaving the day and close it.
      className="pointer-events-none absolute top-1 z-10 rounded-lg border border-border-soft bg-panel p-2.5 shadow-md"
    >
      <div className="num text-2xs text-faint">{formatCalendarDay(date)}</div>
      <dl className="mt-1.5 flex flex-col gap-1 text-2xs">
        {rows.map(({ entry, value }) => (
          <div key={entry.key} className="flex items-center gap-2">
            <span aria-hidden className={cn("h-0.5 w-3 shrink-0 rounded-full", entry.tone.swatch)} />
            <dt className="min-w-0 flex-1 truncate font-mono text-muted-foreground">{entry.name}</dt>
            <dd className="num text-foreground">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
