import { expect, test } from "bun:test";
import { z } from "zod";
import type { ToolDefinition } from "../../src/server/modules/agent/tool-registry.js";
import {
  filterVoiceTools,
  toRealtimeFunctionSchema,
  VOICE_TOOL_WHITELIST,
  buildDispatchToManagerToolPlaceholder
} from "../../src/server/modules/voice/voice-tools.js";

const fakeManagerTools: ToolDefinition[] = [
  { name: "list_projects", description: "List", parameters: z.object({}), approval: "never", handler: async () => ({}) },
  { name: "list_features", description: "List features", parameters: z.object({}), approval: "never", handler: async () => ({}) },
  { name: "get_feature_status", description: "Status", parameters: z.object({ id: z.string() }), approval: "never", handler: async () => ({}) },
  { name: "read_feature_thread", description: "Read", parameters: z.object({ id: z.string(), limit: z.number().optional() }), approval: "never", handler: async () => ({}) },
  { name: "ui_navigate", description: "Nav", parameters: z.object({ to: z.string() }), approval: "never", handler: async () => ({}) },
  { name: "ui_open_url", description: "Open", parameters: z.object({ url: z.string() }), approval: "never", handler: async () => ({}) },
  { name: "ui_read_page_summary", description: "Page", parameters: z.object({}), approval: "never", handler: async () => ({}) },
  { name: "feature_task_send", description: "Send task", parameters: z.object({ feature: z.string(), message: z.string() }), approval: "never", handler: async () => ({}) },
  { name: "chat_history_search", description: "History", parameters: z.object({ query: z.string() }), approval: "never", handler: async () => ({}) },
  { name: "chat_history_read", description: "History read", parameters: z.object({ handle: z.string() }), approval: "never", handler: async () => ({}) },
  { name: "bash", description: "Run", parameters: z.object({ cmd: z.string() }), approval: "always", handler: async () => ({}) },
  { name: "edit", description: "Edit", parameters: z.object({ path: z.string() }), approval: "always", handler: async () => ({}) }
];

test("filterVoiceTools: keeps only whitelisted names", () => {
  const filtered = filterVoiceTools(fakeManagerTools);
  const names = filtered.map((t) => t.name).sort();
  expect(names).toEqual([
    "feature_task_send", "get_feature_status",
    "list_features", "list_projects", "read_feature_thread",
    "ui_navigate", "ui_open_url", "ui_read_page_summary"
  ]);
  expect(names).not.toContain("bash");
  expect(names).not.toContain("edit");
  expect(names).not.toContain("chat_history_search");
  expect(names).not.toContain("chat_history_read");
});

test("VOICE_TOOL_WHITELIST contains the reused manager tool names", () => {
  expect(VOICE_TOOL_WHITELIST.size).toBe(10);
  expect(VOICE_TOOL_WHITELIST.has("feature_task_send")).toBe(true);
  expect(VOICE_TOOL_WHITELIST.has("ui_navigate")).toBe(true);
  expect(VOICE_TOOL_WHITELIST.has("ui_read_page_summary")).toBe(true);
  expect(VOICE_TOOL_WHITELIST.has("skill")).toBe(true);
  expect(VOICE_TOOL_WHITELIST.has("read_skill_reference")).toBe(true);
  expect(VOICE_TOOL_WHITELIST.has("feature_session_start")).toBe(false);
  expect(VOICE_TOOL_WHITELIST.has("chat_history_search")).toBe(false);
  expect(VOICE_TOOL_WHITELIST.has("chat_history_read")).toBe(false);
});

test("toRealtimeFunctionSchema: translates ToolDefinition to OpenAI function schema", () => {
  const def: ToolDefinition = {
    name: "list_features",
    description: "List features in a project",
    parameters: z.object({ projectId: z.string().describe("The project ID") }),
    approval: "never",
    handler: async () => ({})
  };
  const schema = toRealtimeFunctionSchema(def);
  expect(schema.type).toBe("function");
  expect(schema.name).toBe("list_features");
  expect(schema.description).toBe("List features in a project");
  expect(schema.parameters.type).toBe("object");
  expect(schema.parameters.properties.projectId.type).toBe("string");
  expect(schema.parameters.required).toContain("projectId");
});

test("buildDispatchToManagerToolPlaceholder: returns def with query param", () => {
  const def = buildDispatchToManagerToolPlaceholder();
  expect(def.name).toBe("dispatch_to_manager");
  const parsed = def.parameters.safeParse({ query: "what's running" });
  expect(parsed.success).toBe(true);
  const empty = def.parameters.safeParse({});
  expect(empty.success).toBe(false);
});
