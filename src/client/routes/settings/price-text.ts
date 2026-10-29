import type { PriceMatchDto, ProviderBilling } from "@shared/api/pricing";

/** The words Settings shows for prices and billing. */

/** A per-1M rate: cents where they matter, more digits for the small ones. */
function rate(value: number): string {
  if (value >= 0.01 || value === 0) return `$${value.toFixed(2)}`;
  return `$${Number(value.toPrecision(2))}`;
}

/** "2026-10-21" as "Oct 21". */
export function shortDay(day: string | null | undefined): string {
  if (!day) return "";
  const date = new Date(`${day}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** What Automatic found, as one line. */
export function matchLine(match: PriceMatchDto): string {
  const parts = [match.label, `${rate(match.rates.input)} in`, `${rate(match.rates.output)} out`];
  if (match.rates.cacheRead !== null) parts.push(`${rate(match.rates.cacheRead)} cached per 1M`);
  else parts[parts.length - 1] += " per 1M";
  const day = shortDay(match.dataDate);
  return day ? `${parts.join(" · ")} · prices as of ${day}` : parts.join(" · ");
}

export const BILLING_OPTIONS: ReadonlyArray<{ value: ProviderBilling; label: string }> = [
  { value: "usage", label: "Pay per use" },
  { value: "plan", label: "Subscription or plan" },
  { value: "free", label: "Free" }
];

const LIST_NAMES = { litellm: "LiteLLM", modelsDev: "models.dev" } as const;

/** The Prices section's line on the data: its newest date and the lists in
 *  use, or that there is none yet. */
export function priceDataLine(status: { litellmDate: string | null; modelsDevDate: string | null }): string {
  const lists = (["litellm", "modelsDev"] as const).filter((list) => Boolean(status[`${list}Date`]));
  if (!lists.length) return "No price data yet";
  const newest = shortDay(lists.map((list) => status[`${list}Date`]!).sort().at(-1));
  return `Price data from ${newest} (${lists.map((list) => LIST_NAMES[list]).join(", ")})`;
}
