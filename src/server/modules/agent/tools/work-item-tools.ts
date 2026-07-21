import { z } from "zod";
import type { ToolDefinition, ToolContext } from "../tool-registry.js";
import type { WorkItemStore } from "../work-item-store.js";
import { WORK_ITEM_NEEDS_USER_VALUES, WORK_ITEM_SUMMARY_MAX_CHARS } from "../work-item-store.js";
import { summaryAuthorForScope } from "../work-item-summary-author.js";
import type { AgentSseEmitter } from "../../sse/sse-events.js";
import { SSE_EVENTS } from "../../../../shared/api/sse.js";
import { toWorkItemDto } from "../work-item-dto.js";

const WORK_ITEM_NEEDS_USER_ENUM = [...WORK_ITEM_NEEDS_USER_VALUES] as [string, ...string[]];

const updateParams = z.object({
  id: z.string(),
  patch: z.object({
    title: z.string().optional(),
    summary: z.string().max(WORK_ITEM_SUMMARY_MAX_CHARS).nullable().optional(),
    needsUser: z.enum(WORK_ITEM_NEEDS_USER_ENUM).nullable().optional()
  }).strict()
});

const dismissParams = z.object({
  id: z.string(),
  reason: z.string().optional()
});

export interface WorkItemToolDeps {
  workStore: WorkItemStore;
  sse: AgentSseEmitter;
}

export function buildWorkItemTools(deps: WorkItemToolDeps): Array<ToolDefinition<unknown, unknown>> {
  return [buildUpdateTool(deps), buildDismissTool(deps)];
}

function buildUpdateTool(deps: WorkItemToolDeps): ToolDefinition<z.infer<typeof updateParams>, { ok?: boolean; error?: string }> {
  return {
    name: "update_work_item",
    description:
      "Triage an existing work item: set needsUser (null | review | input), " +
      "or reword title/summary into clearer user-facing terms. " +
      "summary is the user's short read on where the feature stands — at " +
      "most 3 short lines. Rewrite it only when the worker's wording " +
      "is genuinely unclear to a user; it is not a place to leave notes for " +
      "another agent (workers hand off through their feature digest), " +
      "and it must not restate phase/phaseDetail. Your rewrite is recorded " +
      "as yours, so the user sees that the manager, not the worker, " +
      "wrote what they are reading. " +
      "Do not set phase/phaseDetail — those belong to the worker.",
    parameters: updateParams,
    approval: "never",
    handler: async (input, ctx: ToolContext) => {
      const next = deps.workStore.update(input.id, {
        title: input.patch.title,
        summary: input.patch.summary,
        summaryBy: summaryAuthorForScope(ctx, "manager"),
        needsUser: input.patch.needsUser as import("../work-item-store.js").WorkItemNeedsUser | undefined
      });
      if (!next) return { error: `work_item not found: ${input.id}` };
      deps.sse.emit(SSE_EVENTS.workItemUpdated, { item: toWorkItemDto(next) });
      return { ok: true };
    }
  };
}

function buildDismissTool(deps: WorkItemToolDeps): ToolDefinition<z.infer<typeof dismissParams>, { ok?: boolean; error?: string }> {
  return {
    name: "dismiss_work_item",
    description:
      "Clear the needsUser flag (set to null) when a work item no longer needs user attention — " +
      "e.g., a review request that was addressed. Cleaner than calling update_work_item with needsUser=null.",
    parameters: dismissParams,
    approval: "never",
    handler: async (input, _ctx: ToolContext) => {
      const next = deps.workStore.update(input.id, { needsUser: null });
      if (!next) return { error: `work_item not found: ${input.id}` };
      deps.sse.emit(SSE_EVENTS.workItemUpdated, { item: toWorkItemDto(next) });
      return { ok: true };
    }
  };
}
