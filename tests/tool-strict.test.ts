import { expect, test } from "bun:test";
import { generateText, streamText } from "ai";
import { z } from "zod";
import { ToolRegistry } from "../src/server/modules/agent/tool-registry.js";
import { createAgentProvider } from "../src/server/modules/agent/llm-provider.js";
import { collectStream } from "../src/server/modules/agent/stream-collector.js";
import { mockFetch } from "./helpers/fetch.js";
import { codexEvents, codexSse, codexTestModel } from "./helpers/codex.js";

// Mandate's tools go out non-strict. The OpenAI Responses API
// turns a function tool that omits `strict` into a strict one where it can,
// and strict requires every property: the model had to fill memory_read's
// mutually exclusive id, project and scope, and the call kept failing.
// Every tool now says `strict: false`.

interface SentTool { type: string; name: string; strict?: boolean; parameters: { required?: string[] } }

function tools() {
  const registry = new ToolRegistry();
  registry.register({
    name: "memory_read",
    description: "Read one memory by id, a project's brief, or the user brief.",
    parameters: z.object({
      target: z.enum(["memory", "project", "user"]),
      id: z.string().nullable().optional(),
      project: z.string().nullable().optional()
    }),
    handler: async () => null
  });
  registry.register({
    name: "echo",
    description: "Echo the text.",
    parameters: z.object({ text: z.string() }),
    handler: async () => null
  });
  return registry.tools;
}

/** The tools an agent's request carries, caught before it leaves. */
async function sentTools(provider: "openai" | "openai-compatible"): Promise<SentTool[]> {
  let body: { tools?: SentTool[] } = {};
  mockFetch((call) => {
    body = JSON.parse(String(call.init?.body));
    return new Response("stop here", { status: 400 });
  });
  const { model } = createAgentProvider({ provider, model: "some-model", apiKey: "not-a-real-key", baseURL: "http://127.0.0.1:9/v1", reasoningEffort: "provider-default" });
  await generateText({ model, prompt: "hi", tools: tools(), maxRetries: 0 }).catch(() => {});
  return body.tools ?? [];
}

for (const provider of ["openai", "openai-compatible"] as const) {
  test(`every tool an ${provider} agent sends to the Responses API says strict: false, its optional parameters left optional`, async () => {
    const sent = await sentTools(provider);
    expect(sent.map((tool) => [tool.name, tool.strict])).toEqual([["memory_read", false], ["echo", false]]);
    expect(sent.find((tool) => tool.name === "memory_read")!.parameters.required ?? []).toEqual(["target"]);
  });
}

test("every tool a Codex agent sends says strict: false", async () => {
  let body: { tools?: SentTool[] } = {};
  const model = codexTestModel({
    async fetch(_input, init) {
      body = JSON.parse(String(init?.body));
      return codexSse(codexEvents({ id: "1", text: "ok" }));
    }
  });
  await collectStream(streamText({ model, prompt: "hi", tools: tools(), maxRetries: 0 }).fullStream);
  expect((body.tools ?? []).map((tool) => [tool.name, tool.strict])).toEqual([["memory_read", false], ["echo", false]]);
});
