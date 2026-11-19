import { expect, test } from "bun:test";
import { apiLabelForCall } from "@/routes/activity/format";
import { buildModelOptions, buildPurposeOptions } from "@/routes/activity/logs/model-options";

// Activity names the API a call spoke, as recorded with the call, and offers
// the log's model filter by the provider's name from Settings.

const call = (over: Partial<{ provider: string | null; apiMode: string; metadata: Record<string, unknown> | null }>) =>
  ({ provider: "openai-compatible", apiMode: "streamText", metadata: null, ...over });

test("apiLabelForCall: the recorded API, else nothing", () => {
  expect(apiLabelForCall(call({ metadata: { api: "messages" } }))).toBe("Messages");
  expect(apiLabelForCall(call({ metadata: { api: "responses" } }))).toBe("Responses");
  expect(apiLabelForCall(call({ metadata: { api: "chat" } }))).toBe("Chat");
  expect(apiLabelForCall(call({ metadata: { api: "gemini" } }))).toBe("Gemini");
  // A call that recorded none says none, whatever its family.
  expect(apiLabelForCall(call({ provider: "anthropic" }))).toBe("");
  expect(apiLabelForCall(call({ provider: "openai-compatible" }))).toBe("");
  expect(apiLabelForCall(call({ apiMode: "decisions", metadata: { api: "responses" } }))).toBe("Decisions");
});

test("buildModelOptions: the log's model filter names the provider as Settings does", () => {
  const row = (id: string, provider: string, providerName: string, model: string) =>
    ({ id, provider, providerName, model }) as never;
  const options = buildModelOptions([
    row("a", "anthropic", "provider-1", "vendor/claude"),
    row("b", "openai-compatible", "kilo", "vendor/gpt"),
    row("c", "openai-compatible", "provider-1", "vendor/gpt"),
    row("d", "openai-compatible", "openai-compatible", "vendor/old")
  ], null, null);
  expect(options.map((o) => o.label)).toEqual([
    "Any model",
    "provider-1 / vendor/claude",
    "kilo / vendor/gpt",
    "provider-1 / vendor/gpt",
    "openai-compatible / vendor/old"
  ]);
});

test("buildModelOptions: every model the log has, most recently used first, then any the loaded rows add", () => {
  const row = (id: string, providerName: string, model: string) =>
    ({ id, provider: "openai-compatible", providerName, model }) as never;
  const options = buildModelOptions(
    [row("a", "gateway", "vendor/new"), row("b", "gateway", "vendor/fast")],
    "mirror", "vendor/fast",
    [{ provider: "gateway", model: "vendor/fast" }, { provider: "gateway", model: "vendor/old" }, { provider: "mirror", model: "vendor/fast" }]
  );
  // The chosen one leads, then the server's list in its order, then what only the rows hold.
  expect(options.map((o) => o.label)).toEqual([
    "Any model",
    "mirror / vendor/fast",
    "gateway / vendor/fast",
    "gateway / vendor/old",
    "gateway / vendor/new"
  ]);
});

test("buildPurposeOptions: every purpose the log has, then any the loaded rows add", () => {
  const row = (purpose: string) => ({ purpose }) as never;
  const options = buildPurposeOptions([row("agent_wake_step"), row("page_update")], null, ["memory_dream", "agent_wake_step"]);
  expect(options.map((o) => o.label)).toEqual(["Any purpose", "memory_dream", "agent_wake_step", "page_update"]);
});
