import type { z } from "zod";
import type { ToolDefinition } from "../agent/tool-registry.js";
import type { SkillRegistry } from "./skill-registry.js";
import { params } from "./request-skill-review-tool-schema.js";

export const REQUEST_SKILL_REVIEW_TOOL_NAME = "request_skill_review";
const REQUESTED = "Requested. The user will be told if a skill is written or changed.";

/**
 * `request_skill_review`, for the personal agent and managers: queue a
 * background review of a conversation's finished work, which may write a
 * new skill or improve one from its whole record. It returns at once; a
 * second request for the same conversation joins the queued one.
 */
export function buildRequestSkillReviewTool(registry: SkillRegistry): ToolDefinition<z.infer<typeof params>, string | { error: string }> {
  return {
    name: REQUEST_SKILL_REVIEW_TOOL_NAME,
    description: "Request a background review of a conversation's finished work, to write a new skill or improve one from its whole record. Returns at once; the user is told if a skill is written or changed.",
    parameters: params,
    handler: async (args, ctx) => {
      const source = registry.learnedSource;
      const target = source?.reviewTarget?.(ctx.threadId, args.thread);
      if (!source || !target) return { error: `There is no conversation ${args.thread?.trim() || ctx.threadId} you can ask a review of.` };
      source.store.requestReview({ threadId: target.threadId, requestedBy: ctx.threadId, focus: args.focus.trim(), fromSeq: target.fromSeq, toSeq: target.toSeq });
      source.reviewRequested?.();
      return REQUESTED;
    }
  };
}
