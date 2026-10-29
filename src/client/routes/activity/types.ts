export type {
  LlmCallDetailDto as ActivityCallDetail,
  LlmCallDetailResponse as ActivityCallDetailResponse,
  LlmCallSummaryDto as ActivityCall,
  LlmCallsResponse as ActivityCallsResponse,
  LlmCallsResponse as ActivityResponse
} from "@shared/api-contracts";

/** The status values the log filter offers. Narrower than the column the rows
 *  carry: `pending` is a real status the store writes, and one the filter has
 *  no control for — a link that put it in the URL would silently read back as
 *  "all". Lives here rather than beside the filter row so a hook and a page
 *  summary can name it without importing a component. */
export type StatusFilter = "all" | "succeeded" | "failed" | "running";
