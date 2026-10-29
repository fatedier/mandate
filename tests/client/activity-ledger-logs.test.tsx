import { expect, test } from "bun:test";
import { MemoryRouter } from "react-router";
import type { CacheVerdictDto, LlmCallLedgerDto, LlmCallSummaryDto } from "@shared/api-contracts";
import { LogRow } from "@/routes/activity/logs/LogRow";
import { CallLedgerFields, CostBlock } from "@/routes/activity/CallDetailPanel";
import { VerdictBox } from "@/routes/activity/VerdictBox";
import { rowVerdictLine, threadLine, verdictSentence } from "@/routes/activity/ledger-copy";
import { mountAsync } from "../helpers/mount.js";

const EXPIRED: CacheVerdictDto = {
  kind: "expired", idleMs: 1_449_000, sinceStartMs: 1_461_000, rewrittenTokens: 164_249, extraMicros: 790_000,
  lifetimeMs: 300_000, requestedLifetimeMs: 3_600_000, writtenLifetimeMs: null, rebuildCause: null, previousModel: "anthropic/claude-test"
};
const LEDGER: LlmCallLedgerDto = { role: "managers", threadTitle: "Invented title", threadDeleted: false, inThread: true, wakeKey: "worker_reports", link: { to: "thread", threadId: "thread-1" }, verdict: EXPIRED };

function call(overrides: Partial<LlmCallSummaryDto> = {}): LlmCallSummaryDto {
  return {
    id: "llm_1", purpose: "agent_wake_step", scopeType: "agent_thread", scopeId: "thread-1",
    providerName: null, provider: "openai-compatible", model: "anthropic/claude-test", baseURL: null, apiMode: null, requestHash: "req", responseHash: "res",
    request: null, response: null, output: null, usage: null, metadata: null,
    inputTokens: 165_630, outputTokens: 434, totalTokens: 166_064, reasoningTokens: null, cacheReadTokens: 0, cacheWriteTokens: 165_626,
    status: "succeeded", error: null, startedAt: "2026-08-03T11:42:10.000Z", finishedAt: "2026-08-03T11:42:18.200Z", latencyMs: 8_200, ttftMs: null,
    createdAt: "2026-08-03T11:42:10.000Z", updatedAt: "2026-08-03T11:42:18.200Z",
    cost: { source: "list", micros: 836_826, apiMicros: null, priceProvider: "Anthropic", priceModel: "claude-test", priceOrigin: "litellm", dataDate: "2026-01-02", reportedBy: null, note: null },
    ledger: LEDGER,
    ...overrides
  };
}

test("the row's copy: its thread, and why it paid again", () => {
  expect(rowVerdictLine(EXPIRED, "worker_reports")).toBe("idle 24m 09s before · Worker reports · ~$0.79 extra");
  expect(rowVerdictLine({ ...EXPIRED, extraMicros: null }, null)).toBe("idle 24m 09s before");
  expect(threadLine(LEDGER)).toBe("Manager · Invented title");
  expect(threadLine({ ...LEDGER, role: "workers" })).toBe("Worker · Invented title");
  expect(threadLine({ ...LEDGER, role: "your_agent", threadTitle: null })).toBe("Your agent");
  expect(threadLine({ ...LEDGER, role: "managers", threadTitle: null, threadDeleted: true })).toBe("Deleted thread");
  expect(threadLine({ ...LEDGER, role: "dream", threadTitle: null })).toBe("Dream");
});

test("an hour asked for and five minutes written is said so", () => {
  expect(verdictSentence({ ...EXPIRED, writtenLifetimeMs: 300_000 }, "anthropic/claude-test")).toBe(
    "This thread's previous call started 24m 21s before this one, and Claude keeps a cache for 5 minutes from the start of a call. 164,249 tokens were written to the cache again instead of read: ~$0.79 more than reading them. Mandate asked for a 1-hour cache; the provider wrote it for 5 minutes."
  );
  // Unreported, or written as asked: nothing more to say.
  expect(verdictSentence(EXPIRED, "anthropic/claude-test").includes("Mandate asked")).toBe(false);
  expect(verdictSentence({ ...EXPIRED, lifetimeMs: 3_600_000, writtenLifetimeMs: 3_600_000 }, "anthropic/claude-test").includes("Mandate asked")).toBe(false);
});

