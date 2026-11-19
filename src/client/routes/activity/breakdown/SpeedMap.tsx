import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import type { ActivityGroupDto, ActivityGroupKey } from "@shared/api-contracts";
import { useElementWidth } from "@/hooks/useElementWidth";
import { formatCount, formatPercentileMs } from "../activity-model";
import { ALERT_FAILED_SHARE, shortGroupLabels } from "../breakdown-model";
import { groupSpendLabel } from "../money";
import { useTapToPeek } from "./tap-to-peek";
import { besideMark, dotRadius, formatAxisSeconds, LABEL_FONT_PX, LABEL_HEIGHT, labelWidth, linearAxis, placeWithHint, type Box } from "./chart-scales";

/** Drawn at this width until the box is measured (and in tests, which have
 *  no layout). */
const DEFAULT_WIDTH = 600;
const MARGIN = { left: 44, right: 18, top: 18, bottom: 42 };
const LARGEST_DOT = 14;
/** The card beside a dot; a fixed width so where it goes across can be
 *  worked out before it is drawn. */
const CARD_WIDTH = 224;
const HINT = "fast, little wait";

/**
 * Each group as a dot: how long its calls wait for the first token (TTFT p95,
 * across) against how fast they write (the median call's tokens a second,
 * up), its area its calls, red when a tenth of them or more failed. The
 * top left is fast and quick to start. A group with no first token or no
 * speed has no place on it and is named under it instead.
 */
