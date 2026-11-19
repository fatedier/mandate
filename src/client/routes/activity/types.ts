export type {
  LlmCallDetailDto as ActivityCallDetail,
  LlmCallDetailResponse as ActivityCallDetailResponse,
  LlmCallSummaryDto as ActivityCall,
  LlmCallsResponse as ActivityCallsResponse,
  LlmCallsResponse as ActivityResponse
} from "@shared/api-contracts";

/** The status values the log filter offers. Lives here rather than beside
 *  the filter row so a hook and a page summary can name it without importing
 *  a component. */
export type StatusFilter = "all" | "succeeded" | "failed" | "running";
