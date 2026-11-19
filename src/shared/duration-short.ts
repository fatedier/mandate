/** The largest unit the duration is a whole number of: 300000 → "5m". How the
 *  monitor tool writes an interval, and the chat's waiting line with it. */
export function formatDurationShort(ms: number): string {
  for (const [unit, size] of [["d", 86_400_000], ["h", 3_600_000], ["m", 60_000], ["s", 1000]] as const) {
    if (ms >= size && ms % size === 0) return `${ms / size}${unit}`;
  }
  return `${ms}ms`;
}

/** "30s", "5m", "2h", "1d", "1.5h", "90 minutes" → milliseconds; null when the
 *  string is not a relative duration. The units schedule_wake has always
 *  accepted, now shared with monitor. */
export function parseDurationMs(raw: string): number | null {
  const match = (raw ?? "").trim().match(/^(\d+(?:\.\d+)?)\s*(ms|msec|millisecond|milliseconds|s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/i);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  const unit = match[2]!.toLowerCase();
  const multiplier =
    unit === "ms" || unit === "msec" || unit.startsWith("millisecond") ? 1
      : unit === "s" || unit === "sec" || unit === "secs" || unit.startsWith("second") ? 1000
        : unit === "m" || unit === "min" || unit === "mins" || unit.startsWith("minute") ? 60_000
          : unit === "h" || unit === "hr" || unit === "hrs" || unit.startsWith("hour") ? 3_600_000
            : unit === "d" || unit.startsWith("day") ? 86_400_000
              : 0;
  return multiplier > 0 ? Math.floor(value * multiplier) : null;
}
