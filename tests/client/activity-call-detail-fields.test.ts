import { describe, expect, test } from "bun:test";
import type { LlmCallDetailDto } from "@shared/api-contracts";
import { buildCallDetailFields } from "@/routes/activity/call-detail-fields";

/**
 * The panel's field list, which is also the list `retention.ts` keeps
 * `metadata_json` keys alive for. That guard cites this reader by name; if
 * nothing exercises the reader, the guard is pinning keys for a behaviour
 * no test would notice losing.
 */

function detail(overrides: Partial<LlmCallDetailDto> = {}): LlmCallDetailDto {
  return {
    id: "llm_1",
    purpose: "agent_wake_step",
    scopeType: "agent_thread",
    scopeId: "thread-1",
    provider: "openai-compatible",
    model: "codex/gpt-5.6-sol",
    baseURL: null,
    apiMode: null,
    requestHash: "req-hash",
    responseHash: "res-hash",
    request: null,
    response: null,
    output: null,
    usage: null,
    metadata: null,
    inputTokens: 9_371,
    outputTokens: 284,
    totalTokens: 9_655,
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
  } as LlmCallDetailDto;
}

/** Read as pairs, so a value that moved to a neighbouring label cannot pass by
 *  being present somewhere in the list. */
const pairs = (call: LlmCallDetailDto) =>
  buildCallDetailFields(call).map((field) => `${field.label}=${field.value}`);

describe("buildCallDetailFields", () => {
  test("carries what the log row stopped showing", () => {
    // provider and model are usually one value across the whole log, which is why
    // they are not columns; this is where they went.
    expect(pairs(detail({ metadata: { phase: "delivering", api: "responses" } }))).toEqual([
      "API=Responses",
      "model=codex/gpt-5.6-sol",
      "scope=agent_thread · thread-1",
      "phase=delivering",
      "request hash=req-hash",
      "response hash=res-hash"
    ]);
  });

  test("shows the recorded provider name and the API the call spoke, not the internal family", () => {
    const fields = pairs(detail({ providerName: "provider-1", metadata: { api: "chat" } }));
    expect(fields).toContain("provider name=provider-1");
    expect(fields).toContain("API=Chat");
    expect(fields.some((field) => field.startsWith("provider type="))).toBe(false);
    expect(pairs(detail()).some((field) => field.startsWith("provider name="))).toBe(false);
  });

  test("identifiers read in mono", () => {
    const fields = buildCallDetailFields(detail());
    const mono = (label: string) => fields.find((field) => field.label === label)?.mono;
    expect(mono("model")).toBe(true);
    expect(mono("request hash")).toBe(true);
  });

  test("a call grows no empty rows", () => {
    const fields = pairs(detail());
    expect(fields.some((field) => field.startsWith("phase="))).toBe(false);
  });

  test("optional identity fields appear only when the call has them", () => {
    const fields = pairs(
      detail({ baseURL: "https://api.example.test/v1" })
    );
    expect(fields).toContain("base url=https://api.example.test/v1");
  });
});
