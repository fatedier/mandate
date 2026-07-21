import { describe, expect, test } from "bun:test";
import type { LlmCallDetailDto } from "@shared/api-contracts";
import { buildCallDetailFields } from "@/routes/activity/call-detail-fields";

/**
 * The panel's field list, which is also the list `retention.ts` keeps
 * `metadata_json` keys alive for. That guard cites this reader by name; if
 * nothing exercises the reader, the guard is pinning keys for a behaviour
 * no test would notice losing.
 */

const FEATURE_EVENT = {
  type: "feature_event",
  kind: "completion",
  taskId: "task-1",
  featureId: "feat-1",
  workItemId: "wi-1",
  source: {
    project: { id: "proj-1", name: "Mandate" },
    feature: { id: "feat-1", name: "Event source display" },
    workItem: { id: "wi-1", title: "Implement source labels" },
    capturedAt: "2026-05-28T00:00:00Z"
  },
  label: "Implement source labels"
};

function detail(overrides: Partial<LlmCallDetailDto> = {}): LlmCallDetailDto {
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
    // provider and model are one value across the last 500 calls, which is why
    // they are not columns; this is where they went.
    expect(pairs(detail({ metadata: { phase: "delivering" } }))).toEqual([
      "provider type=openai-compatible",
      "model=codex/gpt-5.6-sol",
      "scope=agent_thread · thread-1",
      "phase=delivering",
      "request hash=req-hash",
      "response hash=res-hash"
    ]);
  });

  test("shows the recorded provider name separately from its API type", () => {
    const fields = pairs(detail({ metadata: { providerName: "nova" } }));
    expect(fields).toContain("provider name=nova");
    expect(fields).toContain("provider type=openai-compatible");
    expect(pairs(detail()).some((field) => field.startsWith("provider name="))).toBe(false);
  });

  test("identifies a legacy provider name as a match from current configuration", () => {
    const fields = pairs(detail({ metadata: null, matchedProviderName: "llm-proxy" }));
    expect(fields).toContain("provider name (current config)=llm-proxy");
    expect(fields).toContain("provider type=openai-compatible");
  });

  test("reads the feature event through the helper the retention guard names", () => {
    const fields = pairs(detail({ metadata: { featureEvents: [FEATURE_EVENT] } }));
    expect(fields).toContain("feature event=completed · Implement source labels");
    expect(fields).toContain("source=Mandate / Event source display");
  });

  test("finds a feature event nested under wakeMetadata too", () => {
    // The recorder writes it both ways, and retention keeps both paths.
    const fields = pairs(
      detail({ metadata: { wakeMetadata: { featureEvents: [FEATURE_EVENT] } } })
    );
    expect(fields).toContain("feature event=completed · Implement source labels");
    expect(fields).toContain("source=Mandate / Event source display");
  });

  test("a call with no feature event grows no empty rows for one", () => {
    const fields = pairs(detail());
    expect(fields.some((field) => field.startsWith("feature event="))).toBe(false);
    expect(fields.some((field) => field.startsWith("source="))).toBe(false);
    expect(fields.some((field) => field.startsWith("phase="))).toBe(false);
  });

  test("tokens are not a field — they are two containments, rendered apart", () => {
    // Kept as a test rather than deleted: a later hand adding `tokens` back to
    // this list would silently give the panel the truncated one-cell version
    // again, on top of the block.
    expect(pairs(detail({})).some((field) => field.startsWith("tokens="))).toBe(false);
  });

  test("optional identity fields appear only when the call has them", () => {
    const fields = pairs(
      detail({ parentCallId: "llm_parent", baseURL: "https://api.example.test/v1" })
    );
    expect(fields).toContain("parent=llm_parent");
    expect(fields).toContain("base url=https://api.example.test/v1");
  });
});
