import { expect, test } from "bun:test";
import type { ActivityGroupDto, ActivitySpendDto, LlmCallSummaryDto } from "@shared/api-contracts";
import type { CallCostDto, PriceMatchDto } from "@shared/api/pricing";
import { costDetail, costLabel, formatUsd, groupSpendLabel, spendLine, spendValue } from "@/routes/activity/money";
import { LogRow } from "@/routes/activity/logs/LogRow";
import { mountAsync } from "../helpers/mount.js";

const cost = (x: Partial<CallCostDto>): CallCostDto => ({
  source: "list", micros: 41_200, apiMicros: null, priceProvider: null, priceModel: null,
  priceOrigin: null, dataDate: null, reportedBy: null, note: null, ...x
});

test("amounts: four decimals below ten cents, two below a thousand, none above", () => {
  expect(formatUsd(41_200, false)).toBe("$0.0412");
  expect(formatUsd(12_400_000, true)).toBe("~$12.40");
  expect(formatUsd(8_100_000, false)).toBe("$8.10");
  expect(formatUsd(3_456_000_000, true)).toBe("~$3,456");
});

test("a call's amount by its source", () => {
  expect(costLabel(cost({ source: "reported" }))).toBe("$0.0412");
  for (const source of ["your_price", "price_as", "list", "catalog"] as const) expect(costLabel(cost({ source }))).toBe("~$0.0412");
  expect(costLabel(cost({ source: "included", micros: null }))).toBe("Included");
  expect(costLabel(cost({ source: "free", micros: null }))).toBe("Free");
  expect(costLabel(cost({ source: "unpriced", micros: null }))).toBe("Unpriced");
  expect(costLabel(cost({ source: "none", micros: null }))).toBe("");
  expect(costLabel(null)).toBe("");
});

const ctx = { model: "openai/gpt-6.1-sol", providerName: "gw", suggestion: null as PriceMatchDto | null };

test("detail lines say where the cost came from", () => {
  expect(costDetail(cost({ source: "reported", reportedBy: "OpenRouter" }), ctx).lines).toEqual(["Reported by OpenRouter"]);
  expect(costDetail(cost({ source: "your_price" }), ctx).lines).toEqual(["Estimated at your price"]);
  expect(costDetail(cost({ source: "list", priceProvider: "Anthropic", priceOrigin: "litellm", dataDate: "2026-10-21" }), ctx).lines)
    .toEqual(["Estimated at Anthropic's list price · prices as of Oct 21"]);
  expect(costDetail(cost({ source: "price_as", priceProvider: "Anthropic", priceOrigin: "litellm", dataDate: "2026-10-21" }), ctx).lines)
    .toEqual(["Estimated at Anthropic's list price · prices as of Oct 21"]);
  expect(costDetail(cost({ source: "catalog", priceOrigin: "models.dev", dataDate: "2026-10-21" }), ctx).lines)
    .toEqual(["Estimated from models.dev · less certain · prices as of Oct 21"]);
  expect(costDetail(cost({ source: "price_as", priceOrigin: "models.dev", dataDate: "2026-10-21" }), ctx).lines)
    .toEqual(["Estimated from models.dev · less certain · prices as of Oct 21"]);
  expect(costDetail(cost({ source: "list", priceProvider: "Fill", priceOrigin: "litellm", dataDate: "2026-10-21", note: "no_cache_price" }), ctx).lines)
    .toEqual(["Estimated at Fill's list price · prices as of Oct 21", "No cache price for this model; cache tokens counted at the input price"]);
  expect(costDetail(cost({ source: "included", micros: null, apiMicros: 40_000 }), ctx).lines).toEqual(["Included in your plan · about $0.0400 at API prices"]);
  expect(costDetail(cost({ source: "included", micros: null }), ctx).lines).toEqual(["Included in your plan"]);
  expect(costDetail(cost({ source: "free", micros: null }), ctx).lines).toEqual(["Marked free in Settings"]);
  expect(costDetail(cost({ source: "unpriced", micros: null, note: "failed_no_usage" }), ctx)).toEqual({ lines: ["The call failed before the provider reported its usage."], action: null });
});

