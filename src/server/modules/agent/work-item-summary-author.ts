import type { ToolContext } from "./tool-registry.js";
import type { WorkItemSummaryAuthor } from "./work-item-store.js";

/** Writer identity for `work_items.summary`, read off the calling tool's own
 *  scope rather than off which tool was called. Both `update_my_work_item`
 *  and `update_work_item` funnel into the same column, and the pane used to
 *  label every write "feature agent" — a hardcoded guess that was simply
 *  wrong whenever the manager rewrote the text. The scope is the one identity
 *  the runtime already establishes per tool call and cannot be spoofed by
 *  arguments.
 *
 *  `registeredAs` is the scope the calling tool is registered under, which is
 *  a fixed fact about the tool: `update_my_work_item` exists only in the
 *  worker pack, `update_work_item` only in the manager pack. It answers for
 *  callers that dispatch a handler without a full context. Attribution is
 *  never the reason a status write fails.  */
export function summaryAuthorForScope(
  ctx: Pick<ToolContext, "scope">,
  registeredAs: WorkItemSummaryAuthor
): WorkItemSummaryAuthor {
  switch (ctx.scope?.kind) {
    case "manager": return "manager";
    case "worker": return "worker";
    default: return registeredAs;
  }
}