export function SpeedMap({ groups, group, onSelect }: {
  groups: ActivityGroupDto[];
  group: ActivityGroupKey;
  onSelect: (key: string) => void;
}) {
  const [measure, measured] = useElementWidth<HTMLDivElement>();
  // The card shows for the dot under the pointer, else the one a finger
  // tapped, else the one with the keyboard's focus: each is its own state,
  // so a mouse passing over another dot hands the card back to the focused
  // one when it leaves.
  const [hovered, setHovered] = useState<string | null>(null);
  const [peeked, setPeeked] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const showing = hovered ?? peeked ?? focused;
  const peek = useTapToPeek(showing);
  const labels = shortGroupLabels(groups, group);
  const nameOf = (entry: ActivityGroupDto) => labels.get(entry.key) ?? entry.label;

  const placeable = groups.filter((entry) => entry.ttftP95Ms !== null && entry.tokensPerSecondP50 !== null);
  const noFirstToken = groups.filter((entry) => entry.ttftP95Ms === null);
  const noRate = groups.filter((entry) => entry.ttftP95Ms !== null && entry.tokensPerSecondP50 === null);

  const width = measured || DEFAULT_WIDTH;
  const height = width < 480 ? 240 : 280;
  const plot: Box = {
    x: MARGIN.left, y: MARGIN.top,
    width: width - MARGIN.left - MARGIN.right, height: height - MARGIN.top - MARGIN.bottom
  };
  const x = linearAxis(Math.max(0, ...placeable.map((entry) => entry.ttftP95Ms ?? 0)), [plot.x, plot.x + plot.width]);
  const y = linearAxis(Math.max(0, ...placeable.map((entry) => entry.tokensPerSecondP50 ?? 0)), [plot.y + plot.height, plot.y]);
  const radius = dotRadius(Math.max(0, ...placeable.map((entry) => entry.calls)), LARGEST_DOT);
  const dots = placeable
    .map((entry) => ({
      entry,
      cx: x.scale(entry.ttftP95Ms ?? 0),
      cy: y.scale(entry.tokensPerSecondP50 ?? 0),
      r: radius(entry.calls),
      alert: entry.calls > 0 && entry.failed / entry.calls >= ALERT_FAILED_SHARE
    }))
    // Larger first, so a small dot is drawn over a large one, not under it.
    .sort((a, b) => b.r - a.r);
  // Labels may use the empty margins above and right of the plot (a dot on
  // its top edge still has room for its name), never the axes' ticks. The
  // hint names the top-left corner, as near it as neither a dot nor a name
  // covers it: a fast group sits exactly there.
  const labelArea: Box = { x: plot.x, y: 2, width: width - plot.x - 2, height: plot.y + plot.height - 2 };
  const { labels: placed, hint } = placeWithHint(
    dots.map((dot) => ({
      key: dot.entry.key, cx: dot.cx, cy: dot.cy, r: dot.r,
      width: labelWidth(nameOf(dot.entry)), height: LABEL_HEIGHT
    })),
    labelArea,
    [0, 48, 96].flatMap((right) => [0, 1, 2].map((down) => ({
      x: plot.x + 6 + right, y: plot.y + down * (LABEL_HEIGHT + 2), width: labelWidth(HINT), height: LABEL_HEIGHT
    })))
  );
  const active = dots.find((dot) => dot.entry.key === showing) ?? null;

  const missing = (
    <>
      {noFirstToken.length > 0 && (
        <p data-speed-missing className="px-3.5 py-2 text-2xs text-faint">
          Not on the chart (no first token): {noFirstToken.map(nameOf).join(", ")}
        </p>
      )}
      {noRate.length > 0 && (
        <p data-speed-missing className="px-3.5 py-2 text-2xs text-faint">
          Not on the chart (no tok/s): {noRate.map(nameOf).join(", ")}
        </p>
      )}
    </>
  );
  // No dot to draw: axes with nothing on them say less than the line does.
  if (dots.length === 0) return missing;

  const open = (key: string) => onSelect(key);
  const onKey = (key: string) => (event: KeyboardEvent) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    open(key);
  };
  const enter = (key: string) => setHovered(key);
  // A tap elsewhere moves a phone's pointer off the dot: its card goes too.
  const leave = (key: string) => {
    setHovered((current) => (current === key ? null : current));
    setPeeked((current) => (current === key ? null : current));
  };
  const click = (key: string) => (peek.opens(key) ? open(key) : setPeeked(key));

  return (
    <div>
      <div ref={measure} className="relative">
        <svg
          role="group"
          aria-label="Speed"
          width="100%"
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          className="block"
        >
          {x.ticks.map((tick) => (
            <g key={`x-${tick}`}>
              <line x1={x.scale(tick)} x2={x.scale(tick)} y1={plot.y} y2={plot.y + plot.height} className="stroke-border-soft" strokeWidth="1" />
              <text x={x.scale(tick)} y={plot.y + plot.height + 15} textAnchor="middle" fontSize={LABEL_FONT_PX} className="num fill-faint">
                {formatAxisSeconds(tick)}
              </text>
            </g>
          ))}
          {y.ticks.map((tick) => (
            <g key={`y-${tick}`}>
              <line x1={plot.x} x2={plot.x + plot.width} y1={y.scale(tick)} y2={y.scale(tick)} className="stroke-border-soft" strokeWidth="1" />
              <text x={plot.x - 6} y={y.scale(tick) + 4} textAnchor="end" fontSize={LABEL_FONT_PX} className="num fill-faint">
                {tick}
              </text>
            </g>
          ))}
          <text x={plot.x + plot.width / 2} y={height - 6} textAnchor="middle" fontSize={12} className="fill-muted-foreground">
            Waits for the first token (TTFT p95) →
          </text>
          <text
            x={12}
            y={plot.y + plot.height / 2}
            textAnchor="middle"
            fontSize={12}
            transform={`rotate(-90 12 ${plot.y + plot.height / 2})`}
            className="fill-muted-foreground"
          >
            Writes (tok/s) →
          </text>
          {hint && <text data-speed-hint x={hint.x} y={hint.y + LABEL_HEIGHT - 2} fontSize={LABEL_FONT_PX} className="fill-faint">{HINT}</text>}

          {/* Targets larger than a small dot, so the pointer finds it, all
              under every dot: a dot drawn is always its own target, and a
              neighbour's wider ring cannot take its clicks. */}
          <g aria-hidden>
            {dots.map(({ entry, cx, cy, r }) => (
              <circle
                key={`hit-${entry.key}`}
                data-speed-hit={entry.key}
                cx={cx}
                cy={cy}
                r={Math.max(r, 11)}
                fill="transparent"
                // A finger needs more: 44px across on a touch screen (SVG 2
                // lets CSS set a circle's radius).
                className="cursor-pointer pointer-coarse:[r:22px]"
                onPointerDown={(event) => peek.down(entry.key, event)}
                onClick={() => click(entry.key)}
                onMouseEnter={() => enter(entry.key)}
                onMouseLeave={() => leave(entry.key)}
              />
            ))}
          </g>
          {dots.map(({ entry, cx, cy, r, alert }) => (
            <g
              key={entry.key}
              data-speed-dot={entry.key}
              data-alert={alert ? "true" : "false"}
              role="button"
              tabIndex={0}
              aria-label={dotName(entry)}
              className="cursor-pointer outline-none"
              onPointerDown={(event) => peek.down(entry.key, event)}
              onClick={() => click(entry.key)}
              onKeyDown={onKey(entry.key)}
              onMouseEnter={() => enter(entry.key)}
              onMouseLeave={() => leave(entry.key)}
              onFocus={() => setFocused(entry.key)}
              onBlur={() => setFocused((current) => (current === entry.key ? null : current))}
            >
              <circle
                cx={cx}
                cy={cy}
                r={r}
                fillOpacity={showing === entry.key ? 1 : 0.85}
                strokeWidth="2"
                className={alert ? "fill-destructive stroke-panel" : "fill-chart-1 stroke-panel"}
              />
              {focused === entry.key && (
                <circle cx={cx} cy={cy} r={r + 3} fill="none" strokeWidth="1.5" className="stroke-foreground" />
              )}
            </g>
          ))}
          {placed.map(({ key, side, box }) => {
            const entry = groups.find((candidate) => candidate.key === key)!;
            const anchor = side === "right" ? "start" : side === "left" ? "end" : "middle";
            const tx = side === "right" ? box.x : side === "left" ? box.x + box.width : box.x + box.width / 2;
            return (
              <text
                key={`label-${key}`}
                data-speed-label={key}
                x={tx}
                y={box.y + LABEL_HEIGHT - 2}
                textAnchor={anchor}
                fontSize={LABEL_FONT_PX}
                pointerEvents="none"
                className="fill-foreground font-mono"
              >
                {nameOf(entry)}
              </text>
            );
          })}
        </svg>
        {active && <DotCard entry={active.entry} cx={active.cx} cy={active.cy} r={active.r} width={width} height={height} />}
      </div>
      {missing}
    </div>
  );
}