test("each verdict's sentence", () => {
  expect(verdictSentence(EXPIRED, "anthropic/claude-test")).toBe(
    "This thread's previous call started 24m 21s before this one, and Claude keeps a cache for 5 minutes from the start of a call. 164,249 tokens were written to the cache again instead of read: ~$0.79 more than reading them."
  );
  expect(verdictSentence({ ...EXPIRED, lifetimeMs: 3_600_000, extraMicros: null }, "anthropic/claude-test")).toBe(
    "This thread's previous call started 24m 21s before this one, and Claude keeps a cache for 1 hour from the start of a call. 164,249 tokens were written to the cache again instead of read."
  );
  expect(verdictSentence({ ...EXPIRED, kind: "miss", idleMs: 120_000, sinceStartMs: 150_000 }, "anthropic/claude-test")).toBe(
    "This thread's previous call started 2m 30s before this one, within the cache's lifetime, but 164,249 tokens of its prompt were not read from the cache."
  );
  expect(verdictSentence({ ...EXPIRED, kind: "not_reused", idleMs: 7_200_000, lifetimeMs: null }, "openai/gpt-test")).toBe(
    "This thread's previous call ended 2h 00m before this one. openai/gpt-test keeps no fixed cache time, and 164,249 tokens of its prompt were not read from the cache."
  );
  expect(verdictSentence({ ...EXPIRED, kind: "rebuild", rebuildCause: "compaction" }, "x")).toBe(
    "The thread was compacted just before this call, so its prompt was new and written to the cache."
  );
  expect(verdictSentence({ ...EXPIRED, kind: "rebuild", rebuildCause: "model", previousModel: "deepseek/deepseek-test" }, "x")).toBe(
    "The thread's previous call ran on deepseek/deepseek-test, so this model had no cache to read."
  );
  // The same model through another connection: a connection change, said so.
  expect(verdictSentence({ ...EXPIRED, kind: "rebuild", rebuildCause: "model", previousModel: "openai/gpt-test" }, "openai/gpt-test")).toBe(
    "The thread's previous call went through another connection, so this one had no cache to read."
  );
  // A version written with a dot by a gateway and a dash by the provider.
  expect(verdictSentence({ ...EXPIRED, kind: "rebuild", rebuildCause: "model", previousModel: "claude-sonnet-4-6" }, "anthropic/claude-sonnet-4.6")).toBe(
    "The thread's previous call went through another connection, so this one had no cache to read."
  );
  // A gateway's prefixed id and the provider's bare one name the same model, whatever their case.
  expect(verdictSentence({ ...EXPIRED, kind: "rebuild", rebuildCause: "model", previousModel: "MiniMax-M2.5" }, "minimax/minimax-m2.5")).toBe(
    "The thread's previous call went through another connection, so this one had no cache to read."
  );
  expect(verdictSentence({ ...EXPIRED, kind: "rebuild", rebuildCause: "model", previousModel: "openai/gpt-test" }, "gpt-test")).toBe(
    "The thread's previous call went through another connection, so this one had no cache to read."
  );
});

test("a row with a verdict has a chip, its thread and a third line", async () => {
  const { host } = await mountAsync(<ul><LogRow call={call()} nowMs={Date.parse("2026-08-03T12:00:00.000Z")} selected={false} onOpen={() => {}} /></ul>);
  expect(host.querySelector("[data-log-verdict-chip]")?.textContent).toBe("Cache expired");
  expect(host.querySelector("[data-log-thread]")?.textContent).toBe("Manager · Invented title");
  expect(host.querySelector("[data-log-verdict]")?.textContent).toBe("idle 24m 09s before · Worker reports · ~$0.79 extra");
});

