import { expect, test } from "bun:test";
import { apiLabelForCall } from "@/routes/activity/format";
import { buildModelOptions } from "@/routes/activity/logs/model-options";

// Activity names the API a call spoke (recorded since calls carry it; for an
// older row, the family it was recorded under where that tells), and offers
// the log's model filter by the provider's name from Settings.

const call = (over: Partial<{ provider: string | null; apiMode: string; metadata: Record<string, unknown> | null }>) =>
  ({ provider: "openai-compatible", apiMode: "streamText", metadata: null, ...over });

test("apiLabelForCall: the recorded API, else what the family tells, else nothing", () => {
  expect(apiLabelForCall(call({ metadata: { api: "messages" } }))).toBe("Messages");
  expect(apiLabelForCall(call({ metadata: { api: "responses" } }))).toBe("Responses");
  expect(apiLabelForCall(call({ metadata: { api: "chat" } }))).toBe("Chat");
  expect(apiLabelForCall(call({ metadata: { api: "gemini" } }))).toBe("Gemini");
  expect(apiLabelForCall(call({ provider: "anthropic" }))).toBe("Messages");
  expect(apiLabelForCall(call({ provider: "kilo" }))).toBe("Chat");
  expect(apiLabelForCall(call({ provider: "codex" }))).toBe("Responses");
  expect(apiLabelForCall(call({ provider: "openai" }))).toBe("Responses");
  expect(apiLabelForCall(call({ provider: "google" }))).toBe("Gemini");
  // A custom gateway's older row: Responses or Chat, it does not say.
  expect(apiLabelForCall(call({ provider: "openai-compatible" }))).toBe("");
  expect(apiLabelForCall(call({ apiMode: "decisions", metadata: { api: "responses" } }))).toBe("Decisions");
});

test("buildModelOptions: the log's model filter names the provider as Settings does", () => {
  const row = (id: string, provider: string, providerName: string | null, model: string) =>
    ({ id, provider, providerName, model }) as never;
  const options = buildModelOptions([
    row("a", "anthropic", "provider-1", "vendor/claude"),
    row("b", "openai-compatible", "kilo", "vendor/gpt"),
    row("c", "openai-compatible", "provider-1", "vendor/gpt"),
    row("d", "openai-compatible", null, "vendor/old")
  ], null, null);
  expect(options.map((o) => o.label)).toEqual([
    "Any model",
    "provider-1 / vendor/claude",
    "kilo / vendor/gpt",
    "provider-1 / vendor/gpt",
    "openai-compatible / vendor/old"
  ]);
});
