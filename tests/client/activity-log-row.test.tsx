import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { LlmCallSummaryDto } from "@shared/api-contracts";
import { LogRow } from "@/routes/activity/logs/LogRow";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LOADED_AT = Date.parse("2026-08-03T12:00:00.000Z");

function call(overrides: Partial<LlmCallSummaryDto> = {}): LlmCallSummaryDto {
  return {
    id: "llm_1",
    purpose: "agent_wake_step",
    scopeType: "agent_thread",
    scopeId: "thread-1",
    parentCallId: null,
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

let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

async function renderRow(value: LlmCallSummaryDto, selected = false): Promise<HTMLElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <ul>
        <LogRow call={value} nowMs={LOADED_AT} selected={selected} onOpen={() => {}} />
      </ul>
    );
  });
  return container;
}

test("a call shows its model, purpose and readings without an unknown provider name", async () => {
  const page = await renderRow(call());
  expect(page.querySelector("[data-log-model]")?.textContent).toBe("codex/gpt-5.6-sol");
  expect(page.querySelector("[data-log-provider]")).toBeNull();
  expect(page.querySelector("[data-log-purpose]")?.textContent).toBe("agent_wake_step");
  expect(page.querySelector("time")?.textContent).toBe("17m ago");
  expect(page.querySelector("[data-log-duration]")?.textContent).toBe("18s");
  expect(page.querySelector("[data-log-tokens]")?.textContent).toBe("50.3k → 284 tokens");
  expect(page.querySelector("[data-log-rate]")?.textContent).toBe("15.9 tok/s");
  expect(page.querySelector("[data-log-cache]")?.textContent).toBe("81% cache");
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
});

test("shows the configured provider name without its API type", async () => {
  const page = await renderRow(call({ metadata: { providerName: "nova" } }));
  const provider = page.querySelector("[data-log-provider]");
  expect(provider?.textContent).toBe("nova");
  expect(provider?.getAttribute("title")).toBe("nova");
});

test("invalid provider name metadata omits the provider label", async () => {
  const page = await renderRow(call({ metadata: { providerName: 123 } }));
  expect(page.querySelector("[data-log-provider]")).toBeNull();
});

test("legacy calls display a matched name and identify its source in the tooltip", async () => {
  const page = await renderRow(call({ metadata: null, matchedProviderName: "llm-proxy" }));
  const provider = page.querySelector("[data-log-provider]");
  expect(provider?.textContent).toBe("llm-proxy");
  expect(provider?.getAttribute("title")).toBe(
    "llm-proxy (matched to current configuration)"
  );
});