test("an unpriced call names what has no price, offers Set a price, and its suggestion", () => {
  const plain = costDetail(cost({ source: "unpriced", micros: null }), ctx);
  expect(plain.lines).toEqual(["No price for openai/gpt-6.1-sol on gw"]);
  expect(plain.action).toEqual({ label: "Set a price", href: "/settings?tab=providers&provider=gw&model=openai%2Fgpt-6.1-sol" });
  const suggestion: PriceMatchDto = { ref: "litellm:gpt-6.1-sol", label: "OpenAI gpt-6.1-sol", origin: "litellm", rates: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5, cacheWrite1h: null }, dataDate: "2026-10-15" };
  expect(costDetail(cost({ source: "unpriced", micros: null }), { ...ctx, suggestion }).lines).toEqual(["No price for openai/gpt-6.1-sol on gw", "Looks like OpenAI gpt-6.1-sol."]);
});

const SPEND: ActivitySpendDto = { micros: 12_400_000, reportedMicros: 8_100_000, estimated: true, pricedCalls: 40, unpricedCalls: 3, includedCalls: 120, includedApiMicros: 45_000_000, pendingCalls: 1234 };

test("the Spend tile's second line leaves out the parts that are zero", () => {
  expect(spendLine(SPEND)).toBe("$8.10 reported · 3 calls unpriced · 120 included · 1,234 calls not priced yet");
  expect(spendLine({ ...SPEND, reportedMicros: 0, unpricedCalls: 1, includedCalls: 0, pendingCalls: 0 })).toBe("1 call unpriced");
  expect(spendLine({ ...SPEND, reportedMicros: 0, unpricedCalls: 0, includedCalls: 0, pendingCalls: 0 })).toBe("");
});

test("the Spend tile's figure: an amount once a call has one; Unpriced or a dash while none has", () => {
  expect(spendValue(SPEND)).toBe("~$12.40");
  const none = { ...SPEND, micros: 0, reportedMicros: 0, estimated: false, pricedCalls: 0 };
  expect(spendValue({ ...none, unpricedCalls: 3, pendingCalls: 0 })).toBe("Unpriced");
  expect(spendValue({ ...none, unpricedCalls: 0, pendingCalls: 1234 })).toBe("—");
  expect(spendValue({ ...none, unpricedCalls: 3, pendingCalls: 1234 })).toBe("Unpriced");
  // Nothing to price, or only calls a plan covers or that are free: nothing spent.
  expect(spendValue({ ...none, unpricedCalls: 0, pendingCalls: 0 })).toBe("$0.0000");
  // A reported charge of $0 is an amount.
  expect(spendValue({ ...none, pricedCalls: 1, unpricedCalls: 3 })).toBe("$0.0000");
});

const group = (x: Partial<ActivityGroupDto>): ActivityGroupDto => ({
  key: "g", label: "g", calls: 10, failed: 0, p50Ms: 1, p95Ms: 1, p99Ms: 1, maxMs: 1, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
  fallbackCalls: 0, reasons: [], spendMicros: 0, spendEstimated: false, unpricedCalls: 0, ...x
});

test("a group's spend cell", () => {
  expect(groupSpendLabel(group({ spendMicros: 4_200_000, spendEstimated: true }))).toBe("~$4.20");
  expect(groupSpendLabel(group({ spendMicros: 4_200_000 }))).toBe("$4.20");
  expect(groupSpendLabel(group({ unpricedCalls: 2 }))).toBe("Unpriced");
  expect(groupSpendLabel(group({}))).toBe("—");
});

