import type { ActivityGroupDto, ActivitySpendDto, LedgerMoneyKind } from "@shared/api-contracts";
import type { CallCostDto, PriceMatchDto } from "@shared/api/pricing";

/** Micro-dollars as money: four decimals under ten cents (a single call),
 *  two under a thousand, none above; `~` when it is an estimate. */
export function formatUsd(micros: number, estimated: boolean): string {
  const usd = micros / 1_000_000;
  const text = usd < 0.1
    ? usd.toFixed(4)
    : usd < 1000
      ? usd.toFixed(2)
      : Math.round(usd).toLocaleString("en-US");
  return `${estimated ? "~" : ""}$${text}`;
}

const ESTIMATES = new Set<CallCostDto["source"]>(["your_price", "price_as", "list", "catalog"]);

/** A call's amount where a list shows it; empty when it has none to show. */
export function costLabel(cost: CallCostDto | null): string {
  if (!cost) return "";
  switch (cost.source) {
    case "reported": return formatUsd(cost.micros ?? 0, false);
    case "included": return "Included";
    case "free": return "Free";
    case "unpriced": return "Unpriced";
    case "none": return "";
    default: return ESTIMATES.has(cost.source) ? formatUsd(cost.micros ?? 0, true) : "";
  }
}

/** "2026-10-21" as "Oct 21". */
function shortDate(day: string | null): string {
  if (!day) return "";
  const date = new Date(`${day}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function asOf(day: string | null): string {
  const date = shortDate(day);
  return date ? ` · prices as of ${date}` : "";
}

/** Where a call's model gets its price set in Settings. */
export function priceSettingsHref(providerName: string, model: string): string {
  const params = new URLSearchParams({ tab: "providers", provider: providerName, model });
  return `/settings?${params.toString()}`;
}

/** The lines under a call's amount in its detail: where the amount came
 *  from, and for an Unpriced call what to do about it. */
export function costDetail(
  cost: CallCostDto,
  ctx: { model: string | null; providerName: string; suggestion: PriceMatchDto | null }
): { lines: string[]; action: { label: string; href: string } | null } {
  const lines: string[] = [];
  let action: { label: string; href: string } | null = null;
  switch (cost.source) {
    case "reported":
      lines.push(`Reported by ${cost.reportedBy ?? ctx.providerName}`);
      break;
    case "your_price":
      lines.push("Estimated at your price");
      break;
    case "list":
    case "price_as":
    case "catalog":
      lines.push(cost.priceOrigin === "models.dev" || (cost.source === "catalog" && cost.priceOrigin === null)
        ? `Estimated from models.dev · less certain${asOf(cost.dataDate)}`
        : `Estimated at ${cost.priceProvider ?? "the provider"}'s list price${asOf(cost.dataDate)}`);
      break;
    case "included":
      lines.push(cost.apiMicros !== null
        ? `Included in your plan · about ${formatUsd(cost.apiMicros, false)} at API prices`
        : "Included in your plan");
      break;
    case "free":
      lines.push("Marked free in Settings");
      break;
    case "unpriced":
      if (cost.note === "failed_no_usage") {
        lines.push("The call failed before the provider reported its usage.");
        break;
      }
      lines.push(`No price for ${ctx.model ?? "this model"} on ${ctx.providerName}`);
      if (ctx.suggestion) lines.push(`Looks like ${ctx.suggestion.label}.`);
      if (ctx.model && ctx.providerName) action = { label: "Set a price", href: priceSettingsHref(ctx.providerName, ctx.model) };
      break;
    case "none":
      break;
  }
  if (cost.note === "no_cache_price") lines.push("No cache price for this model; cache tokens counted at the input price");
  return { lines, action };
}

const plural = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** The Spend tile's figure: the total once a call has an amount; while none
 *  has, Unpriced when some cannot be priced, a dash while they wait to be. A
 *  window of calls a plan covers, or free ones, spent nothing. */
export function spendValue(spend: ActivitySpendDto): string {
  if (spend.pricedCalls > 0) return formatUsd(spend.micros, spend.estimated);
  if (spend.unpricedCalls > 0) return "Unpriced";
  if (spend.pendingCalls > 0) return "—";
  return formatUsd(0, false);
}

/** The Spend tile's second line: what the total is made of, the parts that
 *  are zero left out. */
export function spendLine(spend: ActivitySpendDto): string {
  return [
    spend.reportedMicros > 0 ? `${formatUsd(spend.reportedMicros, false)} reported` : "",
    spend.unpricedCalls > 0 ? `${plural(spend.unpricedCalls, "call", "calls")} unpriced` : "",
    spend.includedCalls > 0 ? `${spend.includedCalls.toLocaleString("en-US")} included` : "",
    spend.pendingCalls > 0 ? `${plural(spend.pendingCalls, "call", "calls")} not priced yet` : ""
  ].filter(Boolean).join(" · ");
}

/** A breakdown row's Spend cell. */
export function groupSpendLabel(group: ActivityGroupDto): string {
  if (group.spendMicros > 0 || group.spendEstimated) return formatUsd(group.spendMicros, group.spendEstimated);
  return group.unpricedCalls > 0 ? "Unpriced" : "—";
}

/** A ledger row's money: an amount when its calls cost something, else what
 *  they were. */
export function ledgerMoneyLabel(micros: number, money: LedgerMoneyKind, estimated: boolean): string {
  switch (money) {
    case "spend": return formatUsd(micros, estimated);
    case "included": return "Included";
    case "free": return "Free";
    case "unpriced": return "Unpriced";
    case "none": return "—";
  }
}