function failedPercent(entry: ActivityGroupDto): string {
  return `${(entry.calls ? (entry.failed / entry.calls) * 100 : 0).toFixed(1)}%`;
}

/** What a dot says to a screen reader: its group and every figure it is
 *  drawn from, and its spend when there is one to name. */
function dotName(entry: ActivityGroupDto): string {
  const spend = groupSpendLabel(entry);
  return `${entry.label}: ${formatCount(entry.calls)} calls, TTFT p95 ${formatPercentileMs(entry.ttftP95Ms)}, `
    + `${entry.tokensPerSecondP50?.toFixed(1)} tok/s, ${failedPercent(entry)} failed`
    + (spend === "—" ? "" : `, ${spend}`);
}

/** A dot's figures, beside it: right of it unless that runs out of the
 *  chart, then left; kept inside the box either way. How far down is set
 *  from the card's drawn height, before paint: a long name wraps, and the
 *  panel around the chart clips whatever runs past its bottom. */
function DotCard({ entry, cx, cy, r, width, height }: {
  entry: ActivityGroupDto; cx: number; cy: number; r: number; width: number; height: number;
}) {
  const card = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = card.current;
    if (!element) return;
    element.style.top = `${Math.max(0, Math.min(cy - 24, height - element.offsetHeight))}px`;
  }, [cy, height, entry.key]);
  const style = { left: besideMark(cx, r, CARD_WIDTH, width), width: CARD_WIDTH };
  return (
    <div
      ref={card}
      data-speed-card={entry.key}
      style={style}
      // Pointer events off: the card sits over other dots, and a pointer that
      // entered it would count as leaving the dot and close it.
      className="pointer-events-none absolute z-10 rounded-lg border border-border-soft bg-panel p-3 shadow-md"
    >
      <div className="break-words font-mono text-2xs text-foreground">{entry.label}</div>
      <dl className="mt-2 flex flex-col gap-1 border-t border-border-soft pt-2 text-2xs">
        <Row label="calls" value={formatCount(entry.calls)} />
        <Row label="spend" value={groupSpendLabel(entry)} />
        <Row label="TTFT p95" value={formatPercentileMs(entry.ttftP95Ms)} />
        <Row label="tok/s" value={entry.tokensPerSecondP50?.toFixed(1) ?? "—"} />
        <Row label="failed" value={failedPercent(entry)} />
      </dl>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-faint">{label}</dt>
      <dd className="num text-foreground">{value}</dd>
    </div>
  );
}
