import { z } from "zod";
import type { ToolContext, ToolDefinition } from "../tool-registry.js";
import type { WorkItemStore } from "../work-item-store.js";
import {
  WORK_ITEM_PHASES,
  WORK_ITEM_SUMMARY_MAX_CHARS,
  type UpdateWorkItemPatch,
  type WorkItemPhase
} from "../work-item-store.js";
import { summaryAuthorForScope } from "../work-item-summary-author.js";
import type { AgentSseEmitter } from "../../sse/sse-events.js";
import { SSE_EVENTS } from "../../../../shared/api/sse.js";
import { toWorkItemDto } from "../work-item-dto.js";

const params = z.object({
  phase: z.enum(WORK_ITEM_PHASES as unknown as [WorkItemPhase, ...WorkItemPhase[]]).optional(),
  phaseDetail: z.string().nullable().optional(),
  summary: z.string().max(WORK_ITEM_SUMMARY_MAX_CHARS).nullable().optional(),
  title: z.string().min(1).optional()
  // needsUser omitted by design — only the manager/user can request attention.
  // The worker expresses completion via phase='done' + summary; the
  // server uses that as the review prompt signal.
})
.strict()
.refine(
  (v) => v.phase !== undefined || v.phaseDetail !== undefined ||
         v.summary !== undefined || v.title !== undefined,
  { message: "at least one field is required" }
);

export interface FeatureWorkItemToolDeps {
  workStore: WorkItemStore;
  sse: AgentSseEmitter;
  /** Resolve the feature_id this thread is scoped to. Return null if not feature-scoped. */
  resolveFeatureId: (ctx: ToolContext) => string | null;
}

export function buildFeatureWorkItemTool(
  deps: FeatureWorkItemToolDeps
): ToolDefinition<z.infer<typeof params>, { ok?: boolean; error?: string }> {
  return {
    name: "update_my_work_item",
    description:
      "Update the work item bound 1:1 to your feature. Use to advance phase, " +
      "write a short phaseDetail describing what you're doing, set a clearer " +
      "title, or replace the summary. " +
      "summary is written FOR THE USER and read only by the user: it says " +
      "where the feature stands right now — the current conclusion, decision " +
      "or result — in at most 3 short lines, hard-capped at 500 chars. " +
      "It is NOT shared state between agents (use update_feature_digest for " +
      "the manager handoff), NOT a changelog, and NOT a restatement of " +
      "phase or phaseDetail — if the only thing you would write is what " +
      "phaseDetail already says, leave summary alone. Rewrite it when the " +
      "conclusion changes, not on every step; details belong in the canvas " +
      "and the chat. Rendered as inline markdown — `**bold**`, `` `code` ``, " +
      "and explicit `[text](url)` links work; bare URLs are NOT auto-linked, " +
      "so wrap URLs you want clickable. " +
      "You CANNOT set needsUser directly. When the work for the current ask " +
      "is done, set phase='done' and a summary describing the result; the " +
      "server will flag the work_item as 'review' so the user can verify.",
    parameters: params,
    approval: "never",
    handler: async (input, ctx) => {
      const featureId = deps.resolveFeatureId(ctx);
      if (!featureId) return { error: "this thread is not scoped to a feature" };
      const cur = deps.workStore.getByFeature(featureId);
      if (!cur) return { error: `no work_item bound to feature ${featureId}` };
      const patch: UpdateWorkItemPatch = {
        phase: input.phase,
        phaseDetail: input.phaseDetail,
        summary: input.summary,
        summaryBy: summaryAuthorForScope(ctx, "worker"),
        title: input.title,
        needsUser: input.phase === "done" && cur.needsUser === null ? "review" : undefined
      };
      const next = deps.workStore.update(cur.id, patch);
      if (!next) return { error: "update failed" };
      deps.sse.emit(SSE_EVENTS.workItemUpdated, { item: toWorkItemDto(next) });
      return { ok: true };
    }
  };
}
