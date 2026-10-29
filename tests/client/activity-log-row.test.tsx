import { expect, test } from "bun:test";
import type { LlmCallSummaryDto } from "@shared/api-contracts";
import { LogRow } from "@/routes/activity/logs/LogRow";
import { mountAsync } from "../helpers/mount.js";

const LOADED_AT = Date.parse("2026-08-03T12:00:00.000Z");

function call(overrides: Partial<LlmCallSummaryDto> = {}): LlmCallSummaryDto {
  return {
    id: "llm_1",
    purpose: "agent_wake_step",
    scopeType: "agent_thread",
    scopeId: "thread-1",
    provider: "openai-compatible",
    model: "codex/gpt-5.6-sol",
    baseURL: null,
    apiMode: null,
    requestHash: "req",
    responseHash: "res",
    metadata: null,
    inputTokens: 50_284,
    outputTokens: 284,
    totalTokens: 50_568,
    reasoningTokens: null,
    cacheReadTokens: 40_913,
    cacheWriteTokens: null,
    status: "succeeded",
    error: null,
    startedAt: "2026-08-03T11:42:10.000Z",
    finishedAt: "2026-08-03T11:42:27.850Z",
    latencyMs: 17_850,
    createdAt: "2026-08-03T11:42:10.000Z",
    updatedAt: "2026-08-03T11:42:27.850Z",
    ...overrides
  } as LlmCallSummaryDto;
}

async function renderRow(value: LlmCallSummaryDto, selected = false): Promise<HTMLElement> {
  const { host } = await mountAsync(
    <ul>
      <LogRow call={value} nowMs={LOADED_AT} selected={selected} onOpen={() => {}} />
    </ul>
  );
  return host;
}

test("a call shows its model, purpose and readings without an unknown provider name or a reason line", async () => {
  const page = await renderRow(call());
  expect(page.querySelector("[data-log-model]")?.textContent).toBe("codex/gpt-5.6-sol");
  expect(page.querySelector("[data-log-provider]") === null).toBe(true);
  expect(page.querySelector("[data-log-purpose]")?.textContent).toBe("agent_wake_step");
  expect(page.querySelector("time")?.textContent).toBe("17m ago");
  // The exact time on hover, written as every other title writes it — not the
  // raw UTC timestamp.
  expect(page.querySelector("time")?.getAttribute("title")).toMatch(/^[A-Z][a-z]{2} \d{1,2}, 2026, \d{2}:\d{2}:10$/);
  expect(page.querySelector("[data-log-duration]")?.textContent).toBe("18s");
  expect(page.querySelector("[data-log-tokens]")?.textContent).toBe("50.3k → 284 tokens");
  expect(page.querySelector("[data-log-rate]")?.textContent).toBe("15.9 tok/s");
  expect(page.querySelector("[data-log-cache]")?.textContent).toBe("81% cache");
  // A call that succeeded has no reason line.
  expect(page.querySelector("[data-log-reason]") === null).toBe(true);
});

test.each(["succeeded", "failed", "running", "pending"])(
  "a %s call shows status only when needed",
  async (status) => {
    const page = await renderRow(call({ status }));
    expect(page.querySelector("[data-log-status]")?.textContent ?? null).toBe(
      status === "succeeded" ? null : status
    );
  }
);

test("a running call is timed against the load, not against its missing latency", async () => {
  const page = await renderRow(
    call({
      status: "running",
      latencyMs: null,
      outputTokens: null,
      finishedAt: null,
      startedAt: "2026-08-03T11:59:30.000Z"
    })
  );
  expect(page.querySelector("[data-log-duration]")?.textContent).toBe("30s");
  expect(page.querySelector("[data-log-rate]")?.textContent).toBe("— tok/s");
  expect(page.querySelector("[data-log-tokens]")?.textContent).toBe("50.3k → — tokens");
});

test.each([0, null])(
  "a cache reading of %s is distinct from missing usage",
  async (cacheReadTokens) => {
    const page = await renderRow(
      call({ cacheReadTokens, inputTokens: cacheReadTokens === null ? null : 50_284 })
    );
    expect(page.querySelector("[data-log-cache]")?.textContent).toBe(
      cacheReadTokens === null ? "— cache" : "0% cache"
    );
  }
);

test("a missing model and provider name stay unknown without showing the API type", async () => {
  const page = await renderRow(call({ model: null }));
  expect(page.querySelector("[data-log-model]")?.textContent).toBe("Unknown model");
  // Words, not an id: the body face.
  const classes = page.querySelector("[data-log-model]")!.className.split(/\s+/);
  expect(classes).toContain("text-sm");
  expect(classes).not.toContain("font-mono");
});

test("shows the configured provider name without its API type", async () => {
  const page = await renderRow(call({ providerName: "provider-1" }));
  const provider = page.querySelector("[data-log-provider]");
  expect(provider?.textContent).toBe("provider-1");
  expect(provider?.getAttribute("title")).toBe("provider-1");
});

// A model id reads in Logs as the Breakdown table writes it:
// mono at 13px, medium weight, still the row's strongest words.
test("a call's model is set as the Breakdown table sets a model: mono, 13px, medium", async () => {
  const page = await renderRow(call());
  const classes = page.querySelector("[data-log-model]")!.className.split(/\s+/);
  for (const name of ["font-mono", "text-xs", "font-medium", "text-foreground"]) expect(classes).toContain(name);
  expect(classes).not.toContain("text-sm");
});

// A failed call's row says why: it has no tokens, so its readings
// were a row of dashes and the reason waited behind a click. The reason is the
// one the detail panel and the Breakdown show, dug out of the SDK's wrapper.
test("a failed call shows its reason and its latency, and no dashed readings", async () => {
  const page = await renderRow(call({
    status: "failed",
    inputTokens: null, outputTokens: null, totalTokens: null, cacheReadTokens: null,
    latencyMs: 39_000,
    error: {
      name: "AI_TypeValidationError",
      message: 'Type validation failed: Value: {"error":{"message":"litellm.APIError: Response API in-stream error","type":null,"param":null,"code":"500"}}.\nError message: [\n  {\n    "code": "invalid_union"'
    }
  }));
  const reason = page.querySelector("[data-log-reason]");
  expect(reason?.textContent).toBe("Response API in-stream error (500)");
  expect(reason?.getAttribute("title")).toBe("Response API in-stream error (500)");
  expect(page.querySelector("[data-log-duration]")?.textContent).toBe("39s");
  expect(page.querySelector("[data-log-tokens]") === null).toBe(true);
  expect(page.querySelector("[data-log-rate]") === null).toBe(true);
  expect(page.querySelector("[data-log-cache]") === null).toBe(true);
  expect(page.textContent).not.toContain("—");
});

test("a failed call with no recorded error still drops the dashes and claims no reason", async () => {
  const page = await renderRow(call({
    status: "failed", inputTokens: null, outputTokens: null, totalTokens: null, cacheReadTokens: null, error: null
  }));
  expect(page.querySelector("[data-log-reason]") === null).toBe(true);
  expect(page.querySelector("[data-log-tokens]") === null).toBe(true);
  expect(page.querySelector("[data-log-duration]")?.textContent).toBe("18s");
});