test("a row without a verdict keeps two lines", async () => {
  const { host } = await mountAsync(<ul><LogRow call={call({ ledger: { ...LEDGER, verdict: null } })} nowMs={Date.parse("2026-08-03T12:00:00.000Z")} selected={false} onOpen={() => {}} /></ul>);
  expect(host.querySelector("[data-log-verdict]") === null).toBe(true);
  expect(host.querySelector("[data-log-verdict-chip]") === null).toBe(true);
  expect(host.querySelector("[data-log-thread]")?.textContent).toBe("Manager · Invented title");
});

test("the call detail explains the verdict and splits the cost", async () => {
  const box = await mountAsync(<VerdictBox verdict={EXPIRED} model="anthropic/claude-test" />);
  expect(box.host.querySelector("[data-call-verdict]")?.textContent).toContain("Cache expired");
  expect(box.host.textContent).toContain("~$0.79 more than reading them.");
  const detail = { ...call(), request: null, response: null, output: null, usage: null, error: null, priceSuggestion: null,
    tokenSplit: { rows: [{ kind: "cache_write", tokens: 165_626, micros: 828_130 }, { kind: "output", tokens: 434, micros: 8_680 }, { kind: "uncached_input", tokens: 4, micros: 16 }] } };
  const cost = await mountAsync(<MemoryRouter><CostBlock detail={detail as never} /></MemoryRouter>);
  const rows = Array.from(cost.host.querySelectorAll("[data-cost-split-row]")).map((r) => r.textContent);
  expect(rows).toEqual(["Cache write165,626~$0.83", "Output434~$0.0087", "Uncached input4<$0.0001"]);
  const fields = await mountAsync(<MemoryRouter><CallLedgerFields detail={detail as never} /></MemoryRouter>);
  expect(fields.host.textContent).toContain("Manager · Invented title");
  expect(fields.host.textContent).toContain("Worker reports");
  expect(fields.host.querySelector("a")?.getAttribute("href")).toBe("/threads/thread-1");
});

test("a call that belongs to no thread names its agent, not a thread", async () => {
  const detail = { ...call({ ledger: { ...LEDGER, role: "dream", threadTitle: null, inThread: false, link: null, wakeKey: null } }), request: null, response: null, output: null, usage: null, error: null, priceSuggestion: null, tokenSplit: null };
  const fields = await mountAsync(<MemoryRouter><CallLedgerFields detail={detail as never} /></MemoryRouter>);
  expect(fields.host.textContent).toContain("agentDream");
  expect(fields.host.textContent).not.toContain("thread");
  // One in a thread keeps the thread, a subagent's untitled one with no page to open included.
  const inThread = await mountAsync(<MemoryRouter><CallLedgerFields detail={{ ...detail, ledger: LEDGER } as never} /></MemoryRouter>);
  expect(inThread.host.textContent).toContain("threadManager · Invented title");
  const subagent = await mountAsync(<MemoryRouter><CallLedgerFields detail={{ ...detail, ledger: { ...LEDGER, role: "subagents", threadTitle: null, link: null } } as never} /></MemoryRouter>);
  expect(subagent.host.textContent).toContain("threadSubagent");
  // A subagent's thread compacting is a thread's call too: the server says so.
  const compaction = await mountAsync(<MemoryRouter><CallLedgerFields detail={{ ...detail, ledger: { ...LEDGER, role: "compaction", threadTitle: null, link: null, inThread: true } } as never} /></MemoryRouter>);
  expect(compaction.host.textContent).toContain("threadCompaction");
});

test("the thread link goes where the thread lives", async () => {
  const base = { ...call(), request: null, response: null, output: null, usage: null, error: null, priceSuggestion: null, tokenSplit: null };
  const linkFor = async (link: LlmCallLedgerDto["link"]) => {
    const fields = await mountAsync(<MemoryRouter><CallLedgerFields detail={{ ...base, ledger: { ...LEDGER, link } } as never} /></MemoryRouter>);
    return fields.host.querySelector("a")?.getAttribute("href") ?? null;
  };
  expect(await linkFor({ to: "worker", threadId: "t-manager", workerId: "feat-1" })).toBe("/threads/t-manager?worker=feat-1");
  expect(await linkFor({ to: "agent" })).toBe("/agent");
  expect(await linkFor(null)).toBeNull();
});
