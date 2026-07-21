import { z } from "zod";
import type { ToolDefinition } from "../agent/tool-registry.js";

/** The manager tools the voice agent reuses directly. dispatch_to_manager
 *  is built by this module — see buildDispatchToManagerToolPlaceholder.
 *  skill + read_skill_reference are included so voice can load the
 *  ui-routes skill (and any future manager-scoped skills) — without them
 *  ui_navigate fires URLs constructed from the wrong fields (e.g. project
 *  id instead of tmuxSessionName slug).
 *
 *  Voice gets feature_task_send so delegated feature work lands in the
 *  feature's main conversation and task queue. */
export const VOICE_TOOL_WHITELIST = new Set<string>([
  "list_projects",
  "list_features",
  "get_feature_status",
  "read_feature_thread",
  "ui_navigate",
  "ui_open_url",
  "ui_read_page_summary",
  "feature_task_send",
  "skill",
  "read_skill_reference"
]);

export function filterVoiceTools(managerTools: ToolDefinition[]): ToolDefinition[] {
  return managerTools.filter((t) => VOICE_TOOL_WHITELIST.has(t.name));
}

export interface RealtimeFunctionSchema {
  type: "function";
  name: string;
  description: string;
  parameters: unknown; // JSON Schema object
}

/** Translate a Mandate ToolDefinition into the OpenAI Realtime function
 *  schema format. Uses zod's built-in JSON-schema emit (z.toJSONSchema). */
export function toRealtimeFunctionSchema(def: ToolDefinition): RealtimeFunctionSchema {
  const jsonSchema = z.toJSONSchema(def.parameters);
  return {
    type: "function",
    name: def.name,
    description: def.description,
    parameters: jsonSchema
  };
}

const dispatchManagerParams = z.object({
  query: z.string().min(1).describe(
    "The user's request, summarized in your own words. Will be appended to the manager thread as a user message and the manager will respond."
  )
});

/** A placeholder ToolDefinition for `dispatch_to_manager`. The handler is
 *  a stub — the orchestrator (Task 6) intercepts this tool by name BEFORE
 *  reaching the dispatcher and runs the async wake flow itself. */
export function buildDispatchToManagerToolPlaceholder(): ToolDefinition<
  z.infer<typeof dispatchManagerParams>,
  { status: "started" }
> {
  return {
    name: "dispatch_to_manager",
    description:
      "Use whenever the user's request goes beyond your direct read tools " +
      "(list_*, get_feature_status, read_feature_thread). This includes " +
      "creating or archiving projects/features, running shell commands, " +
      "editing files, or anything that changes state. The manager " +
      "will run the work and reply. Returns immediately with " +
      "status='started'; the final answer is delivered as a follow-up message.",
    parameters: dispatchManagerParams,
    approval: "never",
    handler: async () => ({ status: "started" as const })
  };
}
