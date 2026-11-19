import { expect, test } from "bun:test";
import { z } from "zod";
import type { ToolDefinition } from "../src/server/modules/agent/tool-registry.js";
import { reviewLookupTools } from "../src/server/modules/skills/skill-review-tools.js";
import { searchParams } from "../src/server/modules/memory/tools/memory-schema.js";

const tool = (name: string, parameters: z.ZodTypeAny, seen: unknown[] = []): ToolDefinition =>
  ({ name, description: name, parameters, handler: async (args: unknown) => { seen.push(args); return { ok: true }; } }) as unknown as ToolDefinition;

test("the review searches the user's preferences in every project: no project to narrow it to, and one passed anyway is dropped", async () => {
  const seen: unknown[] = [];
  const tools = reviewLookupTools({
    memoryTools: [tool("memory_search", searchParams, seen), tool("memory_read", z.object({}))],
    historyTools: []
  });
  const search = tools.find((t) => t.name === "memory_search")!;
  expect(Object.keys((search.parameters as z.ZodObject<z.ZodRawShape>).shape)).not.toContain("project");
  await search.handler({ query: "a step", project: "another" } as never, {} as never);
  expect(seen).toEqual([{ query: "a step" }]);
});

test("the review reads memories and the chat history, and nothing that writes", () => {
  const names = reviewLookupTools({
    memoryTools: ["memory_search", "memory_read", "memory_remember", "memory_forget"].map((n) => tool(n, n === "memory_search" ? searchParams : z.object({}))),
    historyTools: ["chat_history_search", "chat_history_read"].map((n) => tool(n, z.object({})))
  }).map((t) => t.name);
  expect(names.sort()).toEqual(["chat_history_read", "chat_history_search", "memory_read", "memory_search"]);
});