test("a log row ends with the call's amount, on one line", async () => {
  const row: LlmCallSummaryDto = {
    id: "llm_1", purpose: "agent_wake_step", scopeType: "agent_thread", scopeId: "t",
    providerName: null, provider: "openai-compatible", model: "m", baseURL: null, apiMode: null, requestHash: "", responseHash: "",
    request: null, response: null, output: null, usage: null, metadata: null, inputTokens: 1000, outputTokens: 10,
    totalTokens: 1010, reasoningTokens: null, cacheReadTokens: null, cacheWriteTokens: null, status: "succeeded",
    error: null, startedAt: "2026-08-03T11:42:10.000Z", finishedAt: "2026-08-03T11:42:12.000Z", latencyMs: 2000, ttftMs: 500,
    createdAt: "2026-08-03T11:42:10.000Z", updatedAt: "2026-08-03T11:42:12.000Z", cost: cost({ source: "list" })
  };
  const { host } = await mountAsync(<ul><LogRow call={row} nowMs={Date.parse("2026-08-03T12:00:00.000Z")} selected={false} onOpen={() => {}} /></ul>);
  const amount = host.querySelector("[data-log-cost]");
  expect(amount?.textContent).toBe("~$0.0412");
  expect(amount?.classList.contains("whitespace-nowrap")).toBe(true);
  const unpriced = await mountAsync(<ul><LogRow call={{ ...row, cost: cost({ source: "unpriced", micros: null }) }} nowMs={Date.parse("2026-08-03T12:00:00.000Z")} selected={false} onOpen={() => {}} /></ul>);
  expect(unpriced.host.querySelector("[data-log-cost]")?.textContent).toBe("Unpriced");
  const pending = await mountAsync(<ul><LogRow call={{ ...row, cost: null }} nowMs={Date.parse("2026-08-03T12:00:00.000Z")} selected={false} onOpen={() => {}} /></ul>);
  expect(pending.host.querySelector("[data-log-cost]") === null).toBe(true);
});

test("the call detail shows the amount, where it came from, and Set a price", async () => {
  const { CostBlock } = await import("@/routes/activity/CallDetailPanel");
  const { MemoryRouter } = await import("react-router");
  const detail = {
    id: "llm_1", purpose: "agent_wake_step", scopeType: null, scopeId: null,
    providerName: "gw", provider: "openai-compatible", model: "openai/gpt-6.1-sol", baseURL: null, apiMode: null, requestHash: "", responseHash: "",
    request: null, response: null, output: null, usage: null, metadata: { providerName: "gw" }, inputTokens: 1, outputTokens: 1,
    totalTokens: 2, reasoningTokens: null, cacheReadTokens: null, cacheWriteTokens: null, status: "succeeded", error: null,
    startedAt: null, finishedAt: null, latencyMs: null, ttftMs: null, createdAt: "2026-08-03T11:42:10.000Z", updatedAt: "2026-08-03T11:42:10.000Z",
    cost: cost({ source: "unpriced", micros: null }),
    priceSuggestion: { ref: "litellm:gpt-6.1-sol", label: "OpenAI gpt-6.1-sol", origin: "litellm", rates: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5, cacheWrite1h: null }, dataDate: null }
  } as const;
  const { host } = await mountAsync(<MemoryRouter><CostBlock detail={detail as never} /></MemoryRouter>);
  const block = host.querySelector("[data-call-cost]")!;
  expect(block.textContent).toContain("Unpriced");
  expect(block.textContent).toContain("No price for openai/gpt-6.1-sol on gw");
  expect(block.textContent).toContain("Looks like OpenAI gpt-6.1-sol.");
  expect(block.querySelector("a")?.getAttribute("href")).toBe("/settings?tab=providers&provider=gw&model=openai%2Fgpt-6.1-sol");
  const none = await mountAsync(<MemoryRouter><CostBlock detail={{ ...detail, cost: null } as never} /></MemoryRouter>);
  expect(none.host.querySelector("[data-call-cost]") === null).toBe(true);
});
